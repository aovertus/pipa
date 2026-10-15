import { setTimeout as delay } from "node:timers/promises";

// The facade owns files, controllers and caller callbacks; this adapter owns v1 wire data.
export function createV1Adapter({ request, baseUrl, fetchImpl, headers, pollIntervalMs }) {
  return {
    async resolveSession(sessionId, workingDirectory, controller) {
      let messages = [];
      if (sessionId) {
        while (true) {
          const status = (await request("/session/status", { method: "GET" }, workingDirectory, controller))?.[sessionId]?.type;
          if (status !== "busy" && status !== "retry") break;
          await delay(pollIntervalMs, undefined, { signal: controller.signal });
        }
        try {
          messages = await request(`/session/${encodeURIComponent(sessionId)}/message?limit=1`, { method: "GET" }, workingDirectory, controller);
        } catch (error) {
          if (error.status !== 404) throw error;
          // A missing message route is not evidence that a migrated session is absent.
          try {
            const session = await request(`/session/${encodeURIComponent(sessionId)}`, { method: "GET" }, workingDirectory, controller);
            if (session?.id !== sessionId) throw new Error("OpenCode returned an invalid session lookup.");
            throw error;
          } catch (lookupError) {
            if (lookupError === error || lookupError.status !== 404) throw lookupError;
            sessionId = null;
          }
        }
      }
      if (!sessionId) {
        const session = await request("/session", { method: "POST", body: "{}" }, workingDirectory, controller);
        if (!session?.id) throw new Error("OpenCode did not create a session.");
        sessionId = session.id;
        messages = [];
      }
      if (!Array.isArray(messages)) throw new Error("OpenCode returned an invalid message projection.");
      return { sessionId, baseline: new Set(messages.map((message) => message?.info?.id).filter(Boolean)) };
    },
    async execute({ sessionId, baseline, workingDirectory, controller, prompt, files, instructions, onInteraction, onPermissionReplied, onPermissionsReconciled }) {
      let dismissed = false;
      let permissionRejected = false;
      if (onInteraction) {
        await watchInteractions({ baseUrl, fetchImpl, headers, sessionId, workingDirectory, controller,
          onInteraction, onPermissionReplied, onPermissionsReconciled,
          onPermissionRejected: () => { permissionRejected = true; }, onDismiss: () => { dismissed = true; }, requestTurn: request }).ready;
      }
      await request(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: prompt }, ...files.map((file) => ({ type: "file", ...file }))], system: instructions }),
      }, workingDirectory, controller, [204]);
      while (true) {
        const [messages, statuses] = await Promise.all([
          request(`/session/${encodeURIComponent(sessionId)}/message?limit=1`, { method: "GET" }, workingDirectory, controller),
          request("/session/status", { method: "GET" }, workingDirectory, controller),
        ]);
        if (!Array.isArray(messages)) throw new Error("OpenCode returned an invalid message projection.");
        const message = messages.findLast((message) => message?.info?.id && !baseline.has(message.info.id) && message.info.role === "assistant");
        const status = statuses?.[sessionId]?.type;
        if (dismissed && status !== "busy" && status !== "retry") return "";
        if (["error", "failed", "cancelled"].includes(status) || message?.info.error) throw new Error("OpenCode failed to complete the turn.");
        const completed = typeof message?.info.time?.completed === "number";
        if (message && ((status !== "retry" && completed && message.info.finish === "stop") || status === "idle" || (!status && completed))) {
          const text = message.parts.filter((part) => part.type === "text" && typeof part.text === "string" && part.text).map((part) => part.text).join("\n").trim();
          if (!text && permissionRejected) return "Stopped after a permission was rejected.";
          if (!text) throw new Error("OpenCode completed without assistant text.");
          return text;
        }
        await delay(pollIntervalMs, undefined, { signal: controller.signal });
      }
    },
    async abortTurn(sessionId, workingDirectory) {
      await request(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }, workingDirectory, { signal: AbortSignal.timeout(5_000) }, [200, 204, 404], false);
    },
  };
}

