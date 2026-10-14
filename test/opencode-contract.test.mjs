import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createConversationRunner } from "../src/app.mjs";
import { cleanChildEnvironment, createOpenCodeExecutor, startSocketOpenCodeServer } from "../src/opencode.mjs";
import { acquireInstanceLock, createSessionStore, pipaPaths } from "../src/state.mjs";
import { bounded, createRuntimeFixture, waitFor } from "./helpers/runtime-fixture.mjs";
import { assertPromptReceipt, assertSupersessionOutcome, assertTurnOutcome, createWireFixture, loadWireFixture, runTurnContract, validateEventStream } from "./helpers/opencode-contract.mjs";
import { abruptTurnProbe, assertNativeAdmissionCount, isNativeAdmission, releaseCases } from "../scripts/verification/opencode-release-cases.mjs";

test("release admission self-check: forbidden native v2 text and duplicate v1/v2 admissions fail", () => {
  const prompt = "exact café\n";
  const v1 = { path: "/session/ses_native/prompt_async", body: { parts: [{ type: "file" }, { type: "text", text: prompt }] } };
  const v2 = { path: "/api/session/ses_native/prompt", body: { text: prompt } };
  const unrelated = [{ path: "/api/session/ses_native/instruction", body: { text: prompt } }, { ...v2, body: { text: prompt.trim() } }];
  assertNativeAdmissionCount(unrelated, prompt, 0);
  for (const admission of [v1, v2]) {
    assert.equal(isNativeAdmission(admission, prompt), true);
    assertNativeAdmissionCount([admission, ...unrelated], prompt, 1);
    assert.throws(() => assertNativeAdmissionCount([admission], prompt, 0), /Native admission count/u);
    assert.throws(() => assertNativeAdmissionCount([admission, admission], prompt, 1), /Native admission count/u);
  }
  assert.throws(() => assertNativeAdmissionCount([v1, v2], prompt, 1), /Native admission count/u);
});

test("release catalog keeps four crash boundaries and separate unqualified model/Slack proofs", async () => {
  const ids = releaseCases.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["crash-after-instruction-registration", "crash-after-admission", "crash-during-approval", "crash-after-completion"]) {
    assert.equal(releaseCases.find((row) => row.id === id)?.owner, "U2/U6");
  }
  for (const id of ["models-variants", "models-default", "models-reset", "slack-editable-retry-controls"]) assert.ok(releaseCases.find((row) => row.id === id)?.blocked);
  const workflow = await readFile(new URL("../.github/workflows/opencode-compatibility.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes('- "test/opencode-contract.test.mjs"'));
});

for (const boundary of ["admission", "approval", "completion"]) test(`release crash self-check: SIGKILL at ${boundary} through production runner/native HTTP fixture (not engine recovery proof)`, async (t) => {
  const runtime = await createRuntimeFixture({ timeoutMs: 25000 });
  t.after(() => runtime.teardown());
  const document = await loadWireFixture("v1", runtime);
  const admission = Promise.withResolvers();
  if (boundary === "approval") {
    document.routes.find((route) => route.path === "/session/status").responses = [{ json: { ses_contract: { type: "busy" } } }];
    const messages = document.routes.find((route) => route.path.endsWith("/message"));
    messages.responses = [messages.responses[0]];
  }
  if (boundary === "completion") document.routes.find((route) => route.path.endsWith("/message")).responses.shift();
  const wire = createWireFixture(document);
  const serverErrors = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.url.startsWith("/event?")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
        await admission.promise;
        // A pending approval can only appear after actual prompt acceptance.
        if (boundary === "approval") response.write(document.routes.find((route) => route.path === "/event").responses[0].sse.split("\n\n")[0] + "\n\n");
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const result = await wire.fetch(`http://127.0.0.1${request.url}`, { method: request.method, ...(body ? { body } : {}) });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
      if (request.url.includes("/prompt_async?")) admission.resolve();
    } catch (error) { serverErrors.push(error); response.writeHead(500); response.end(); }
  });
  const baseUrl = await runtime.listen(server);
  const evidence = await abruptTurnProbe({ runtime, candidate: fileURLToPath(new URL("..", import.meta.url)), baseUrl, boundary, prompt: document.prompt, sessionFile: path.join(runtime.state, "crash-sessions.json") });
  assert.equal(evidence.boundary, boundary);
  assert.equal(evidence.sessionId, document.expected.sessionId);
  assert.equal(evidence.deliveryObserved, false);
  if (boundary === "completion") assertTurnOutcome(evidence.result, document.expected);
  if (boundary === "approval") assert.equal(evidence.requestId, "que_contract");
  assertNativeAdmissionCount(wire.calls, document.prompt, 1);
  assert.deepEqual(serverErrors, []);
  wire.assertComplete();
});

