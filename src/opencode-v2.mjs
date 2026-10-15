import { OpenCode } from "@opencode/client";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pipaPaths, writePrivateJson } from "./state.mjs";

export function createV2Adapter(options) {
  const client = OpenCode.make({ baseUrl: options.baseUrl, headers: options.headers, fetch: (url, init) => options.fetch(url, {
    ...init,
    signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(options.connectionRequestTimeoutMs ?? 5_000)]),
  }) });
  const journalFile = options.recoveryFile ?? pipaPaths(options.environment.PIPA_HOME).openCodeRecovery;
  const prefix = `pipa-${createHash("sha256").update(path.resolve(journalFile)).digest("hex").slice(0, 16)}-`;
  const turns = new Map();
  let records;
  let mutationTail = Promise.resolve();
  let readiness;
  let blocked;
  let fatalError;

  function unavailable(cause) {
    if (!fatalError) {
      fatalError = new Error("OpenCode server became unavailable after bounded connection recovery.", { cause });
      options.onFatal?.(fatalError);
    }
    return fatalError;
  }

  async function readWithRecovery(operation, signal, confirming = false) {
    let disconnectedAt;
    while (true) {
      if (fatalError) throw fatalError;
      try { return await operation(signal); }
      catch (error) {
        if (confirming && signal.aborted && retryable(error)) throw unavailable(error);
        signal.throwIfAborted();
        if (!retryable(error)) throw error;
        disconnectedAt ??= Date.now();
        if (Date.now() - disconnectedAt >= (options.connectionRecoveryTimeoutMs ?? 10_000)) {
          // Confirm through the same authenticated authoritative read, using a
          // fresh bounded probe. Healthy long-running agent work has no deadline.
          const probe = AbortSignal.any([signal, AbortSignal.timeout(options.connectionProbeTimeoutMs ?? 1_000)]);
          try { return await operation(probe); }
          catch (cause) {
            signal.throwIfAborted();
            if (!retryable(cause) && !probe.aborted) throw cause;
            throw unavailable(cause);
          }
        }
        await delay(options.pollIntervalMs, undefined, { signal }).catch((cause) => {
          if (confirming && signal.aborted) throw unavailable(error);
          throw cause;
        });
      }
    }
  }

  async function mutate(change) {
    const operation = mutationTail.then(async () => {
      const next = change(records);
      await writePrivateJson(journalFile, { version: 1, records: next });
      records = next;
    });
    mutationTail = operation.catch(() => undefined);
    return operation;
  }

  async function lookup(sessionId, workingDirectory, signal) {
    let session;
    try { session = await readWithRecovery((readSignal) => client.session.get({ sessionID: sessionId }, { signal: readSignal }), signal); }
    catch (error) {
      if (error._tag === "SessionNotFoundError" && error.sessionID === sessionId) return null;
      throw error;
    }
    if (session?.id !== sessionId || typeof session.location?.directory !== "string"
      || path.resolve(session.location.directory) !== path.resolve(workingDirectory)) throw new Error("OpenCode session workspace identity mismatch.");
    return session;
  }

  async function messages(sessionId, signal) {
    const result = [];
    const ids = new Set();
    const cursors = new Set();
    let cursor;
    do {
      const page = await client.message.list({ sessionID: sessionId, limit: 100, ...(cursor ? { cursor } : { order: "asc" }) }, { signal });
      if (!Array.isArray(page?.data) || !page.cursor || (page.cursor.next !== null && typeof page.cursor.next !== "string")) throw new Error("OpenCode returned an invalid message projection.");
      for (const message of page.data) {
        if (typeof message?.id !== "string" || typeof message.type !== "string" || typeof message.time?.created !== "number"
          || (message.type === "assistant" && !Array.isArray(message.content))
          || (message.type === "idle" && !["succeeded", "failed", "interrupted"].includes(message.outcome))) throw new Error("OpenCode returned an invalid message projection.");
        if (ids.has(message.id)) throw new Error("OpenCode returned duplicate projected messages.");
        ids.add(message.id);
        result.push(message);
      }
      cursor = page.cursor.next;
      if (cursor && cursors.has(cursor)) throw new Error("OpenCode repeated a message cursor.");
      cursors.add(cursor);
    } while (cursor);
    return result;
  }

  async function projection(record, signal) {
    return readWithRecovery((readSignal) => readProjection(record, readSignal), signal);
  }

  async function readProjection(record, signal) {
    // Native promotion atomically removes pending input and projects its message.
    // Read inbox first so a lost cancel reply cannot hide that handoff between reads.
    // KTD3's single-writer contract applies during the turn; observed foreign
    // input prevents session-wide interruption and suppresses local delivery.
    const inbox = await client.session.inbox.list({ sessionID: record.sessionId }, { signal });
    const timeline = await messages(record.sessionId, signal);
    if (!Array.isArray(inbox) || inbox.some((item) => typeof item?.id !== "string" || item.sessionID !== record.sessionId || typeof item.type !== "string")) throw new Error("OpenCode returned an invalid inbox projection.");
    const baseline = new Set(record.baseline);
    const fresh = timeline.filter((message) => !baseline.has(message.id));
    const foreign = fresh.some((message) => ["user", "synthetic", "shell"].includes(message.type) && message.id !== record.id)
      || inbox.some((item) => item.id !== record.id);
    const index = fresh.findIndex((message) => message.id === record.id && message.type === "user");
    const own = index >= 0 ? fresh[index] : null;
    const idle = index >= 0 ? fresh.slice(index + 1).find((message) => message.type === "idle") : null;
    const assistant = idle ? fresh.slice(index + 1, fresh.indexOf(idle)).findLast((message) => message.type === "assistant") : null;
    return { foreign, own, idle, assistant, inbox };
  }

  async function cleanup(record) {
    // Turn cancellation must never cancel removal of trusted context or recovery state.
    const signal = AbortSignal.timeout(options.cleanupTimeoutMs ?? 5_000);
    try {
      return await cleanupOwned(record, signal);
    } catch (error) {
      if (!fatalError && (retryable(error) || signal.aborted)) {
        // Cleanup can expire before the ordinary recovery window. Confirm through
        // a fresh read-only authenticated probe, independent of both expired cleanup
        // and cancelled turn signals. This adds at most one bounded probe window.
        const probe = AbortSignal.timeout(options.connectionProbeTimeoutMs ?? 1_000);
        try { await readWithRecovery((probeSignal) => client.session.get({ sessionID: record.sessionId }, { signal: probeSignal }), probe, true); }
        catch { if (fatalError) throw fatalError; }
      }
      throw error;
    }
  }

  async function cleanupOwned(record, signal) {
    if (fatalError) throw fatalError;
    if (!await lookup(record.sessionId, record.workingDirectory, signal)) {
      await mutate((items) => items.filter((item) => item.key !== record.key));
      return;
    }
    let failure;
    let foreign = Boolean(record.foreign);
    try {
      if (record.phase !== "prepared") {
        let state = await projection(record, signal);
        foreign ||= state.foreign;
        if (state.inbox.some((item) => item.id === record.id)) {
          try { await client.session.inbox.cancel({ sessionID: record.sessionId, inboxID: record.id }, { signal }); }
          catch (error) {
            // Delivery can race cancellation; a lost reply is reconciled rather than
            // treated as either an acknowledged cancellation or a missing session.
            if (!retryable(error) && !["ConflictError", "MessageNotFoundError"].includes(error._tag)) throw error;
          }
          state = await projection(record, signal);
          foreign ||= state.foreign;
          if (state.inbox.some((item) => item.id === record.id)) throw new Error("Pipa input cancellation is not acknowledged.");
          if (!state.own) {
            record.phase = "cancelled";
            await mutate((items) => items.map((item) => item.key === record.key ? { ...record } : item));
          }
        }
        if (state.own && !state.idle) {
          if (foreign || record.foreign) throw new Error("OpenCode attribution conflict: a foreign writer is still active.");
          // Native interrupt acknowledges acceptance, not settlement. Under KTD3's
          // single-writer contract it stops our active execution; never use it to
          // recover attribution after observing a foreign admission.
          try { await client.session.interrupt({ sessionID: record.sessionId, resume: false }, { signal }); }
          catch (error) { if (!retryable(error)) throw error; }
          do {
            state = await projection(record, signal);
            foreign ||= state.foreign;
            if (foreign || record.foreign) throw new Error("OpenCode attribution conflict: foreign input entered during cancellation.");
            if (!state.idle) await delay(options.pollIntervalMs, undefined, { signal });
          } while (!state.idle);
        }
        if (!state.own && record.phase !== "cancelled") throw new Error("OpenCode prompt admission remains uncertain.");
      }
    } catch (error) { failure = error; }
    // Native 2.0.29's received-body PUT handler executes its SQL mutation inline,
    // before replying; it does not enqueue a background instruction write. Live
    // cleanup follows the independently settled PUT request (including lost reply),
    // and startup removes abandoned namespaced entries without replaying that PUT.
    // A failed DELETE still retains ownership and blocks intake.
    if (record.instruction !== "absent") await client.session.instructions.entry.remove({ sessionID: record.sessionId, key: record.key }, { signal });
    if (failure) throw failure;
    await mutate((items) => items.filter((item) => item.key !== record.key));
    return foreign || Boolean(record.foreign);
  }

  async function ready(workingDirectory) {
    if (blocked) throw blocked;
    if (fatalError) throw fatalError;
    readiness ??= (async () => {
      try {
        try {
          const stats = await lstat(journalFile);
          if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Invalid Pipa OpenCode recovery file.");
          const saved = JSON.parse(await readFile(journalFile, "utf8"));
          if (saved?.version !== 1 || !Array.isArray(saved.records)) throw new Error("Invalid Pipa OpenCode recovery file.");
          records = saved.records;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          records = [];
        }
        const keys = new Set();
        for (const record of [...records]) {
          if (typeof record.key !== "string" || !record.key.startsWith(prefix) || !/^pipa-[a-f0-9]{16}-[a-f0-9-]{36}$/u.test(record.key)
            || keys.has(record.key) || typeof record.sessionId !== "string" || typeof record.id !== "string"
            || !Array.isArray(record.baseline) || !record.baseline.every((id) => typeof id === "string")
            || !["prepared", "admitting", "admitted", "cancelled"].includes(record.phase)
            || (record.instruction !== undefined && !["absent", "putting", "present"].includes(record.instruction))
            || typeof record.workingDirectory !== "string" || path.resolve(record.workingDirectory) !== path.resolve(workingDirectory)) throw new Error("Invalid or mismatched Pipa OpenCode recovery ownership.");
          keys.add(record.key);
          await cleanup(record);
        }
      } catch (cause) {
        blocked = new Error("Pipa could not reconcile abandoned OpenCode context/admissions. New intake is blocked; recovery records have been retained.", { cause });
        throw blocked;
      }
    })();
    await readiness;
  }

  return {
    ready,
    async resolveSession(sessionId, workingDirectory, controller) {
      const signal = controller.signal;
      if (sessionId && !await lookup(sessionId, workingDirectory, signal)) sessionId = null;
      if (!sessionId) {
        const session = await client.session.create({ location: { directory: workingDirectory } }, { signal });
        if (typeof session?.id !== "string" || session.location?.directory !== workingDirectory) throw new Error("OpenCode did not create a session in the configured workspace.");
        sessionId = session.id;
      }
      const [baseline, inbox, active] = await Promise.all([
        readWithRecovery((readSignal) => messages(sessionId, readSignal), signal),
        readWithRecovery((readSignal) => client.session.inbox.list({ sessionID: sessionId }, { signal: readSignal }), signal),
        readWithRecovery((readSignal) => client.session.active({ signal: readSignal }), signal),
      ]);
      if (!Array.isArray(inbox) || !active || typeof active !== "object") throw new Error("OpenCode returned invalid session projections.");
      if (inbox.length || active[sessionId] || turns.has(sessionId)) throw new Error("OpenCode attribution conflict: the session already has an active writer.");
      return { sessionId, baseline: baseline.map((message) => message.id) };
    },
    async execute({ sessionId, baseline, workingDirectory, controller, prompt, files, instructions }) {
      if (blocked) throw blocked;
      const signal = controller.signal;
      const record = { sessionId, workingDirectory, baseline, id: options.inputId?.() ?? `msg_${randomUUID().replaceAll("-", "")}`,
        key: `${prefix}${randomUUID()}`, phase: "prepared", instruction: "absent" };
      turns.set(sessionId, record);
      let stream;
      let watching;
      let streamError;
      try {
        await mutate((items) => [...items, { ...record }]);
        signal.throwIfAborted();
        const subscribed = Promise.withResolvers();
        stream = new AbortController();
        const streamSignal = stream.signal;
        const events = OpenCode.make({ baseUrl: options.baseUrl, headers: options.headers, fetch: async (url, init) => {
          const response = await options.fetch(url, init);
          if (response.ok && response.headers.get("content-type")?.includes("text/event-stream")) subscribed.resolve();
          return response;
        } });
        watching = (async () => {
          while (!streamSignal.aborted && !fatalError) {
            try {
              for await (const event of events.event.subscribe({ signal: streamSignal })) {
                if (typeof event?.type !== "string" || !event.data || typeof event.id !== "string") throw new Error("OpenCode returned an invalid event.");
                if (event.type === "session.inbox.enqueued" && event.data.sessionID === sessionId && event.data.inboxID !== record.id) record.foreign = true;
              }
            } catch (error) {
              if (streamSignal.aborted) return;
              if (!retryable(error)) { streamError = error; subscribed.reject(error); return; }
            }
            await delay(options.pollIntervalMs, undefined, { signal: streamSignal }).catch(() => undefined);
          }
        })();
        const subscriptionTimer = setTimeout(() => subscribed.reject(new Error("OpenCode event subscription recovery timed out.")), options.connectionRecoveryTimeoutMs ?? 10_000);
        try {
          await Promise.race([subscribed.promise, new Promise((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true, signal: stream.signal });
          })]);
        } catch (error) {
          signal.throwIfAborted();
          await lookup(sessionId, workingDirectory, signal);
          throw error;
        } finally { clearTimeout(subscriptionTimer); }
        signal.throwIfAborted();
        record.instruction = "putting";
        await mutate((items) => items.map((item) => item.key === record.key ? { ...record } : item));
        // Cancellation waits for this independently bounded mutation before cleanup.
        // A lost reply retains `putting` until acknowledged namespaced removal.
        await client.session.instructions.entry.put({ sessionID: sessionId, key: record.key, value: instructions }, { signal: AbortSignal.timeout(options.instructionMutationTimeoutMs ?? 5_000) });
        record.instruction = "present";
        await mutate((items) => items.map((item) => item.key === record.key ? { ...record } : item));
        signal.throwIfAborted();
        const input = { sessionID: sessionId, id: record.id, text: prompt, ...(files.length ? { files: files.map((file) => ({ uri: file.url, name: file.filename })) } : {}) };
        let admissionDisconnectedAt;
        while (true) {
          if (streamError) throw streamError;
          const state = await projection(record, signal);
          if (state.foreign || record.foreign) throw new Error("OpenCode attribution conflict: foreign input entered the Pipa turn.");
          if (state.own || state.inbox.some((item) => item.id === record.id)) break;
          try {
            if (record.phase === "prepared") {
              record.phase = "admitting";
              await mutate((items) => items.map((item) => item.key === record.key ? { ...record } : item));
            }
            const admitted = await client.session.prompt(input, { signal });
            if (admitted?.id !== record.id || admitted.sessionID !== sessionId || admitted.type !== "user" || admitted.payload?.text !== prompt) throw new Error("OpenCode returned an invalid prompt admission.");
            break;
          } catch (error) {
            signal.throwIfAborted();
            if (!retryable(error) && error.reason !== "MalformedResponse") {
              if (["AttachmentError", "SessionNotFoundError", "AgentNotFoundError", "SkillNotFoundError"].includes(error._tag)) {
                record.phase = "prepared";
                await mutate((items) => items.map((item) => item.key === record.key ? { ...record } : item));
              }
              throw error;
            }
            admissionDisconnectedAt ??= Date.now();
            if (Date.now() - admissionDisconnectedAt >= (options.connectionRecoveryTimeoutMs ?? 10_000)) {
              const state = await projection(record, signal);
              if (state.foreign || record.foreign) throw new Error("OpenCode attribution conflict: foreign input entered the Pipa turn.");
              if (state.own || state.inbox.some((item) => item.id === record.id)) break;
              throw new Error("OpenCode prompt admission remains uncertain after bounded connection recovery.");
            }
            await delay(options.pollIntervalMs, undefined, { signal });
          }
        }
        record.phase = "admitted";
        await mutate((items) => items.map((item) => item.key === record.key ? { ...record } : item));
        while (true) {
          if (streamError) throw streamError;
          const state = await projection(record, signal);
          if (state.foreign || record.foreign) throw new Error("OpenCode attribution conflict: foreign input entered the Pipa turn.");
          if (state.own?.text !== undefined && state.own.text !== prompt) throw new Error("OpenCode attribution conflict: projected input differs from the admitted prompt.");
          if (state.idle) {
            if (state.idle.outcome !== "succeeded" || state.assistant?.error || state.assistant?.finish !== "stop"
              || typeof state.assistant.time?.completed !== "number" || state.assistant.retry) throw new Error("OpenCode failed to complete the turn.");
            const text = state.assistant.content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
            if (!text) throw new Error("OpenCode completed without assistant text.");
            return text;
          }
          await delay(options.pollIntervalMs, undefined, { signal });
        }
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw error;
      } finally {
        let foreign;
        try {
          try {
            if (records.some((item) => item.key === record.key)) foreign = await cleanup(record);
          } catch (cause) {
            blocked = new Error(`${cause.message.startsWith("OpenCode attribution conflict") ? "OpenCode attribution conflict. " : ""}Pipa OpenCode cleanup failed. New intake is blocked; recovery records have been retained.`, { cause });
            throw blocked;
          }
        } finally {
          stream?.abort();
          await watching;
          turns.delete(sessionId);
        }
        if (foreign || record.foreign) throw new Error("OpenCode attribution conflict: foreign input observed during final cleanup.");
      }
    },
    // Local cancellation causes execute's independent cleanup to cancel only owned input.
    async abortTurn() {},
  };
}

function retryable(error) {
  return error.reason === "Transport" || (error.reason === "UnexpectedStatus" && [502, 503, 504].includes(error.cause?.status));
}