function watchInteractions({ baseUrl, fetchImpl, headers, sessionId, workingDirectory, controller, onInteraction, onPermissionReplied, onPermissionsReconciled, onPermissionRejected, onDismiss, requestTurn }) {
  const seenIds = new Set();
  const messages = new Map();
  const parents = new Map();
  const interactionSessionIds = new Set([sessionId]);
  const readiness = Promise.withResolvers();
  let subscribed = false;
  const dispatch = async (event) => {
    const type = event.type === "question.asked" ? "question" : event.type === "permission.asked" ? "permission" : null;
    const properties = event.properties && typeof event.properties === "object" ? event.properties : event.data && typeof event.data === "object" ? event.data : event;
    const interactionSessionId = properties?.sessionID ?? properties?.sessionId;
    const requestId = properties?.requestID ?? properties?.requestId ?? properties?.id;
    if (!type || (interactionSessionId !== sessionId && !await belongsToSession(interactionSessionId)) || !requestId || seenIds.has(`${type}:${requestId}`)) return;
    seenIds.add(`${type}:${requestId}`);
    const request = type === "permission" ? await hydratePermission(properties, interactionSessionId) : properties;
    void settleInteraction({ type, requestId, sessionId: interactionSessionId, request, onInteraction, onPermissionRejected, onDismiss, controller, workingDirectory, requestTurn });
  };
  const belongsToSession = async (candidate) => {
    const original = candidate;
    const visited = new Set();
    while (candidate && !visited.has(candidate)) {
      if (candidate === sessionId) { interactionSessionIds.add(original); return true; }
      visited.add(candidate);
      if (!parents.has(candidate)) parents.set(candidate, requestTurn(`/session/${encodeURIComponent(candidate)}`, { method: "GET" }, workingDirectory, controller).then((session) => session?.parentID));
      candidate = await parents.get(candidate);
    }
    return false;
  };
  const hydratePermission = async (permission, interactionSessionId) => {
    const tool = permission.tool;
    if (!tool?.messageID || !tool.callID) return permission;
    if (!messages.has(tool.messageID)) messages.set(tool.messageID, requestTurn(`/session/${encodeURIComponent(interactionSessionId)}/message?limit=100`, { method: "GET" }, workingDirectory, controller).then((items) => items.flatMap((message) => message.info?.id === tool.messageID ? message.parts ?? [] : [])));
    const part = (await messages.get(tool.messageID)).find((item) => item.callID === tool.callID);
    return part ? { ...permission, tool: { ...tool, name: part.tool, input: part.state?.input } } : permission;
  };
  const reconcile = async () => {
    const permissions = await requestTurn("/permission", { method: "GET" }, workingDirectory, controller);
    const pending = (await Promise.all((permissions ?? []).map(async (permission) => await belongsToSession(permission?.sessionID) ? permission : null))).filter(Boolean);
    await Promise.all(pending.map((permission) => dispatch({ type: "permission.asked", properties: permission })));
    for (const interactionSessionId of interactionSessionIds) {
      const requests = pending.filter((permission) => permission.sessionID === interactionSessionId);
      onPermissionsReconciled?.({ sessionId: interactionSessionId, requestIds: new Set(requests.map((permission) => permission.id)) });
    }
  };
  const watching = (async () => {
    while (!controller.signal.aborted) {
      try {
        const url = new URL(`${baseUrl}/event`);
        url.searchParams.set("directory", workingDirectory);
        const response = await fetchImpl(url, { headers: { ...headers, accept: "text/event-stream" }, signal: controller.signal });
        if (!response.ok) throw Object.assign(new Error(`OpenCode request failed with status ${response.status}.`), { status: response.status });
        await reconcile();
        if (!subscribed) { subscribed = true; readiness.resolve(); }
        for await (const event of readServerSentEvents(response, controller.signal)) {
          if (controller.signal.aborted) return;
          const properties = event.properties && typeof event.properties === "object" ? event.properties : event.data && typeof event.data === "object" ? event.data : event;
          const interactionSessionId = properties?.sessionID ?? properties?.sessionId;
          if (event.type === "permission.replied" && (interactionSessionId === sessionId || await belongsToSession(interactionSessionId))) {
            onPermissionReplied?.({ sessionId: interactionSessionId, requestId: properties?.requestID ?? properties?.requestId, reply: properties?.reply });
            await reconcile();
            continue;
          }
          await dispatch(event);
        }
        await reconcile();
        await delay(250, undefined, { signal: controller.signal }).catch(() => undefined);
      } catch (error) {
        if (controller.signal.aborted) { if (!subscribed) readiness.reject(controller.signal.reason); return; }
        if (!subscribed) { readiness.reject(error); return; }
        await delay(250, undefined, { signal: controller.signal }).catch(() => undefined);
      }
    }
  })();
  void watching.catch(() => {
    if (!subscribed) readiness.reject(controller.signal.reason ?? new Error("OpenCode interaction watcher failed."));
    else if (!controller.signal.aborted) process.stderr.write("OpenCode interaction watcher failed.\n");
  });
  return { ready: readiness.promise };
}