async function fixture(t, generation = "v1", options = {}) {
  const runtime = await createRuntimeFixture({ timeoutMs: 10_000 });
  t.after(() => runtime.teardown());
  const document = await loadWireFixture(generation, runtime);
  const wire = createWireFixture(document, options);
  const executor = createOpenCodeExecutor({ baseUrl: "http://127.0.0.1:4096", fetch: wire.fetch, environment: runtime.env, artifactRoot: runtime.artifactRoot, pollIntervalMs: 1 });
  runtime.defer(() => executor.stopAll(), "executor");
  const input = { prompt: document.prompt, sessionId: document.expected.sessionId, workingDirectory: runtime.workspace, signal: runtime.signal };
  return { runtime, document, wire, executor, input };
}

test("v1 baseline: exact prompt, trusted context and persisted-session continuation", async (t) => {
  const current = await fixture(t);
  const { runtime, document, wire, executor, input } = current;
  const store = await createSessionStore(pipaPaths(runtime.home).sessions);
  await store.set("slack:C1:1.0", document.expected.sessionId);
  const runner = createConversationRunner({ sessionStore: store, runTurn: executor.runTurn, abortTurn: executor.abortTurn });
  runtime.defer(async () => { runner.close(); await runner.drain(); }, "runner");
  const delivered = [];
  const context = { PIPA_MESSAGE_CHANNEL: "slack", PIPA_CURRENT_SLACK_CHANNEL_ID: "C1", PIPA_CURRENT_SLACK_THREAD_TS: "1.0" };
  const first = await runner.enqueue("slack:C1:1.0", { ...input, contextEnvironment: context, deliver: (result) => delivered.push(result.text) });
  assertTurnOutcome(first, document.expected, "v1 completion");
  const admission = wire.calls.find((call) => call.path.endsWith("/prompt_async"));
  const contextLines = admission.body.system.split("\n").filter((line) => line.startsWith("PIPA_") && line.includes("="));
  assertPromptReceipt({ prompt: admission.body.parts[0].text, context: Object.fromEntries(contextLines.map((line) => line.split("="))) }, { prompt: document.prompt, context }, "v1 context");
  assert.match(admission.body.system, /pipa routine --help/u);
  assert.match(admission.body.system, /pipa restart --channel C1 --thread 1\.0/u);
  assert.doesNotMatch(admission.body.parts[0].text, /PIPA_CURRENT/u);
  const continued = await runner.enqueue("slack:C1:1.0", { ...input, prompt: "continue", deliver: (result) => delivered.push(result.text) });
  assertTurnOutcome(continued, document.continuation, "v1 continuation");
  assert.deepEqual(delivered, ["contract complete", "history retained"]);
  assert.equal((await createSessionStore(pipaPaths(runtime.home).sessions)).get("slack:C1:1.0"), document.expected.sessionId);
  assert.equal(wire.calls.filter((call) => call.path === "/session").length, 0, "continuation must not replace the mapped session");
  assert.doesNotMatch(wire.calls.filter((call) => call.path.endsWith("/prompt_async"))[1].body.system, /PIPA_CURRENT_SLACK_CHANNEL_ID=C1/u);
  wire.assertComplete();
});

