import { describe, expect, it, vi } from "vitest";
import { defaults } from "../../src/settings";
import { fetchSpeech, MAX_AUDIO_BYTES } from "../../src/speech/transport";

describe("speech transport", () => {
  const settings = { ...defaults, token: "local-secret" };
  it.each([401, 429, 500, 200])(
    "cancels rejected response bodies for status %s",
    async (status) => {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ cancel }), {
        status,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      });
      const mock = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(
        fetchSpeech(settings, "Hello.", new AbortController().signal, mock),
      ).rejects.toThrow();
      expect(cancel).toHaveBeenCalledOnce();
      expect(mock).toHaveBeenCalledOnce();
    },
  );
  it("requests WAV with bearer auth and preserves binary bytes", async () => {
    const bytes = new Uint8Array([0, 128, 255, 1]);
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(bytes, { headers: { "Content-Type": "audio/wav" } }),
      );
    const signal = new AbortController().signal;
    expect(
      new Uint8Array(await fetchSpeech(settings, "Hello.", signal, mock)),
    ).toEqual(bytes);
    const [url, options] = mock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8880/v1/audio/speech");
    expect(options?.signal).toBe(signal);
    expect(options?.redirect).toBe("error");
    expect(options?.headers).toEqual({
      Authorization: "Bearer local-secret",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(options?.body as string)).toEqual({
      model: "kokoro",
      input: "Hello.",
      voice: "af_heart",
      speed: 1,
      response_format: "wav",
    });
  });
  it.each([
    [401, "token"],
    [429, "busy"],
    [500, "failed"],
  ])("maps status %s to a useful message", async (status, message) => {
    const mock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("private backend details", {
        status: Number(status),
        headers: { "Retry-After": "60" },
      }),
    );
    await expect(
      fetchSpeech(settings, "Hello.", new AbortController().signal, mock),
    ).rejects.toThrow(String(message));
  });
  it("rejects a non-audio response", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("{}", { headers: { "Content-Type": "application/json" } }),
      );
    await expect(
      fetchSpeech(settings, "Hello.", new AbortController().signal, mock),
    ).rejects.toThrow("WAV");
  });
  it("bounds received audio even without Content-Length", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_AUDIO_BYTES + 1));
      },
      cancel,
    });
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(body, { headers: { "Content-Type": "audio/wav" } }),
      );
    await expect(
      fetchSpeech(settings, "Hello.", new AbortController().signal, mock),
    ).rejects.toThrow("too large");
    expect(cancel).toHaveBeenCalled();
  });
  it.each(["", " ".repeat(4), "x".repeat(4097)])(
    "rejects invalid input before fetch",
    async (text) => {
      const mock = vi.fn<typeof fetch>();
      await expect(
        fetchSpeech(settings, text, new AbortController().signal, mock),
      ).rejects.toThrow();
      expect(mock).not.toHaveBeenCalled();
    },
  );
});

describe("bounded busy retries", () => {
  const settings = { ...defaults, token: "secret" };
  it("honors Retry-After and eventually reports a bounded busy error", async () => {
    const mock = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response("busy", {
          status: 429,
          headers: { "Retry-After": "1" },
        }),
    );
    let clock = 0;
    const delay = vi.fn(async (ms: number) => {
      clock += ms;
    });
    await expect(
      fetchSpeech(
        settings,
        "Read.",
        new AbortController().signal,
        mock,
        1000,
        delay,
        () => clock,
      ),
    ).rejects.toThrow("busy");
    expect(mock).toHaveBeenCalledTimes(5);
    expect(delay).toHaveBeenCalledTimes(4);
    expect(delay.mock.calls.every(([ms]) => ms === 1000)).toBe(true);
  });
  it("resumes after the previous two-retry window", async () => {
    const mock = vi.fn<typeof fetch>().mockImplementation(async () =>
      mock.mock.calls.length <= 4
        ? new Response("busy", {
            status: 429,
            headers: { "Retry-After": "1" },
          })
        : new Response(new Uint8Array([1]), {
            headers: { "Content-Type": "audio/wav" },
          }),
    );
    const delay = vi.fn().mockResolvedValue(undefined);
    expect(
      new Uint8Array(
        await fetchSpeech(
          settings,
          "Read.",
          new AbortController().signal,
          mock,
          1000,
          delay,
        ),
      ),
    ).toEqual(new Uint8Array([1]));
    expect(mock).toHaveBeenCalledTimes(5);
  });
  it("does not shorten a Retry-After beyond its bounded window", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("busy", { status: 429, headers: { "Retry-After": "30" } }),
      );
    const delay = vi.fn();
    await expect(
      fetchSpeech(
        settings,
        "Read.",
        new AbortController().signal,
        mock,
        1000,
        delay,
      ),
    ).rejects.toThrow("busy");
    expect(mock).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });
  it("does not fetch again when a delayed timer resumes after the deadline", async () => {
    let clock = 0;
    const mock = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response("busy", {
          status: 429,
          headers: { "Retry-After": "1" },
        }),
    );
    const delay = vi.fn(async () => {
      clock = 6_000;
    });
    await expect(
      fetchSpeech(
        settings,
        "Read.",
        new AbortController().signal,
        mock,
        1000,
        delay,
        () => clock,
      ),
    ).rejects.toThrow("busy");
    expect(mock).toHaveBeenCalledOnce();
  });
  it("does not retry an aborted generation", async () => {
    const controller = new AbortController();
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("busy", { status: 429 }));
    const delay = vi.fn(async () => {
      controller.abort();
    });
    await expect(
      fetchSpeech(settings, "Read.", controller.signal, mock, 1000, delay),
    ).rejects.toThrow();
    expect(mock).toHaveBeenCalledOnce();
  });
  it("limits prefetch bytes to the caller's remaining budget", async () => {
    const mock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array(50), {
        headers: { "Content-Type": "audio/wav" },
      }),
    );
    await expect(
      fetchSpeech(settings, "Read.", new AbortController().signal, mock, 49),
    ).rejects.toThrow("too large");
  });
});
