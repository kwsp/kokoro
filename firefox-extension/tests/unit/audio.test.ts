import { describe, expect, it, vi } from "vitest";
import {
  MAX_BUFFER_BYTES,
  wavDecodedBytes,
  WebAudioPlayer,
} from "../../src/speech/audio";

function wav(samples = 240) {
  const bytes = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(bytes);
  const tag = (at: number, value: string) =>
    Array.from(value).forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples * 2, true);
  return bytes;
}

function fixture() {
  const sources: {
    buffer: AudioBuffer | null;
    onended: (() => void) | null;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  const context = {
    currentTime: 10,
    destination: {},
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    decodeAudioData: vi
      .fn()
      .mockResolvedValue({ duration: 4, length: 96000, numberOfChannels: 1 }),
    createBufferSource: () => {
      const source = {
        buffer: null,
        onended: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      sources.push(source);
      return source;
    },
  };
  const factory = vi.fn(() => context as unknown as AudioContext);
  const player = new WebAudioPlayer(factory);
  return {
    player,
    context,
    factory,
    sources,
    buffer: { duration: 4 } as AudioBuffer,
  };
}

describe("Web Audio adapter", () => {
  it("creates and resumes its context synchronously in the user gesture", async () => {
    const { player, factory, context } = fixture();
    const activation = player.activate();
    expect(factory).toHaveBeenCalledOnce();
    expect(context.resume).toHaveBeenCalledOnce();
    await activation;
    await player.activate();
    expect(factory).toHaveBeenCalledOnce();
  });
  it("uses the audio clock for pause offset and creates a new source on resume", async () => {
    const { player, context, sources, buffer } = fixture();
    await player.activate();
    const ended = vi.fn();
    player.play(buffer, 0, ended);
    context.currentTime = 11.25;
    expect(player.pause()).toBe(1.25);
    expect(sources[0]!.stop).toHaveBeenCalledOnce();
    expect(sources[0]!.onended).toBeNull();
    context.currentTime = 20;
    player.play(buffer, 1.25, ended);
    expect(sources[1]!.start).toHaveBeenCalledWith(0, 1.25);
    sources[1]!.onended!();
    expect(ended).toHaveBeenCalledOnce();
    expect(sources[1]!.disconnect).toHaveBeenCalledOnce();
  });
  it("ignores an obsolete source's late end callback", async () => {
    const { player, sources, buffer } = fixture();
    await player.activate();
    const ended = vi.fn();
    player.play(buffer, 0, ended);
    const obsolete = sources[0]!.onended!;
    player.stop();
    player.play(buffer, 0, ended);
    obsolete();
    expect(ended).not.toHaveBeenCalled();
    sources[1]!.onended!();
    expect(ended).toHaveBeenCalledOnce();
  });
  it("bounds pause at the buffer duration and releases context on Close", async () => {
    const { player, context, buffer } = fixture();
    await player.activate();
    player.play(buffer, 3, vi.fn());
    context.currentTime = 50;
    expect(player.pause()).toBe(4);
    player.stop();
    player.close();
    expect(context.close).toHaveBeenCalledOnce();
  });
  it("decodes only valid server PCM WAV", async () => {
    const { player, context } = fixture();
    await player.activate();
    const bytes = wav();
    expect(wavDecodedBytes(bytes)).toBe(960);
    await player.decode(bytes);
    expect(context.decodeAudioData).toHaveBeenCalledWith(bytes);
    await expect(player.decode(new ArrayBuffer(2))).rejects.toThrow(
      "invalid WAV",
    );
  });
  it("rejects truncated, wrong-rate, empty, and non-PCM audio before decoding", () => {
    const truncated = wav();
    new DataView(truncated).setUint32(40, 900000, true);
    expect(() => wavDecodedBytes(truncated)).toThrow("truncated");
    const wrongRate = wav();
    new DataView(wrongRate).setUint32(24, 48000, true);
    expect(() => wavDecodedBytes(wrongRate)).toThrow("24 kHz");
    const compressed = wav();
    new DataView(compressed).setUint16(20, 3, true);
    expect(() => wavDecodedBytes(compressed)).toThrow("PCM");
    expect(() => wavDecodedBytes(wav(0))).toThrow("PCM");
  });
  it("rejects decoded memory over the combined cap before allocating audio", async () => {
    const { player, context } = fixture();
    await player.activate();
    await expect(
      player.decode(wav(Math.ceil(MAX_BUFFER_BYTES / 6))),
    ).rejects.toThrow("memory limit");
    expect(context.decodeAudioData).not.toHaveBeenCalled();
  });
  it("checks actual decoder size and reports decoding failures", async () => {
    const { player, context } = fixture();
    await player.activate();
    context.decodeAudioData.mockResolvedValueOnce({
      length: MAX_BUFFER_BYTES,
      numberOfChannels: 1,
    });
    await expect(player.decode(wav())).rejects.toThrow("memory limit");
    context.decodeAudioData.mockRejectedValueOnce(new Error("platform detail"));
    await expect(player.decode(wav())).rejects.toThrow("could not decode");
  });
});