test("v1 baseline: subscription, duplicate question suppression and linked child permission", async (t) => {
  const replied = new Set();
  const current = await fixture(t, "v1", { onRequest: async (call) => {
    if (call.path.endsWith("/reply")) replied.add(call.path);
    if (call.path.endsWith("/prompt_async")) await waitFor(() => replied.size === 2, { label: "interaction replies" });
  } });
  const { document, wire, executor, input } = current;
  for (const route of document.routes) if (route.path.endsWith("/reply") || route.path === "/event") route.required = true;
  const seen = [];
  await runTurnContract({ executor, input: { ...input, onInteraction: (interaction) => {
    seen.push({ type: interaction.type, sessionId: interaction.sessionId, id: interaction.request.id });
    return interaction.type === "question" ? { type: "answer", answers: [["Blue"]] } : { type: "reply", reply: "once" };
  } }, expected: document.expected, caseName: "v1 question/child permission" });
  assert.deepEqual(seen, [
    { type: "question", sessionId: "ses_contract", id: "que_contract" },
    { type: "permission", sessionId: "ses_child", id: "per_contract" },
  ]);
  assert.ok(wire.calls.findIndex((call) => call.path === "/event") < wire.calls.findIndex((call) => call.path.endsWith("/prompt_async")));
  wire.assertComplete();
});

test("v1 baseline: real executor supersession aborts only the replaced thread", async (t) => {
  const admitted = Promise.withResolvers();
  const current = await fixture(t, "v1", { onRequest: async (call, init) => {
    if (call.body?.parts?.[0]?.text !== "blocked old turn") return;
    admitted.resolve();
    await bounded(new Promise((_, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }), { signal: init.signal, label: "superseded admission" });
  } });
  const { runtime, document, executor, input, wire } = current;
  const other = await loadWireFixture("v1", runtime);
  for (const route of other.routes.filter((route) => route.path.startsWith("/session/ses_contract/"))) {
    route.path = route.path.replace("ses_contract", "ses_independent");
    document.routes.push(route);
  }
  const store = await createSessionStore(pipaPaths(runtime.home).sessions);
  await store.set("A", "ses_contract");
  await store.set("B", "ses_independent");
  const runner = createConversationRunner({ sessionStore: store, runTurn: executor.runTurn, abortTurn: executor.abortTurn });
  runtime.defer(async () => { runner.close(); await runner.drain(); }, "runner");
  const delivered = [];
  const previous = runner.enqueue("A", { ...input, prompt: "blocked old turn", deliver: () => delivered.push("stale") });
  await bounded(admitted.promise, { signal: runtime.signal, label: "first admission" });
  const independent = await runner.enqueue("B", { ...input, deliver: () => delivered.push("independent") });
  assert.equal(runtime.signal.aborted, false);
  const latest = await runner.enqueue("A", { ...input, prompt: "replacement", deliver: () => delivered.push("latest") });
  assertSupersessionOutcome({ previous: await previous, latest, independent, delivered }, {
    latest: document.continuation,
    independent: { ...document.expected, sessionId: "ses_independent" },
    delivered: ["independent", "latest"],
  });
  assert.deepEqual(wire.calls.filter((call) => call.path.endsWith("/abort")).map((call) => call.path), ["/session/ses_contract/abort"]);
  assert.equal(store.get("A"), "ses_contract");
  assert.equal(store.get("B"), "ses_independent");
  wire.assertComplete();
});

for (const generation of ["v1", "v2"]) test(`${generation}: malformed/truncated wire events and unknown routes fail closed`, async (t) => {
  const { document, wire, runtime } = await fixture(t, generation);
  const sse = document.routes.find((route) => route.responses[0].sse)?.responses[0].sse;
  validateEventStream(sse, generation);
  for (const [mutation, message] of [[sse.slice(0, -1), /truncated SSE/u], ["data: {broken}\n\n", /malformed SSE JSON/u], ["data: {}\n\n", /malformed event envelope/u]]) {
    assert.throws(() => validateEventStream(mutation, generation), message);
    const broken = structuredClone(document);
    const route = broken.routes.find((route) => route.responses[0].sse);
    route.responses[0].sse = mutation;
    const playback = createWireFixture(broken);
    const url = new URL(route.path, "http://127.0.0.1");
    for (const [key, value] of Object.entries(route.query ?? {})) url.searchParams.set(key, value);
    await assert.rejects(playback.fetch(url), message);
    assert.throws(() => playback.assertComplete(), /wire contract failed/u);
  }
  await assert.rejects(wire.fetch(`http://127.0.0.1/unknown?directory=${encodeURIComponent(runtime.workspace)}`), /unknown wire request/u);
  assert.throws(() => wire.assertComplete(), /unknown wire request/u);
});

