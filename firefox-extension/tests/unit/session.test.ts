import { describe, expect, it, vi } from "vitest";
import { MAX_BUFFER_BYTES, type AudioAdapter } from "../../src/audio";
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
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
const buffer = {
  duration: 2,
  length: 48000,
  numberOfChannels: 1,
} as AudioBuffer;
function wav(samples = 1) {
  const bytes = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(bytes);
  const tag = (offset: number, value: string) => {
    for (let n = 0; n < value.length; n++)
      view.setUint8(offset + n, value.charCodeAt(n));
  };
  tag(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples * 2, true);
  return bytes;
}
function fixture(prefetch = false, text = ["First.", "Second."]) {
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
    claim: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    fetch: vi.fn<SpeechTransport["fetch"]>((text, id) => {
      const result = deferred<ArrayBuffer>();
      requests.push({ text, id, result });
      return result.promise;
    }),
    cancel: vi.fn(),
  } satisfies SpeechTransport;
  const snapshots: Snapshot[] = [];
  const segments = text.map((text) => ({
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
    prefetch,
  );
  async function ready() {
    session.play();
    await settle();
    requests.at(-1)!.result.resolve(wav());
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
    await settle();
    expect(session.snapshot).toMatchObject({
      state: "preparing",
      index: 1,
      highlightedIndex: null,
    });
    expect(requests.map((r) => r.text)).toEqual(["First.", "Second."]);
    requests[1]!.result.resolve(wav());
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
    expect(transport.cancel).toHaveBeenCalledWith(
      requests[0]!.id,
      expect.any(String),
    );
    requests[0]!.result.resolve(wav());
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
    requests[0]!.result.resolve(wav());
    await settle();
    expect(transport.cancel).toHaveBeenCalledWith(
      requests[0]!.id,
      expect.any(String),
    );
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
    requests[0]!.result.resolve(wav());
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
    requests[0]!.result.resolve(wav());
    await settle();
    session.seek(1);
    await settle();
    requests[1]!.result.resolve(wav());
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
    requests[1]!.result.resolve(wav());
    await settle();
    expect(requests.map((r) => r.text)).toEqual(["Second.", "Second."]);
    expect(audio.play).toHaveBeenCalledOnce();
  });
  it.each(["playing", "paused"])(
    "seeks from %s without carrying an offset or adopting old end events",
    async (state) => {
      const { session, ready, audio, requests, callbacks } = fixture();
      await ready();
      const obsoleteEnd = callbacks[0]!;
      if (state === "paused") session.pause();
      session.seek(1);
      await settle();
      expect(session.snapshot).toMatchObject({
        state: "preparing",
        index: 1,
        offset: 0,
        highlightedIndex: null,
      });
      requests[1]!.result.resolve(wav());
      await settle();
      expect(audio.play.mock.calls.at(-1)?.[1]).toBe(0);
      obsoleteEnd();
      expect(session.snapshot).toMatchObject({ state: "playing", index: 1 });
      expect(requests).toHaveLength(2);
      callbacks.at(-1)!();
      expect(session.snapshot.state).toBe("finished");
    },
  );
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
    await settle();
    requests[1]!.result.resolve(wav());
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

describe("prefetch and ownership", () => {
  it("decodes future audio early but only plays and highlights it at its turn", async () => {
    const { session, ready, requests, audio, callbacks } = fixture(true);
    await ready();
    expect(requests.map((request) => request.text)).toEqual([
      "First.",
      "Second.",
    ]);
    requests[1]!.result.resolve(wav());
    await settle();
    expect(audio.decode).toHaveBeenCalledTimes(2);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(session.snapshot.highlightedIndex).toBe(0);
    callbacks[0]!();
    expect(session.snapshot.state).toBe("playing");
    expect(audio.decode).toHaveBeenCalledTimes(2);
    expect(session.snapshot.highlightedIndex).toBe(1);
    expect(requests).toHaveLength(2);
  });
  it("drops a late prefetch after Stop without decoding it", async () => {
    const { session, ready, requests, audio } = fixture(true);
    await ready();
    session.stop();
    requests[1]!.result.resolve(wav());
    await settle();
    expect(audio.decode).toHaveBeenCalledOnce();
    expect(session.snapshot.state).toBe("ready");
  });
  it("retries an unread sentence with its normal budget after prefetch fails", async () => {
    const { session, ready, requests, transport, audio, callbacks } =
      fixture(true);
    audio.decode.mockResolvedValueOnce({ ...buffer, length: 6 * 1024 * 1024 });
    await ready();
    requests[1]!.result.reject(
      new Error("Prefetch exceeded its smaller budget."),
    );
    await settle();
    expect(session.snapshot.state).toBe("playing");
    callbacks[0]!();
    await settle();
    expect(requests.map((request) => request.text)).toEqual([
      "First.",
      "Second.",
      "Second.",
    ]);
    expect(transport.fetch.mock.calls[2]![3]).toBeGreaterThan(
      transport.fetch.mock.calls[1]![3],
    );
    requests[2]!.result.resolve(wav());
    await settle();
    expect(session.snapshot).toMatchObject({ state: "playing", index: 1 });
  });
  it("budgets streamed bytes against the retained decoded buffer", async () => {
    const { ready, audio, transport } = fixture(true);
    audio.decode.mockResolvedValueOnce({ ...buffer, length: 6 * 1024 * 1024 });
    await ready();
    expect(transport.fetch.mock.calls[1]?.[3]).toBe(
      Math.floor((8 * 1024 * 1024) / 3),
    );
  });
  it("reserves raw and decoded space alongside the currently playing audio", async () => {
    const { ready, transport } = fixture(true);
    await ready();
    expect(transport.fetch.mock.calls[1]?.[3]).toBe(
      Math.floor((MAX_BUFFER_BYTES - buffer.length * 4) / 3),
    );
  });
  it("fills eight short future sentences serially, then refills as playback advances", async () => {
    const text = Array.from({ length: 12 }, (_, index) => `Sentence ${index}.`);
    const { session, ready, requests, audio, callbacks, snapshots } = fixture(
      true,
      text,
    );
    audio.decode.mockResolvedValue({ ...buffer, duration: 0.3 });
    await ready();
    for (let index = 1; index <= 8; index++) {
      expect(requests).toHaveLength(index + 1);
      requests[index]!.result.resolve(wav());
      await settle();
    }
    expect(requests).toHaveLength(9);
    expect(audio.decode).toHaveBeenCalledTimes(9);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(session.snapshot.highlightedIndex).toBe(0);
    const before = snapshots.length;
    callbacks[0]!();
    expect(session.snapshot).toMatchObject({ state: "playing", index: 1 });
    expect(snapshots.slice(before).map(({ state }) => state)).toEqual([
      "playing",
    ]);
    await settle();
    expect(requests).toHaveLength(10);
    expect(requests[9]!.text).toBe(text[9]);
  });
  it("stops filling after fifteen seconds of future audio, even with space for more entries", async () => {
    const { ready, requests, audio, callbacks } = fixture(true, [
      "One.",
      "Two.",
      "Three.",
      "Four.",
      "Five.",
    ]);
    audio.decode.mockResolvedValue({ ...buffer, duration: 8 });
    await ready();
    requests[1]!.result.resolve(wav());
    await settle();
    requests[2]!.result.resolve(wav());
    await settle();
    expect(requests).toHaveLength(3);
    callbacks[0]!();
    await settle();
    expect(requests).toHaveLength(4);
    expect(requests[3]!.text).toBe("Four.");
  });
  it("reports playback failures when advancing to an already decoded sentence", async () => {
    const { session, ready, requests, audio, callbacks, transport } =
      fixture(true);
    await ready();
    requests[1]!.result.resolve(wav());
    await settle();
    audio.play.mockImplementationOnce(() => {
      throw new Error("Audio unavailable.");
    });
    callbacks[0]!();
    expect(session.snapshot).toMatchObject({
      state: "error",
      index: 1,
      error: "Audio unavailable.",
      highlightedIndex: null,
    });
    expect(transport.release).toHaveBeenCalledOnce();
  });
  it("awaits an in-flight future sentence without starting a duplicate request", async () => {
    const { session, ready, requests, audio, callbacks } = fixture(true, [
      "One.",
      "Two.",
      "Three.",
    ]);
    await ready();
    callbacks[0]!();
    await settle();
    expect(session.snapshot).toMatchObject({ state: "preparing", index: 1 });
    expect(requests).toHaveLength(2);
    requests[1]!.result.resolve(wav());
    await settle();
    expect(session.snapshot).toMatchObject({ state: "playing", index: 1 });
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(requests.map(({ text }) => text)).toEqual([
      "One.",
      "Two.",
      "Three.",
    ]);
  });
  it("awaits a future decode without duplicate fetching or early highlighting", async () => {
    const { session, ready, requests, audio, callbacks } = fixture(true);
    await ready();
    const decoding = deferred<AudioBuffer>();
    audio.decode.mockReturnValueOnce(decoding.promise);
    requests[1]!.result.resolve(wav());
    await settle();
    expect(session.snapshot.highlightedIndex).toBe(0);
    callbacks[0]!();
    await settle();
    expect(session.snapshot.state).toBe("preparing");
    expect(requests).toHaveLength(2);
    decoding.resolve(buffer);
    await settle();
    expect(session.snapshot).toMatchObject({
      state: "playing",
      highlightedIndex: 1,
    });
  });
  it("preserves ready sentences before a failed prefetch and retries only when reached", async () => {
    const { session, ready, requests, callbacks } = fixture(true, [
      "One.",
      "Two.",
      "Three.",
      "Four.",
    ]);
    await ready();
    requests[1]!.result.resolve(wav());
    await settle();
    requests[2]!.result.reject(new Error("Busy."));
    await settle();
    expect(requests).toHaveLength(3);
    callbacks[0]!();
    await settle();
    expect(session.snapshot).toMatchObject({ state: "playing", index: 1 });
    expect(requests).toHaveLength(3);
    callbacks[1]!();
    await settle();
    expect(requests.map(({ text }) => text)).toEqual([
      "One.",
      "Two.",
      "Three.",
      "Three.",
    ]);
    requests[3]!.result.reject(new Error("Still busy."));
    await settle();
    expect(session.snapshot).toMatchObject({
      state: "error",
      index: 2,
      error: "Still busy.",
    });
    expect(requests).toHaveLength(4);
  });
  it("retries a failed prefetched decode when its sentence is reached", async () => {
    const { session, ready, requests, audio, callbacks } = fixture(true);
    await ready();
    audio.decode.mockRejectedValueOnce(new Error("Decode failed."));
    requests[1]!.result.resolve(wav());
    await settle();
    expect(session.snapshot.state).toBe("playing");
    callbacks[0]!();
    await settle();
    expect(requests).toHaveLength(3);
    requests[2]!.result.resolve(wav());
    await settle();
    expect(session.snapshot).toMatchObject({ state: "playing", index: 1 });
  });
  it("does not adopt a future decode or continue filling after Stop", async () => {
    const { session, ready, requests, audio } = fixture(true, [
      "One.",
      "Two.",
      "Three.",
    ]);
    await ready();
    const decoding = deferred<AudioBuffer>();
    audio.decode.mockReturnValueOnce(decoding.promise);
    requests[1]!.result.resolve(wav());
    await settle();
    session.stop();
    decoding.resolve(buffer);
    await settle();
    expect(audio.play).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    expect(session.snapshot.state).toBe("ready");
  });
  it("waits for obsolete prefetch decoding before refilling after Resume", async () => {
    const { session, ready, requests, audio } = fixture(true, [
      "One.",
      "Two.",
      "Three.",
    ]);
    await ready();
    const decoding = deferred<AudioBuffer>();
    audio.decode.mockReturnValueOnce(decoding.promise);
    Object.assign(audio, {
      waitForDecode: () => decoding.promise.then(() => {}),
    });
    requests[1]!.result.resolve(wav());
    await settle();
    session.pause();
    session.play();
    await settle();
    expect(session.snapshot.state).toBe("playing");
    expect(requests).toHaveLength(2);
    decoding.resolve(buffer);
    await settle();
    expect(requests.map(({ text }) => text)).toEqual(["One.", "Two.", "Two."]);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });
  it("discards ready future audio and pending work on a seek", async () => {
    const { session, ready, requests, audio, transport } = fixture(true, [
      "One.",
      "Two.",
      "Three.",
      "Four.",
    ]);
    await ready();
    requests[1]!.result.resolve(wav());
    await settle();
    session.seek(3);
    expect(transport.cancel).toHaveBeenCalledWith(
      requests[2]!.id,
      expect.any(String),
    );
    await settle();
    requests[3]!.result.resolve(wav());
    await settle();
    requests[2]!.result.resolve(wav());
    await settle();
    expect(audio.decode).toHaveBeenCalledTimes(3);
    expect(session.snapshot).toMatchObject({ state: "playing", index: 3 });
    expect(requests.map(({ text }) => text)).toEqual([
      "One.",
      "Two.",
      "Three.",
      "Four.",
    ]);
  });
  it("discards future buffers on Pause while retaining the current offset", async () => {
    const { session, ready, requests, audio } = fixture(true);
    await ready();
    requests[1]!.result.resolve(wav());
    await settle();
    session.pause();
    session.play();
    await settle();
    expect(audio.play.mock.calls.at(-1)?.[1]).toBe(0.75);
    expect(requests.map(({ text }) => text)).toEqual([
      "First.",
      "Second.",
      "Second.",
    ]);
  });
  it("discards all future buffers when settings change", async () => {
    const { session, ready, requests, callbacks, audio } = fixture(true);
    await ready();
    requests[1]!.result.resolve(wav());
    await settle();
    session.settingsChanged();
    await settle();
    requests[2]!.result.resolve(wav());
    await settle();
    expect(requests.map(({ text }) => text)).toEqual([
      "First.",
      "Second.",
      "First.",
      "Second.",
    ]);
    callbacks[0]!();
    expect(session.snapshot.index).toBe(0);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });
  it("accounts for every retained buffer when reserving fetch and decode memory", async () => {
    const { ready, requests, transport, audio } = fixture(true, [
      "One.",
      "Two.",
      "Three.",
    ]);
    audio.decode.mockResolvedValueOnce({ ...buffer, length: 4 * 1024 * 1024 });
    audio.decode.mockResolvedValueOnce({ ...buffer, length: 2 * 1024 * 1024 });
    await ready();
    expect(transport.fetch.mock.calls[1]![3]).toBe(
      Math.floor((16 * 1024 * 1024) / 3),
    );
    requests[1]!.result.resolve(wav());
    await settle();
    expect(transport.fetch.mock.calls[2]![3]).toBe(
      Math.floor((8 * 1024 * 1024) / 3),
    );
  });
  it("defers prefetch when there is no room and proceeds after current audio is released", async () => {
    const { ready, requests, audio, callbacks } = fixture(true);
    audio.decode.mockResolvedValueOnce({
      ...buffer,
      length: (MAX_BUFFER_BYTES - 100) / 4,
    });
    await ready();
    expect(requests).toHaveLength(1);
    callbacks[0]!();
    await settle();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.text).toBe("Second.");
  });
  it("rejects a response exceeding the remaining budget before decoding it", async () => {
    const { session, ready, requests, audio, callbacks } = fixture(true);
    audio.decode.mockResolvedValueOnce({
      ...buffer,
      length: (MAX_BUFFER_BYTES - 1000) / 4,
    });
    await ready();
    requests[1]!.result.resolve(wav(300));
    await settle();
    expect(audio.decode).toHaveBeenCalledOnce();
    expect(session.snapshot.state).toBe("playing");
    callbacks[0]!();
    await settle();
    requests[2]!.result.resolve(wav(300));
    await settle();
    expect(session.snapshot).toMatchObject({ state: "playing", index: 1 });
  });
  it("checks actual decoded memory against already retained audio", async () => {
    const { session, ready, requests, audio, callbacks } = fixture(true);
    audio.decode.mockResolvedValueOnce({ ...buffer, length: 4 * 1024 * 1024 });
    audio.decode.mockResolvedValueOnce({ ...buffer, length: 5 * 1024 * 1024 });
    await ready();
    requests[1]!.result.resolve(wav());
    await settle();
    callbacks[0]!();
    await settle();
    expect(session.snapshot.state).toBe("preparing");
    expect(requests).toHaveLength(3);
    expect(audio.play).toHaveBeenCalledOnce();
  });
  it("claims ownership on Resume and ignores stale revocation", async () => {
    const { session, ready, transport } = fixture();
    await ready();
    const firstLease = transport.claim.mock.calls[0]![0];
    session.pause();
    session.play();
    await settle();
    expect(transport.claim).toHaveBeenCalledTimes(2);
    session.revoke(firstLease);
    expect(session.snapshot.state).toBe("playing");
    session.revoke(transport.claim.mock.calls[1]![0]);
    expect(session.snapshot.state).toBe("ready");
  });
  it("waits for an obsolete native decode before fetching another response", async () => {
    const { session, requests, audio } = fixture();
    const idle = deferred<void>();
    Object.assign(audio, { waitForDecode: () => idle.promise });
    session.play();
    await settle();
    expect(requests).toHaveLength(0);
    idle.resolve();
    await settle();
    expect(requests).toHaveLength(1);
  });
  it("settings restart the current sentence and preserve a paused state", async () => {
    const { session, ready, requests } = fixture();
    await ready();
    session.settingsChanged();
    await settle();
    expect(requests.map((request) => request.text)).toEqual([
      "First.",
      "First.",
    ]);
    requests[1]!.result.resolve(wav());
    await settle();
    session.pause();
    session.settingsChanged();
    expect(session.snapshot).toMatchObject({
      state: "paused",
      offset: 0,
      highlightedIndex: null,
    });
  });
  it("a delayed settings notice invalidates cached audio after Resume claimed a new lease", async () => {
    const { session, ready, requests, transport, audio } = fixture();
    await ready();
    const oldLease = transport.claim.mock.calls[0]![0];
    session.pause();
    session.play();
    await settle();
    expect(transport.claim.mock.calls[1]![0]).not.toBe(oldLease);
    expect(requests).toHaveLength(1);
    expect(audio.play).toHaveBeenCalledTimes(2);
    session.settingsChanged();
    await settle();
    expect(session.snapshot.state).toBe("preparing");
    expect(requests).toHaveLength(2);
    requests[1]!.result.resolve(wav());
    await settle();
    expect(audio.decode).toHaveBeenCalledTimes(2);
    expect(audio.play.mock.calls.at(-1)?.[1]).toBe(0);
  });
});
