import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../../src/settings";
import { fetchSpeech } from "../../src/transport";

vi.mock("../../src/settings", () => ({ loadSettings: vi.fn() }));
vi.mock("../../src/transport", () => ({
  fetchSpeech: vi.fn(),
  MAX_AUDIO_BYTES: 16 * 1024 * 1024,
}));
const settings = {
  baseUrl: "http://127.0.0.1:8880",
  token: "private-token",
  voice: "af_heart",
  speed: 1,
};
const sender = { tab: { id: 1 }, frameId: 0 } as browser.runtime.MessageSender;
let listener: (
  message: unknown,
  sender: browser.runtime.MessageSender,
) => Promise<unknown> | undefined;
let settingsChanged: (
  changes: Record<string, browser.storage.StorageChange>,
  area: string,
) => void;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockResolvedValue(settings);
  vi.stubGlobal("browser", {
    runtime: {
      onMessage: {
        addListener: (handler: typeof listener) => {
          listener = handler;
        },
      },
      onInstalled: { addListener: vi.fn() },
      openOptionsPage: vi.fn().mockResolvedValue(undefined),
    },
    browserAction: {
      onClicked: { addListener: vi.fn() },
      setBadgeText: vi.fn(),
    },
    menus: { create: vi.fn(), onClicked: { addListener: vi.fn() } },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      onChanged: {
        addListener: (handler: typeof settingsChanged) => {
          settingsChanged = handler;
        },
      },
    },
  });
  await import("../../src/background");
  await listener(
    { type: "reader:claim", sessionId: "doc", leaseId: "lease" },
    sender,
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("background request routing", () => {
  it("ignores an unchanged settings save and invalidates an actual settings update", async () => {
    settingsChanged(
      { settings: { oldValue: settings, newValue: { ...settings } } },
      "local",
    );
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
    settingsChanged(
      {
        settings: { oldValue: settings, newValue: { ...settings, speed: 1.5 } },
      },
      "local",
    );
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      {
        type: "reader:settings",
        sessionId: "doc",
        leaseId: "lease",
      },
      { frameId: 0 },
    );
  });
  it("rejects non-page senders, frames, and malformed requests before transport", () => {
    const message = {
      type: "speech:generate",
      text: "Read.",
      requestId: "1",
      sessionId: "doc",
      leaseId: "lease",
      maxBytes: 1000,
    };
    expect(listener(message, {})).toBeUndefined();
    expect(listener(message, { ...sender, frameId: 1 })).toBeUndefined();
    expect(listener({ ...message, requestId: 5 }, sender)).toBeUndefined();
    expect(listener({ type: "unknown" }, sender)).toBeUndefined();
    expect(fetchSpeech).not.toHaveBeenCalled();
  });
  it("keeps credentials and configured URL in the background", async () => {
    const audio = new ArrayBuffer(44);
    vi.mocked(fetchSpeech).mockResolvedValueOnce(audio);
    const result = await listener(
      {
        type: "speech:generate",
        text: "Read.",
        requestId: "1",
        sessionId: "doc",
        leaseId: "lease",
        maxBytes: 1000,
        url: "https://untrusted.invalid",
      },
      sender,
    );
    expect(fetchSpeech).toHaveBeenCalledWith(
      settings,
      "Read.",
      expect.any(AbortSignal),
      fetch,
      1000,
    );
    expect(result).toEqual({ ok: true, audio });
    expect(JSON.stringify(result)).not.toContain("private-token");
  });
  it("rejects requests without the current lease", async () => {
    expect(
      await listener(
        {
          type: "speech:generate",
          text: "Read.",
          requestId: "1",
          sessionId: "other",
          leaseId: "stale",
          maxBytes: 1000,
        },
        sender,
      ),
    ).toMatchObject({ ok: false });
    expect(fetchSpeech).not.toHaveBeenCalled();
  });
  it("reports an actionable connection failure without raw network details", async () => {
    vi.mocked(fetchSpeech).mockRejectedValueOnce(
      new TypeError("private network detail"),
    );
    expect(
      await listener(
        {
          type: "speech:generate",
          text: "Read.",
          requestId: "1",
          sessionId: "doc",
          leaseId: "lease",
          maxBytes: 1000,
        },
        sender,
      ),
    ).toEqual({
      ok: false,
      error:
        "Cannot reach the local speech server. Start it and check Settings.",
    });
  });
});