test("v1 failing-proof: mutated expected text, session and artifact bytes fail named outcomes", async (t) => {
  const { executor, input, document, wire } = await fixture(t);
  const result = await runTurnContract({ executor, input, expected: document.expected, caseName: "v1 completion" });
  for (const expected of [
    { ...document.expected, text: "wrong output" },
    { ...document.expected, sessionId: "wrong session" },
    { ...document.expected, files: [{ filename: "report.txt", base64: "d3Jvbmc=" }] },
  ]) assert.throws(() => assertTurnOutcome(result, expected, "mutated outcome"), /mutated outcome/u);
  wire.assertComplete();
});

for (const failure of ["malformed response", "malformed envelope", "provider failure"]) test(`v1 ${failure === "malformed envelope" ? "wire validation" : "baseline"}: ${failure} cannot deliver success`, async (t) => {
  const { executor, input, document, wire } = await fixture(t);
  const messages = document.routes.find((route) => route.path.endsWith("/message"));
  messages.responses[1] = failure === "malformed response" ? { raw: "{truncated" }
    : failure === "malformed envelope" ? { json: { data: [] } }
    : { json: [{ info: { id: "msg_failed", role: "assistant", error: { name: "APIError" } }, parts: [{ type: "text", text: "must not deliver" }] }] };
  await assert.rejects(runTurnContract({ executor, input, expected: document.expected, caseName: failure }), failure === "malformed response" ? /malformed response: OpenCode returned an invalid response/u
    : failure === "malformed envelope" ? /malformed envelope:/u
    : /provider failure: OpenCode failed to complete/u);
  if (failure === "malformed envelope") assert.throws(() => wire.assertComplete(), /malformed message envelope/u);
  else wire.assertComplete();
});

test("v1 baseline FAIL observation: production ignores a malformed projected envelope before a valid later poll", async (t) => {
  const { executor, input, document, wire } = await fixture(t);
  document.routes.find((route) => route.path.endsWith("/message")).responses[1] = { raw: '{"data":[]}' };
  await runTurnContract({ executor, input, expected: document.expected, caseName: "v1 malformed envelope recovery observation" });
  wire.assertComplete();
  t.diagnostic("Malformed-envelope rejection FAIL in current production: non-array message envelope was silently ignored. Structured fixture JSON rejects this; raw wire injection records the existing behavior without changing src.");
});

test("v2 native wire integrity: data envelopes, stable-ID admission, projected idle and keyed replies (not adapter proof)", async (t) => {
  const runtime = await createRuntimeFixture();
  t.after(() => runtime.teardown());
  const document = await loadWireFixture("v2", runtime);
  const wire = createWireFixture(document);
  const request = async (route) => {
    const url = new URL(route.path, "http://127.0.0.1");
    for (const [key, value] of Object.entries(route.query ?? {})) url.searchParams.set(key, value);
    return wire.fetch(url, { method: route.method, ...(route.body ? { body: JSON.stringify(route.body) } : {}) });
  };
  const create = await (await request(document.routes.find((route) => route.path === "/api/session"))).json();
  assert.equal(create.data.location.directory, runtime.workspace);
  const admitted = await (await request(document.routes.find((route) => route.path.endsWith("/prompt")))).json();
  assert.equal(admitted.data.id, "msg_input");
  assert.equal(admitted.data.payload.text, document.prompt);
  assert.equal(admitted.data.type, "user", "admission is not a completed assistant result");
  const projected = await (await request(document.routes.find((route) => route.path.endsWith("/message")))).json();
  assert.equal(projected.data.at(-1).type, "idle");
  assert.equal(projected.data.at(-1).outcome, "succeeded");
  assert.deepEqual(projected.cursor, { previous: null, next: null });
  for (const route of document.routes.filter((route) => route.path.endsWith("/reply"))) assert.equal((await request(route)).status, 204);
  wire.assertComplete();
  const broken = createWireFixture(document);
  await assert.rejects(broken.fetch("http://127.0.0.1/api/session/ses_contract/form/frm_contract/reply", { method: "POST", body: JSON.stringify({ answers: [["Blue"]] }) }), /native body/u);
  assert.throws(() => broken.assertComplete(), /wire contract failed/u);
  const windows = await loadWireFixture("v2", { workspace: "C:\\private\\workspace", temp: "C:\\private\\temp" });
  validateEventStream(windows.routes.find((route) => route.path === "/api/event").responses[0].sse, "v2");
});

