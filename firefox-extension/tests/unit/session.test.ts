import { describe, expect, it, vi } from "vitest";
import type { AudioAdapter } from "../../src/audio";
import type { ReadingSegment } from "../../src/mapping";
import {
  ReadingSession,
  createRequestId,
  type Snapshot,
  type SpeechTransport,
} from "../../src/session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const settle = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};
const buffer = {
  duration: 2,
  length: 48000,
  numberOfChannels: 1,
} as AudioBuffer;
function fixture() {
  const requests: {
    text: string;
    id: string;
    result: ReturnType<typeof deferred<ArrayBuffer>>;
  }[] = [];
  const callbacks: (() => void)[] = [];
  const audio = {
    activate: vi.fn().mockResolvedValue(undefined),
    decode: vi.fn().mockResolvedValue(buffer),
    play: vi.fn((_buffer: AudioBuffer, _offset: number, ended: () => void) => {
      callbacks.push(ended);
    }),
    pause: vi.fn(() => 0.75),
    stop: vi.fn(),
    close: vi.fn(),
  } satisfies AudioAdapter;
  const transport = {
    fetch: vi.fn((text: string, id: string) => {
      const result = deferred<ArrayBuffer>();
      requests.push({ text, id, result });
      return result.promise;
    }),
    cancel: vi.fn(),
  } satisfies SpeechTransport;
  const snapshots: Snapshot[] = [];
  const segments = ["First.", "Second."].map((text) => ({
    text,
    ranges: [],
    block: document.body,
  })) satisfies ReadingSegment[];
  let id = 0;
  const session = new ReadingSession(
    segments,
    audio,
    transport,
    (snapshot) => snapshots.push(snapshot),
    () => String(++id),
  );
  async function ready() {
    session.play();
    await settle();
    requests.at(-1)!.result.resolve(new ArrayBuffer(44));
    await settle();
  }
  return { session, audio, transport, requests, callbacks, snapshots, ready };
}

