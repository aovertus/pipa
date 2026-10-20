import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Chat } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { startPipa } from "../src/app.mjs";
import { createModelPicker } from "../src/models.mjs";
import { createModelSetting, createSessionStore, loadConfig, pipaPaths, writePrivateJson } from "../src/state.mjs";

test("native Slack adapter routes command, options, modal save, cancel and same-session requests", async (t) => {
  const paths = pipaPaths(await mkdtemp(path.join(os.tmpdir(), "pipa-native-model-")));
  const config = { botName: "Pipa", workingDirectory: "/work", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", allowedSlackUserIds: ["U1"], allowedSlackChannelIds: ["C1"] };
  await writePrivateJson(paths.config, config);
  const adapter = createSlackAdapter({ signingSecret: "test", botToken: "xoxb-test", botUserId: "UPIPA", userName: "Pipa" });
  adapter.lookupUser = async () => ({ displayName: "User" });
  const views = [];
  const notices = [];
  adapter.postEphemeral = async (...args) => { notices.push(args); return { id: "private" }; };
  adapter._client.views.open = async ({ view }) => { views.push(view); return { ok: true, view: { id: `V${views.length}` } }; };
  const posts = [];
  adapter.postMessage = async (threadId, text) => { posts.push(text); return { id: "reply", threadId, raw: {} }; };
  adapter.addReaction = adapter.removeReaction = adapter.startTyping = async () => undefined;
  const chat = new Chat({ adapters: { slack: adapter }, state: createMemoryState(), concurrency: "concurrent", userName: "Pipa", logger: "silent" });
  const models = [{ providerID: "openai", modelID: "a", name: "A" }, { providerID: "fireworks-ai", modelID: "b", name: "B" }];
  const calls = [];
  const app = await startPipa({ paths, chat, routinesEnabled: false, checkSlackToken: async () => ({ ok: true }),
    executor: { listModels: async () => models, runTurn: async (input) => { calls.push(input); return { text: "done", sessionId: "ses_same" }; }, stopAll() {} },
    sessionStore: await createSessionStore(paths.sessions) });
  t.after(() => app.shutdown());
  const open = async () => {
    const waiting = [];
    await adapter.handleSlashCommand(new URLSearchParams({ command: "/pipa", text: "model", user_id: "U1", channel_id: "C1", trigger_id: "trigger" }), { waitUntil: (p) => waiting.push(p) });
    await Promise.all(waiting);
    assert.ok(views.length, JSON.stringify(notices));
    return views.at(-1);
  };
  for (const [index, expected] of models.entries()) {
    const view = await open();
    assert.equal(view.blocks[0].type, "input");
    const actionId = view.blocks[0].element.action_id;
    const optionsResponse = await adapter.handleBlockSuggestion({ action_id: actionId, value: expected.providerID, user: { id: "U1" }, view: { id: `V${views.length}` } });
    const choices = (await optionsResponse.json()).options;
    assert.equal(choices.length, 1);
    const saved = await adapter.handleViewSubmission({ user: { id: "U1" }, view: { ...view, id: `V${views.length}`, state: { values: { [actionId]: { [actionId]: { selected_option: choices[0] } } } } } });
    assert.equal((await saved.json()).response_action, "update");
    assert.deepEqual((await loadConfig(paths.config)).defaultModel, { providerID: expected.providerID, modelID: expected.modelID });
    const waiting = [];
    const message = adapter.parseMessage({ type: "message", channel: "C1", ts: `${index + 1}.0`, ...(index ? { thread_ts: "1.0" } : {}), text: index ? "follow up" : "<@UPIPA> begin", user: "U1" });
    chat.processMessage(adapter, message.threadId, message, { waitUntil: (p) => waiting.push(p) });
    await Promise.all(waiting);
    for (let tries = 0; posts.length <= index && tries < 100; tries++) await delay(10);
    assert.deepEqual(calls[index].model, { providerID: expected.providerID, modelID: expected.modelID });
  }
  assert.equal(calls[1].sessionId, "ses_same");
  assert.equal(posts.length, 2);
  const reopened = await open();
  assert.equal(reopened.blocks[0].element.initial_option.text.text, "b");
  const before = await readFile(paths.config, "utf8");
  const waiting = [];
  adapter.handleViewClosed({ user: { id: "U1" }, view: { ...reopened, id: `V${views.length}` } }, { waitUntil: (p) => waiting.push(p) });
  await Promise.all(waiting);
  assert.equal(await readFile(paths.config, "utf8"), before);
  assert.equal(calls.length, 2);
});

test("private picker opens/searches/saves/reopens/cancels without inference and rechecks auth", async () => {
  const paths = pipaPaths(await mkdtemp(path.join(os.tmpdir(), "pipa-picker-")));
  const config = { botName: "Pipa", workingDirectory: "/work", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", allowedSlackUserIds: ["U1"], allowedSlackChannelIds: ["C1"] };
  await writePrivateJson(paths.config, config);
  const models = [{ providerID: "openai", modelID: "model/a.b", name: "Model A" }];
  const handlers = {};
  const chat = {
    onSlashCommand(id, fn) { handlers.slash = fn; },
    onOptionsLoad(fn) { handlers.options = fn; },
    onModalSubmit(id, fn) { handlers.submit = fn; },
    onModalClose(id, fn) { handlers.close = fn; },
  };
  let modal;
  let discoveries = 0;
  const picker = createModelPicker({ chat, loadConfig: () => loadConfig(paths.config), setting: createModelSetting(paths.config), listModels: async () => { discoveries++; return models; } });
  const user = { userId: "U1" };
  const messages = [];
  const opening = { user, text: "model", channel: { id: "slack:C1", postEphemeral: async (...args) => messages.push(args) }, openModal: async (value) => { modal = value; return { viewId: "V1" }; } };
  await handlers.slash(opening);
  assert.equal(discoveries, 0);
  const input = modal.children[0];
  assert.equal(input.placeholder, "OpenCode default");
  const options = await handlers.options({ actionId: input.id, user, query: "a.b", raw: { view: { id: "V1" } } });
  assert.equal(options.length, 1);
  const submission = { user, privateMetadata: modal.privateMetadata, viewId: "V1", values: { [input.id]: options[0].value } };
  const saved = await handlers.submit(submission);
  assert.equal(saved.action, "update");
  assert.deepEqual((await loadConfig(paths.config)).defaultModel, { providerID: "openai", modelID: "model/a.b" });
  await handlers.slash(opening);
  assert.equal(modal.children[0].initialOption.value, options[0].value);
  const before = await readFile(paths.config, "utf8");
  await handlers.close({ privateMetadata: modal.privateMetadata, user, viewId: "V1" });
  assert.equal(await readFile(paths.config, "utf8"), before);
  await handlers.slash(opening);
  await writePrivateJson(paths.config, { ...config, allowedSlackUserIds: ["U2"] });
  assert.deepEqual(await handlers.options({ actionId: modal.children[0].id, user, raw: { view: { id: "V1" } } }), []);
  const denied = await handlers.submit({ ...submission, privateMetadata: modal.privateMetadata });
  assert.equal(denied.action, "errors");
  assert.equal((await loadConfig(paths.config)).defaultModel, undefined);
  picker.close();
});

test("picker failure paths never persist and search output respects Slack bounds", async () => {
  const handlers = {};
  const chat = { onSlashCommand: (_id, fn) => { handlers.open = fn; }, onOptionsLoad: (fn) => { handlers.search = fn; }, onModalSubmit: (_id, fn) => { handlers.save = fn; }, onModalClose: (_id, fn) => { handlers.cancel = fn; } };
  const config = { allowedSlackUserIds: ["U1"], allowedSlackChannelIds: ["C1"] };
  const models = Array.from({ length: 120 }, (_, id) => ({ providerID: "provider", modelID: String(id), name: "n".repeat(200) }));
  let clock = 0;
  let failed = false;
  let writes = 0;
  const picker = createModelPicker({ chat, now: () => clock, loadConfig: async () => config,
    listModels: async () => { if (failed) throw new Error("private upstream details"); return models; },
    setting: { save: async (_model, authorize) => { authorize(config); writes++; throw new Error("disk unavailable"); } } });
  let modal;
  const user = { userId: "U1" };
  const privateReplies = [];
  const event = { user, text: "model", channel: { id: "slack:C1", postEphemeral: async (...args) => privateReplies.push(args) }, openModal: async (value) => { modal = value; return { viewId: "V1" }; } };
  for (const text of ["", "unknown"]) await handlers.open({ ...event, text });
  assert.equal(privateReplies.length, 2);
  assert.ok(privateReplies.every((args) => args[2].fallbackToDM === false));
  await handlers.open(event);
  const id = modal.children[0].id;
  const search = { user, actionId: id, query: "", raw: { view: { id: "V1" } } };
  const choices = await handlers.search(search);
  assert.equal(choices.length, 100);
  assert.ok(choices.every((choice) => choice.label.length <= 75 && choice.value.length <= 150 && choice.description.length <= 75));
  const save = { user, viewId: "V1", privateMetadata: modal.privateMetadata, values: { [id]: choices[0].value } };
  for (const bad of [{ ...save, user: { userId: "U2" } }, { ...save, viewId: "other" }, { ...save, privateMetadata: "forged" }, { ...save, values: { [id]: "missing" } }]) {
    assert.equal((await handlers.save(bad)).action, "errors");
  }
  assert.equal(writes, 0);
  failed = true;
  assert.deepEqual(await handlers.search(search), []);
  assert.equal((await handlers.save(save)).action, "errors");
  assert.equal(writes, 0);
  failed = false;
  assert.equal((await handlers.save(save)).action, "errors");
  assert.equal(writes, 1);
  config.allowedSlackChannelIds = ["C2"];
  assert.deepEqual(await handlers.search(search), []);
  assert.equal((await handlers.save(save)).action, "errors");
  assert.equal(writes, 1);
  config.allowedSlackChannelIds = ["C1"];
  clock = 31 * 60_000;
  assert.equal((await handlers.save(save)).action, "errors");
  assert.equal(writes, 1);
  picker.close();
  assert.deepEqual(await handlers.search(search), []);
});
