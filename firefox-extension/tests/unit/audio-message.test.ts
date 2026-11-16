import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeAudioMessage,
  encodeAudioMessage,
} from "../../src/speech/audio-message";
import { createRuntimeTransport } from "../../src/speech/runtime-transport";

afterEach(() => vi.unstubAllGlobals());

describe("extension audio messages", () => {
  it("preserves Firefox binary messages and round trips Safari JSON bytes", () => {
    const bytes = Uint8Array.from({ length: 100_003 }, (_, i) => i % 256);
    vi.stubGlobal("__SAFARI__", false);
    expect(encodeAudioMessage(bytes.buffer)).toBe(bytes.buffer);
    vi.stubGlobal("__SAFARI__", true);
    const encoded = encodeAudioMessage(bytes.buffer);
    expect(typeof encoded).toBe("string");
    expect(
      new Uint8Array(
        decodeAudioMessage(JSON.parse(JSON.stringify(encoded)), bytes.length),
      ),
    ).toEqual(bytes);
  });

  it("rejects malformed and over-budget messages before playback", () => {
    vi.stubGlobal("__SAFARI__", true);
    for (const value of ["!!!!", "abc", {}, new ArrayBuffer(4), "AQIDBA=="]) {
      expect(() => decodeAudioMessage(value, 3)).toThrow();
    }
  });

  it("accepts a Safari response and keeps cancellation messages unchanged", async () => {
    vi.stubGlobal("__SAFARI__", true);
    const sendMessage = vi
      .fn()
      .mockResolvedValue({ ok: true, audio: "AID/AQ==" });
    vi.stubGlobal("browser", { runtime: { sendMessage } });
    const transport = createRuntimeTransport("session");
    expect(
      new Uint8Array(await transport.fetch("text", "request", "lease", 4)),
    ).toEqual(new Uint8Array([0, 128, 255, 1]));
    transport.cancel("request", "lease");
    expect(sendMessage).toHaveBeenLastCalledWith({
      type: "speech:cancel",
      requestId: "request",
      sessionId: "session",
      leaseId: "lease",
    });
  });
});