describe("reading session", () => {
  it("creates request IDs on HTTP pages without randomUUID", () => {
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      throw new Error("Unavailable on HTTP");
    });
    try {
      expect(createRequestId()).toMatch(/^[a-f0-9]{32}$/);
      expect(createRequestId()).not.toBe(createRequestId());
      expect(randomUUID).not.toHaveBeenCalled();
    } finally {
      randomUUID.mockRestore();
    }
  });
  it("reads sentences sequentially and highlights only while playing", async () => {
    const { session, ready, requests, callbacks } = fixture();
    await ready();
    expect(session.snapshot).toMatchObject({
      state: "playing",
      index: 0,
      highlightedIndex: 0,
    });
    expect(requests.map((r) => r.text)).toEqual(["First."]);
    callbacks[0]!();
    expect(session.snapshot).toMatchObject({
      state: "preparing",
      index: 1,
      highlightedIndex: null,
    });
    expect(requests.map((r) => r.text)).toEqual(["First.", "Second."]);
    requests[1]!.result.resolve(new ArrayBuffer(44));
    await settle();
    callbacks[1]!();
    expect(session.snapshot).toMatchObject({
      state: "finished",
      highlightedIndex: null,
    });
  });
  it("pauses and resumes at the retained offset without fetching again", async () => {
    const { session, ready, audio, requests } = fixture();
    await ready();
    session.pause();
    expect(session.snapshot).toMatchObject({
      state: "paused",
      offset: 0.75,
      highlightedIndex: 0,
    });
    session.play();
    await settle();
    expect(audio.play.mock.calls[1]?.[1]).toBe(0.75);
    expect(requests).toHaveLength(1);
    expect(session.snapshot.state).toBe("playing");
  });
  it("cancels preparing work and refetches on Resume", async () => {
    const { session, transport, requests, audio } = fixture();
    session.play();
    await settle();
    session.pause();
    expect(transport.cancel).toHaveBeenCalledWith(requests[0]!.id);
    requests[0]!.result.resolve(new ArrayBuffer(44));
    await settle();
    expect(audio.decode).not.toHaveBeenCalled();
    expect(session.snapshot.state).toBe("paused");
    session.play();
    await settle();
    expect(requests.map((r) => r.text)).toEqual(["First.", "First."]);
  });
  it("Stop rejects late network results and resets the position", async () => {
    const { session, requests, audio, transport } = fixture();
    session.seek(1);
    await settle();
    session.stop();
    requests[0]!.result.resolve(new ArrayBuffer(44));
    await settle();
    expect(transport.cancel).toHaveBeenCalledWith(requests[0]!.id);
    expect(audio.decode).not.toHaveBeenCalled();
    expect(session.snapshot).toMatchObject({
      state: "ready",
      index: 0,
      highlightedIndex: null,
    });
  });
  it("Stop rejects a decode that completes after cancellation", async () => {
    const { session, requests, audio } = fixture();
    const decoding = deferred<AudioBuffer>();
    audio.decode.mockReturnValueOnce(decoding.promise);
    session.play();
    await settle();
    requests[0]!.result.resolve(new ArrayBuffer(44));
    await settle();
    expect(audio.decode).toHaveBeenCalledOnce();
    session.stop();
    decoding.resolve(buffer);
    await settle();
    expect(audio.play).not.toHaveBeenCalled();
    expect(session.snapshot.state).toBe("ready");
  });
  it("seeking discards delayed old decoding and stale audio callbacks", async () => {
    const { session, requests, audio, callbacks } = fixture();
    const decoding = deferred<AudioBuffer>();
    audio.decode.mockReturnValueOnce(decoding.promise);
    session.play();
    await settle();
    requests[0]!.result.resolve(new ArrayBuffer(44));
    await settle();
    session.seek(1);
    await settle();
    requests[1]!.result.resolve(new ArrayBuffer(44));
    await settle();
    decoding.resolve(buffer);
    await settle();
    expect(audio.play).toHaveBeenCalledOnce();
    expect(session.snapshot.index).toBe(1);
    const stale = callbacks[0]!;
    session.stop();
    stale();
    expect(session.snapshot.state).toBe("ready");
    expect(requests).toHaveLength(2);
  });
  it("Retry keeps the failed sentence position", async () => {
    const { session, requests, audio } = fixture();
    session.seek(1);
    await settle();
    requests[0]!.result.reject(new Error("The server is busy."));
    await settle();
    expect(session.snapshot).toMatchObject({
      state: "error",
      index: 1,
      error: "The server is busy.",
    });
    session.play();
    await settle();
    requests[1]!.result.resolve(new ArrayBuffer(44));
    await settle();
    expect(requests.map((r) => r.text)).toEqual(["Second.", "Second."]);
    expect(audio.play).toHaveBeenCalledOnce();
  });
  it("a failed decode produces Retry without adopting audio", async () => {
    const { session, ready, audio } = fixture();
    audio.decode.mockRejectedValueOnce(new Error("Invalid WAV."));
    await ready();
    expect(session.snapshot).toMatchObject({
      state: "error",
      error: "Invalid WAV.",
      highlightedIndex: null,
    });
    expect(audio.play).not.toHaveBeenCalled();
  });
  it("ignores late failures after Stop and duplicate Play gestures", async () => {
    const { session, requests } = fixture();
    session.play();
    session.play();
    await settle();
    expect(requests).toHaveLength(1);
    session.stop();
    requests[0]!.result.reject(new Error("obsolete"));
    await settle();
    expect(session.snapshot.state).toBe("ready");
  });
  it("invalidates delayed activation before requests start", async () => {
    const { session, requests, audio } = fixture();
    const activation = deferred<void>();
    audio.activate.mockReturnValueOnce(activation.promise);
    session.play();
    session.stop();
    activation.resolve();
    await settle();
    expect(requests).toHaveLength(0);
  });
  it("restarts at the beginning after completion", async () => {
    const { session, ready, callbacks, requests } = fixture();
    await ready();
    callbacks[0]!();
    requests[1]!.result.resolve(new ArrayBuffer(44));
    await settle();
    callbacks[1]!();
    session.play();
    await settle();
    expect(requests[2]!.text).toBe("First.");
  });
  it("Close cancels audio, clears state, and releases the audio context", async () => {
    const { session, ready, audio } = fixture();
    await ready();
    session.close();
    expect(audio.close).toHaveBeenCalledOnce();
    expect(session.snapshot.highlightedIndex).toBeNull();
  });
  it("replaces scope and handles empty selections and invalid seeks", async () => {
    const { session, ready, requests } = fixture();
    await ready();
    session.replaceSegments([]);
    session.play();
    expect(session.snapshot.state).toBe("error");
    expect(requests).toHaveLength(1);
    session.seek(-1);
    session.seek(1.5);
    expect(requests).toHaveLength(1);
  });
});