for (const sessionId of [null, "ses_contract"]) test(`v2 baseline FAIL observation: ${sessionId ? "R2 continuation rejects legacy HTML" : "R1/R14 new turn uses unsupported v1 admission"}`, async (t) => {
  const { executor, input, document, wire } = await fixture(t, "v2");
  const caseName = sessionId ? "v2 session continuation" : "v2 prompt completion";
  await assert.rejects(runTurnContract({ executor, input: { ...input, sessionId }, expected: document.expected, caseName }), sessionId ? /v2 session continuation: OpenCode returned an invalid response/u : /v2 prompt completion: OpenCode request failed with status 405/u);
  assert.equal(wire.calls.some((call) => call.path.startsWith("/api/")), false);
  wire.assertComplete();
  t.diagnostic(`Compatibility FAIL (expected pre-port observation): ${caseName}; no v2 adapter selected. This passing characterization is not a compatibility pass.`);
});

test("R1 U1: attached identity and workspace readiness select both generations", async (t) => {
  for (const generation of ["v1", "v2"]) {
    const { runtime, wire } = await fixture(t, generation);
    const starting = startSocketOpenCodeServer({ workingDirectory: runtime.workspace }, { environment: { ...runtime.env, PIPA_OPENCODE_ATTACH_URL: "http://127.0.0.1:4096" }, fetch: wire.fetch, startupTimeoutMs: 10 });
    const server = await starting;
    assert.equal(server.owned, false);
    assert.equal(server.connection.major, generation === "v1" ? 1 : 2);
    assert.equal(server.connection.version, generation === "v1" ? "1.19.0" : "2.0.29");
    server.stop();
    await server.wait();
    assert.equal(wire.calls.some((call) => call.path === "/api/info"), generation === "v2");
    wire.assertComplete();
  }
});

test("isolated concurrent roots: abort closes process trees, listeners, locks and staging", async (t) => {
  const runtimes = await Promise.all([createRuntimeFixture(), createRuntimeFixture()]);
  for (const runtime of runtimes) t.after(() => runtime.teardown());
  const [first, second] = runtimes;
  assert.notEqual(first.home, second.home);
  assert.notEqual(first.temp, second.temp);
  assert.notEqual(first.artifactRoot, second.artifactRoot);
  if (process.platform !== "win32") assert.equal((await stat(first.root)).mode & 0o777, 0o700);
  const lock = pipaPaths(first.home).lock;
  const release = await acquireInstanceLock(lock);
  first.defer(async () => { await release(); await assert.rejects(access(lock), { code: "ENOENT" }); }, "instance lock");
  await writeFile(path.join(first.temp, "staged.txt"), "staged");
  const server = createServer((_request, response) => response.end("private"));
  const url = await first.listen(server);
  const descendantFile = path.join(first.workspace, "descendant.pid");
  const processRecord = first.spawn(process.execPath, ["-e", "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); child.once('close', () => process.exit(0)); process.on('SIGTERM', () => child.kill('SIGTERM')); require('node:fs').writeFileSync(process.argv[1], String(child.pid)); setInterval(() => {}, 1000)", descendantFile]);
  const descendant = Number(await first.waitFor(() => readFile(descendantFile, "utf8").catch((error) => { if (error.code === "ENOENT") return false; throw error; }), { label: "descendant startup" }));
  assert.equal((await fetch(url)).status, 200);
  first.abort();
  await first.teardown();
  assert.ok((await processRecord.exited).signal || processRecord.child.exitCode !== null);
  assert.equal(server.listening, false);
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(500) }));
  await assert.rejects(access(first.root), { code: "ENOENT" });
  await second.waitFor(() => {
    try { process.kill(descendant, 0); return false; }
    catch (error) { if (error.code === "ESRCH") return true; throw error; }
  }, { label: "descendant termination", timeoutMs: 2_000 });
  await access(second.workspace);
  assert.equal(second.signal.aborted, false);
  await Promise.all([first.teardown(), first.teardown()]);
});

