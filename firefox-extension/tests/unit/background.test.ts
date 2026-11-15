import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../../src/settings";
import { fetchSpeech } from "../../src/transport";

vi.mock("../../src/settings", () => ({ loadSettings: vi.fn() }));
vi.mock("../../src/transport", () => ({ fetchSpeech: vi.fn() }));
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
const settle = async () => {
  for (let n = 0; n < 5; n++) await Promise.resolve();
};

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
    tabs: { onRemoved: { addListener: vi.fn() } },
  });
  await import("../../src/background");
});

afterEach(() => vi.unstubAllGlobals());

describe("background request routing", () => {
  it("rejects non-page senders, frames, and malformed requests before transport", () => {
    const message = { type: "speech:generate", text: "Read.", requestId: "1" };
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
        url: "https://untrusted.invalid",
      },
      sender,
    );
    expect(fetchSpeech).toHaveBeenCalledWith(
      settings,
      "Read.",
      expect.any(AbortSignal),
    );
    expect(result).toEqual({ ok: true, audio });
    expect(JSON.stringify(result)).not.toContain("private-token");
  });
  it("an old request cancellation cannot cancel its replacement", async () => {
    const resolvers: ((audio: ArrayBuffer) => void)[] = [];
    vi.mocked(fetchSpeech).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const first = listener(
      { type: "speech:generate", text: "First.", requestId: "old" },
      sender,
    );
    await settle();
    const firstSignal = vi.mocked(fetchSpeech).mock.calls[0]![2];
    const second = listener(
      { type: "speech:generate", text: "Second.", requestId: "new" },
      sender,
    );
    await settle();
    const secondSignal = vi.mocked(fetchSpeech).mock.calls[1]![2];
    expect(firstSignal.aborted).toBe(true);
    await listener({ type: "speech:cancel", requestId: "old" }, sender);
    await listener(
      { type: "speech:cancel", requestId: "new" },
      { ...sender, tab: { ...sender.tab!, id: 2 } },
    );
    expect(secondSignal.aborted).toBe(false);
    await listener({ type: "speech:cancel", requestId: "new" }, sender);
    expect(secondSignal.aborted).toBe(true);
    for (const resolve of resolvers) resolve(new ArrayBuffer(44));
    await Promise.all([first, second]);
  });
  it("reports an actionable connection failure without raw network details", async () => {
    vi.mocked(fetchSpeech).mockRejectedValueOnce(
      new TypeError("private network detail"),
    );
    expect(
      await listener(
        { type: "speech:generate", text: "Read.", requestId: "1" },
        sender,
      ),
    ).toEqual({
      ok: false,
      error:
        "Cannot reach the local speech server. Start it and check Settings.",
    });
  });
});