async function settleInteraction({ type, requestId, sessionId, request: interactionRequest, onInteraction, onPermissionRejected, onDismiss, controller, workingDirectory, requestTurn }) {
  try {
    const decision = await abortable(Promise.resolve().then(() => onInteraction({ type, sessionId, request: interactionRequest, signal: controller.signal })), controller.signal);
    if (decision?.type === "cancelled" || decision?.type === "stopped") return;
    if (decision?.type === "stop") {
      onDismiss?.();
      if (type === "question") await requestTurn(`/question/${encodeURIComponent(requestId)}/reject`, { method: "POST" }, workingDirectory, controller, [200, 204, 404], false);
      else await requestTurn(`/permission/${encodeURIComponent(requestId)}/reply`, { method: "POST", body: JSON.stringify({ reply: "reject" }) }, workingDirectory, controller, [200, 204, 404], false);
      await requestTurn(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }, workingDirectory, controller, [200, 204], false);
      return;
    }
    if (type === "question" && decision?.type === "answer") {
      await requestTurn(`/question/${encodeURIComponent(requestId)}/reply`, { method: "POST", body: JSON.stringify({ answers: decision.answers }) }, workingDirectory, controller, [200, 204, 404], false);
    } else if (type === "question" && decision?.type === "reject") {
      await requestTurn(`/question/${encodeURIComponent(requestId)}/reject`, { method: "POST" }, workingDirectory, controller, [200, 204, 404], false);
    } else if (type === "permission" && (decision?.type === "reply" || decision?.type === "reject")) {
      const reply = decision.type === "reject" ? "reject" : decision.reply;
      if (!["once", "always", "reject"].includes(reply)) throw new Error("Invalid OpenCode permission decision.");
      try { await requestTurn(`/permission/${encodeURIComponent(requestId)}/reply`, { method: "POST", body: JSON.stringify({ reply }) }, workingDirectory, controller, [200, 204], false); }
      catch (error) { if (error.status === 404) return; throw error; }
      if (reply === "reject") onPermissionRejected?.();
    } else throw new Error(`Invalid OpenCode ${type} decision.`);
  } catch (error) {
    if (!controller.signal.aborted) process.stderr.write(`OpenCode interaction handler error: ${error.message}\n`);
  }
}

async function* readServerSentEvents(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const abort = () => reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = chunk.split("\n");
        const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        const id = lines.find((line) => line.startsWith("id:"))?.slice(3).trim();
        const type = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
        if (data) {
          try { const event = JSON.parse(data); yield type ? { id, type, data: event } : event; }
          catch { /* ponytail: preserve v1's non-JSON frame handling */ }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally { signal?.removeEventListener("abort", abort); }
}

function abortable(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const settle = (callback, value) => { signal.removeEventListener("abort", abort); callback(value); };
    const abort = () => settle(reject, signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then((value) => settle(resolve, value), (error) => settle(reject, error));
  });
}