test("fixture deadlines and cleanup failures are bounded and observable", async (t) => {
  await assert.rejects(bounded(new Promise(() => {}), { timeoutMs: 5, label: "hung operation" }), /hung operation timed out/u);
  await assert.rejects(waitFor(() => new Promise(() => {}), { timeoutMs: 5, label: "hung predicate" }), /hung predicate timed out/u);
  const runtime = await createRuntimeFixture({ timeoutMs: 10 });
  t.after(() => runtime.teardown());
  await bounded(new Promise((resolve) => runtime.signal.addEventListener("abort", resolve, { once: true })));
  await runtime.teardown();
  await assert.rejects(access(runtime.root), { code: "ENOENT" });
  const failed = await createRuntimeFixture({ cleanupTimeoutMs: 5 });
  failed.defer(() => new Promise(() => {}), "hung resource");
  await assert.rejects(failed.teardown(), /cleanup failed/u);
  await access(failed.root);
  // An intentionally failed teardown retains evidence; this self-test owns it.
  const { rm } = await import("node:fs/promises");
  await rm(failed.root, { recursive: true, force: true });
});

test("private child environment excludes synthetic Slack secrets and ambient integrations, preserves deliberate integrations", async (t) => {
  const marker = "SYNTHETIC_SLACK_SECRET_DO_NOT_EXPORT";
  const environment = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT,
    HOME: "/ambient", PIPA_HOME: "/ambient", NODE_OPTIONS: "--invalid", HTTPS_PROXY: "http://ambient", PIPA_OPENCODE_ATTACH_URL: "http://ambient",
    OPENAI_API_KEY: "synthetic-provider", CUSTOM_MCP_KEY: "synthetic-integration", PIPA_SLACK_BOT_TOKEN: marker, Slack_Client_Secret: marker };
  const runtime = await createRuntimeFixture({ environment, allowEnvironment: ["CUSTOM_MCP_KEY", "PIPA_SLACK_BOT_TOKEN", "Slack_Client_Secret"] });
  t.after(() => runtime.teardown());
  for (const key of ["NODE_OPTIONS", "HTTPS_PROXY", "PIPA_OPENCODE_ATTACH_URL", "OPENAI_API_KEY"]) assert.equal(runtime.env[key], undefined);
  const clean = cleanChildEnvironment({ ...runtime.env, OPENAI_API_KEY: "synthetic-provider", PIPA_SLACK_BOT_TOKEN: marker, Slack_Client_Secret: marker });
  assert.equal(clean.OPENAI_API_KEY, "synthetic-provider", "production inheritance must retain intended integrations");
  assert.equal(clean.CUSTOM_MCP_KEY, "synthetic-integration");
  assert.doesNotMatch(JSON.stringify(clean), new RegExp(marker, "u"));
  const childFile = path.join(runtime.workspace, "child-environment.json");
  const { exited } = runtime.spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.env))", childFile]);
  assert.equal((await exited).code, 0);
  const evidence = await readFile(childFile, "utf8");
  assert.doesNotMatch(evidence, new RegExp(marker, "u"));
  const observed = JSON.parse(evidence);
  assert.equal(observed.CUSTOM_MCP_KEY, "synthetic-integration");
  for (const key of ["HOME", "USERPROFILE", "PIPA_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR", "TMP", "TEMP", "APPDATA", "LOCALAPPDATA", "ProgramData", "OPENCODE_DB", "OPENCODE_CONFIG"]) assert.ok(observed[key].startsWith(runtime.root + path.sep), key);
});

