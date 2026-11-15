import { loadSettings } from "./settings";
import { fetchSpeech, MAX_AUDIO_BYTES } from "./speech/transport";
import { SpeechCoordinator, type Owner } from "./speech/coordinator";

const coordinator = new SpeechCoordinator((owner, type) =>
  browser.tabs.sendMessage(
    owner.tabId,
    { type, sessionId: owner.sessionId, leaseId: owner.leaseId },
    { frameId: 0 },
  ),
);
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
