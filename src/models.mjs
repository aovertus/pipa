import { createHash, randomUUID } from "node:crypto";
import { CardText, ExternalSelect, Modal, SelectOption } from "chat";

function modelOption(model) {
  return SelectOption({
    label: (model.name || model.modelID).slice(0, 75),
    description: `${model.providerID} / ${model.modelID}`.slice(0, 75),
    value: createHash("sha256").update(JSON.stringify([model.providerID, model.modelID])).digest("hex"),
  });
}

export function createModelPicker({ chat, loadConfig, listModels, setting, now = Date.now }) {
  const pending = new Map();
  let closed = false;
  const userId = (event) => event.user?.userId ?? event.user?.id;
  const authorize = (entry, event, config) => {
    if (closed || !entry || entry.expires <= now() || entry.userId !== userId(event)
      || (entry.viewId && entry.viewId !== (event.viewId ?? event.raw?.view?.id))
      || (config.allowedSlackUserIds?.length && !config.allowedSlackUserIds.includes(entry.userId))
      || (config.allowedSlackChannelIds?.length && !config.allowedSlackChannelIds.includes(entry.channelId))) {
      throw new Error("This picker is unavailable or you are not authorized. Reopen /pipa model.");
    }
  };
  const confirmation = (message) => ({ action: "update", modal: Modal({ callbackId: "pipa_model_notice", title: "Pipa model", submitLabel: "Done", children: [CardText(message)] }) });

  chat.onSlashCommand?.("/pipa", async (event) => {
    const reply = (text) => event.channel.postEphemeral(event.user, text, { fallbackToDM: false });
    if (closed) return;
    if (event.text.trim() !== "model") return reply("Use /pipa model to choose the default for this Pipa installation.");
    let token;
    try {
      const config = await loadConfig();
      const channelId = event.channel.id.split(":")[1];
      if (!/^[CG][A-Z0-9]+$/u.test(channelId ?? "") || !userId(event) || event.user?.isBot) throw new Error("denied");
      const entry = { userId: userId(event), channelId, expires: now() + 30 * 60_000 };
      authorize(entry, event, config);
      for (const [id, context] of pending) if (context.expires <= now()) pending.delete(id);
      // ponytail: bound abandoned modals in memory; reopen when the oldest context is evicted.
      if (pending.size >= 1000) pending.delete(pending.keys().next().value);
      token = randomUUID();
      pending.set(token, entry);
      const opened = await event.openModal(Modal({
        callbackId: "pipa_model", privateMetadata: token, title: "Pipa model", submitLabel: "Save", closeLabel: "Cancel", notifyOnClose: true,
        children: [ExternalSelect({ id: `pipa_model_${token}`, label: "Default for this Pipa installation.", minQueryLength: 0,
          placeholder: "OpenCode default", ...(config.defaultModel ? { initialOption: modelOption(config.defaultModel) } : {}) })],
      }));
      if (!opened?.viewId) throw new Error("modal unavailable");
      entry.viewId = opened.viewId;
    } catch {
      pending.delete(token);
      await reply("Could not open the model picker. Check your access and try /pipa model again.");
    }
  });

  chat.onOptionsLoad?.(async (event) => {
    if (!event.actionId?.startsWith("pipa_model_")) return;
    const entry = pending.get(event.actionId.slice("pipa_model_".length));
    try {
      authorize(entry, event, await loadConfig());
      const models = await listModels();
      authorize(entry, event, await loadConfig());
      const query = String(event.query ?? "").toLowerCase();
      return models.filter((model) => `${model.name} ${model.providerID} ${model.modelID}`.toLowerCase().includes(query)).slice(0, 100).map(modelOption);
    } catch {
      // Options responses can contain only choices; show a private discovery failure in the modal.
      if (entry?.viewId && entry.userId === userId(event) && !closed) {
        await event.adapter?.webClient?.views.update({ view_id: entry.viewId, view: {
          type: "modal", callback_id: "pipa_model_notice", title: { type: "plain_text", text: "Pipa model" }, close: { type: "plain_text", text: "Close" },
          blocks: [{ type: "section", text: { type: "plain_text", text: "Could not load models. Check your access and OpenCode connection, then reopen /pipa model." } }],
        } }).catch(() => undefined);
      }
      return [];
    }
  });

  chat.onModalSubmit?.("pipa_model", async (event) => {
    const entry = pending.get(event.privateMetadata);
    const inputId = `pipa_model_${event.privateMetadata}`;
    try {
      authorize(entry, event, await loadConfig());
      const models = await listModels();
      const model = models.find((item) => modelOption(item).value === event.values?.[inputId]);
      if (!model) return { action: "errors", errors: { [inputId]: "Choose an available configured model." } };
      await setting.save({ providerID: model.providerID, modelID: model.modelID }, (config) => authorize(entry, event, config));
      pending.delete(event.privateMetadata);
      return confirmation(`${model.name || model.modelID} saved. Subsequent ordinary requests use it, including in existing threads. Newly created routines inherit it; existing routines are unchanged.`);
    } catch {
      return { action: "errors", errors: { [inputId]: "Could not save. Check your access and OpenCode connection, then reopen /pipa model." } };
    }
  });
  chat.onModalClose?.("pipa_model", (event) => {
    const entry = pending.get(event.privateMetadata);
    if (entry?.userId === userId(event)) pending.delete(event.privateMetadata);
  });
  return { close() { closed = true; pending.clear(); } };
}
