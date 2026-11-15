import { loadSettings } from "./settings";
import { fetchSpeech } from "./transport";

let activeRequest: AbortController | undefined;
let activeTab: number | undefined;

async function activate(tab: browser.tabs.Tab) {
  if (tab.id === undefined) return;
  try {
    await browser.tabs.executeScript(tab.id, {
      file: "content.js",
      frameId: 0,
    });
  } catch {
    await browser.browserAction.setBadgeText({ tabId: tab.id, text: "!" });
  }
}

browser.browserAction.onClicked.addListener(activate);
browser.menus.create({
  id: "kokoro-selection",
  title: "Read selection with Kokoro",
  contexts: ["selection"],
});
browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "kokoro-selection" && tab) void activate(tab);
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
  if (value.type === "speech:cancel") {
    if (activeTab === sender.tab.id) activeRequest?.abort();
    return Promise.resolve({ ok: true });
  }
  if (value.type !== "speech:generate" || typeof value.text !== "string")
    return;
  activeRequest?.abort();
  const controller = new AbortController();
  activeRequest = controller;
  activeTab = sender.tab.id;
  const text = value.text;
  return (async () => {
    try {
      const settings = await loadSettings();
      const audio = await fetchSpeech(settings, text, controller.signal);
      return { ok: true, audio };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error && error.name !== "TypeError"
            ? error.message
            : "Cannot reach the local speech server. Start it and check Settings.",
      };
    } finally {
      if (activeRequest === controller) {
        activeRequest = undefined;
        activeTab = undefined;
      }
    }
  })();
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (activeTab === tabId) activeRequest?.abort();
});
