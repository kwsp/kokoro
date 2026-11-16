import { loadSettings, validateSettings } from "./settings";
import { fetchSpeech, MAX_AUDIO_BYTES } from "./speech/transport";
import { SpeechCoordinator, type Owner } from "./speech/coordinator";

const previewPorts = new Map<string, browser.runtime.Port>();
const previewNotices = new Map<browser.runtime.Port, Map<string, () => void>>();
const coordinator = new SpeechCoordinator((owner, type) => {
  const port = previewPorts.get(owner.sessionId);
  if (port) {
    return new Promise<void>((resolve) => {
      const notices = previewNotices.get(port)!;
      notices.set(owner.leaseId, resolve);
      try {
        port.postMessage({ type, leaseId: owner.leaseId });
      } catch {
        notices.delete(owner.leaseId);
        resolve();
      }
    });
  }
  return browser.tabs.sendMessage(
    owner.tabId,
    { type, sessionId: owner.sessionId, leaseId: owner.leaseId },
    { frameId: 0 },
  );
});
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 100;

async function activate(tab: browser.tabs.Tab, selectionOnly = false) {
  if (tab.id === undefined) return;
  try {
    await browser.tabs.executeScript(tab.id, {
      file: "Readability.js",
      frameId: 0,
    });
    await browser.tabs.executeScript(tab.id, {
      file: "content.js",
      frameId: 0,
    });
    await browser.tabs.sendMessage(
      tab.id,
      { type: "reader:activate", selectionOnly },
      { frameId: 0 },
    );
    await browser.browserAction.setBadgeText({ tabId: tab.id, text: "" });
    await browser.browserAction.setTitle({
      tabId: tab.id,
      title: "Read with Kokoro",
    });
  } catch {
    await browser.browserAction.setTitle({
      tabId: tab.id,
      title: "Kokoro cannot read this Firefox page. Try an ordinary webpage.",
    });
    await browser.browserAction.setBadgeText({ tabId: tab.id, text: "!" });
  }
}

browser.browserAction.onClicked.addListener((tab) => {
  void activate(tab);
});
browser.menus.create({
  id: "kokoro-selection",
  title: "Read selection with Kokoro",
  contexts: ["selection"],
});
browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "kokoro-selection" && tab) void activate(tab, true);
});
browser.runtime.onInstalled.addListener(() => {
  void browser.runtime.openOptionsPage();
});

browser.runtime.onMessage.addListener((message: unknown, sender) => {
  if (
    !message ||
    typeof message !== "object" ||
    sender.tab?.id === undefined ||
    sender.frameId !== 0
  )
    return;
  const value = message as Record<string, unknown>;
  if (value.type === "settings:open") return browser.runtime.openOptionsPage();
  if (!identifier(value.sessionId) || !identifier(value.leaseId)) return;
  const owner: Owner = {
    tabId: sender.tab.id,
    sessionId: value.sessionId,
    leaseId: value.leaseId,
  };
  if (value.type === "reader:release") {
    coordinator.release(owner);
    return Promise.resolve({ ok: true });
  }
  if (value.type === "speech:cancel" && identifier(value.requestId)) {
    coordinator.cancel(owner, value.requestId);
    return Promise.resolve({ ok: true });
  }
  if (
    value.type !== "reader:claim" &&
    (value.type !== "speech:generate" ||
      typeof value.text !== "string" ||
      !identifier(value.requestId) ||
      !Number.isInteger(value.maxBytes) ||
      Number(value.maxBytes) < 1 ||
      Number(value.maxBytes) > MAX_AUDIO_BYTES)
  )
    return;
  return (async () => {
    try {
      if (value.type === "reader:claim") {
        await coordinator.claim(owner);
        return { ok: true };
      }
      const audio = await coordinator.run(
        owner,
        value.requestId as string,
        async (signal) => {
          const settings = await loadSettings();
          return fetchSpeech(
            settings,
            value.text as string,
            signal,
            fetch,
            Number(value.maxBytes),
          );
        },
      );
      return { ok: true, audio };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error && error.name !== "TypeError"
            ? error.message
            : "Cannot reach the local speech server. Start it and check Settings.",
      };
    }
  })();
});

// This port is accepted only from the extension's own options document.
browser.runtime.onConnect.addListener((port) => {
  const sender = port.sender;
  if (
    port.name !== "voice-preview" ||
    sender?.url !== browser.runtime.getURL("options.html") ||
    sender.tab?.id === undefined ||
    sender.frameId !== 0
  ) {
    port.disconnect();
    return;
  }
  const tabId = sender.tab.id;
  const notices = new Map<string, () => void>();
  previewNotices.set(port, notices);
  let sessionId = "";
  port.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== "object") return;
    const value = message as Record<string, unknown>;
    if (value.type === "notice:ack" && identifier(value.leaseId)) {
      notices.get(value.leaseId)?.();
      notices.delete(value.leaseId);
      return;
    }
    if (!identifier(value.sessionId) || !identifier(value.leaseId)) return;
    if (sessionId && sessionId !== value.sessionId) return;
    sessionId = value.sessionId;
    previewPorts.set(sessionId, port);
    const owner = { tabId, sessionId, leaseId: value.leaseId };
    if (value.type === "reader:release") {
      coordinator.release(owner);
      return;
    }
    if (value.type === "speech:cancel" && identifier(value.requestId)) {
      coordinator.cancel(owner, value.requestId);
      return;
    }
    if (!identifier(value.callId)) return;
    const callId = value.callId;
    void (async () => {
      try {
        if (value.type === "reader:claim") {
          await coordinator.claim(owner);
          port.postMessage({ callId, ok: true });
        } else if (
          value.type === "speech:generate" &&
          identifier(value.requestId) &&
          typeof value.text === "string" &&
          Number.isInteger(value.maxBytes) &&
          Number(value.maxBytes) >= 1 &&
          Number(value.maxBytes) <= MAX_AUDIO_BYTES
        ) {
          const settings = validateSettings(value.settings);
          const audio = await coordinator.run(
            owner,
            value.requestId,
            (signal) =>
              fetchSpeech(
                settings,
                value.text as string,
                signal,
                fetch,
                Number(value.maxBytes),
              ),
          );
          port.postMessage({ callId, ok: true, audio });
        }
      } catch (error) {
        try {
          port.postMessage({
            callId,
            ok: false,
            error:
              error instanceof Error && error.name !== "TypeError"
                ? error.message
                : "Cannot reach the local speech server.",
          });
        } catch {
          /* The options page has closed. */
        }
      }
    })();
  });
  port.onDisconnect.addListener(() => {
    if (sessionId && previewPorts.get(sessionId) === port) {
      previewPorts.delete(sessionId);
      coordinator.removeTab(tabId);
    }
    for (const resolve of notices.values()) resolve();
    previewNotices.delete(port);
  });
});

browser.tabs.onRemoved.addListener((tabId) => coordinator.removeTab(tabId));
browser.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading") coordinator.removeTab(tabId);
});
browser.storage.onChanged.addListener((changes, area) => {
  if (
    area === "local" &&
    changes.settings &&
    JSON.stringify(changes.settings.oldValue) !==
      JSON.stringify(changes.settings.newValue)
  )
    void coordinator.settingsChanged();
});