test("isolated production attachment/artifact turn uses private HOME/temp and removes staged files", async (t) => {
  const runtime = await createRuntimeFixture();
  t.after(() => runtime.teardown());
  const production = pathToFileURL(fileURLToPath(new URL("../src/opencode.mjs", import.meta.url))).href;
  const contract = new URL("./helpers/opencode-contract.mjs", import.meta.url).href;
  const child = runtime.spawn(process.execPath, ["--input-type=module", "-e", String.raw`
    import assert from 'node:assert/strict';
    import { access, readFile, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    import { createOpenCodeExecutor } from ${JSON.stringify(production)};
    import { loadWireFixture, createWireFixture, runTurnContract } from ${JSON.stringify(contract)};
    const workspace = process.cwd();
    const document = await loadWireFixture('v1', { workspace, temp: process.env.TMPDIR });
    let staged, artifacts;
    const wire = createWireFixture(document, { onRequest: async (call) => {
      if (!call.path.endsWith('/prompt_async')) return;
      staged = new URL(call.body.parts[1].url);
      assert.equal(await readFile(staged, 'utf8'), 'attachment bytes');
      assert.ok(staged.pathname.includes('/temp/'));
      assert.ok(call.body.system.includes(JSON.stringify(process.env.PIPA_HOME)));
      artifacts = call.body.system.match(/private artifact directory: (.+)\n/)[1];
      await writeFile(path.join(artifacts, 'report.txt'), 'artifact bytes');
      document.routes.find(route => route.path.endsWith('/message')).responses[1].json[0].parts[1].text += '\nPIPA_ARTIFACTS: ["report.txt"]';
    }});
    const executor = createOpenCodeExecutor({ baseUrl: 'http://127.0.0.1:4096', fetch: wire.fetch, artifactRoot: path.join(workspace, '.pipa', 'artifacts'), environment: process.env, pollIntervalMs: 1 });
    try {
      await runTurnContract({ executor, input: { prompt: document.prompt, sessionId: document.expected.sessionId, workingDirectory: workspace, contextEnvironment: { PIPA_MESSAGE_CHANNEL: 'slack' }, attachments: [{ name: 'notes.txt', mimeType: 'text/plain', fetchData: async () => Buffer.from('attachment bytes') }] }, expected: { ...document.expected, files: [{ filename: 'report.txt', base64: Buffer.from('artifact bytes').toString('base64') }] }, caseName: 'v1 isolated files' });
      await assert.rejects(access(staged), { code: 'ENOENT' });
      await assert.rejects(access(artifacts), { code: 'ENOENT' });
      wire.assertComplete();
    } finally { executor.stopAll(); }
    const cancelledDocument = await loadWireFixture('v1', { workspace, temp: process.env.TMPDIR });
    const entered = Promise.withResolvers();
    const cancelledWire = createWireFixture(cancelledDocument, { onRequest: async (call, init) => {
      if (!call.path.endsWith('/prompt_async')) return;
      staged = new URL(call.body.parts[1].url);
      artifacts = call.body.system.match(/private artifact directory: (.+)\n/)[1];
      entered.resolve();
      await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }});
    const cancelledExecutor = createOpenCodeExecutor({ baseUrl: 'http://127.0.0.1:4096', fetch: cancelledWire.fetch, artifactRoot: path.join(workspace, '.pipa', 'artifacts'), environment: process.env });
    const turn = cancelledExecutor.runTurn({ prompt: 'cancel files', sessionId: 'ses_contract', workingDirectory: workspace, contextEnvironment: { PIPA_MESSAGE_CHANNEL: 'slack' }, attachments: [{ name: 'pending.txt', fetchData: async () => Buffer.from('pending') }] });
    const rejected = assert.rejects(turn, /cancelled file turn/);
    await entered.promise;
    await cancelledExecutor.abortTurn('ses_contract', new Error('cancelled file turn'));
    await rejected;
    await assert.rejects(access(staged), { code: 'ENOENT' });
    await assert.rejects(access(artifacts), { code: 'ENOENT' });
    cancelledWire.assertComplete();
    cancelledExecutor.stopAll();
  `]);
  let stderr = "";
  child.child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  assert.equal((await child.exited).code, 0, stderr);
  assert.deepEqual(await readdir(runtime.temp), []);
  assert.deepEqual(await readdir(runtime.artifactRoot), []);
});
