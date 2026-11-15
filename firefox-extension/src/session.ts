import { MAX_BUFFER_BYTES, wavDecodedBytes, type AudioAdapter } from "./audio";
import type { ReadingSegment } from "./mapping";
import { MAX_AUDIO_BYTES } from "./transport";

export type PlaybackState =
  "ready" | "preparing" | "playing" | "paused" | "finished" | "error";
export interface Snapshot {
  state: PlaybackState;
  index: number;
  total: number;
  offset: number;
  highlightedIndex: number | null;
  error?: string;
}
export interface SpeechTransport {
  fetch(
    text: string,
    requestId: string,
    leaseId: string,
    maxBytes: number,
  ): Promise<ArrayBuffer>;
  cancel(requestId: string, leaseId: string): void;
  claim?(leaseId: string): Promise<void>;
  release?(leaseId: string): void;
}
export function createRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) =>
    value.toString(16).padStart(8, "0"),
  ).join("");
}
const PREFETCH_SECONDS = 15;
const PREFETCH_SENTENCES = 8;

interface Prefetch {
  index: number;
  ready: Promise<void>;
  buffer?: AudioBuffer;
}

function bufferBytes(buffer?: AudioBuffer): number {
  return buffer ? buffer.length * buffer.numberOfChannels * 4 : 0;
}

export class ReadingSession {
  private generation = 0;
  private requestId?: string;
  private leaseId?: string;
  private buffer?: AudioBuffer;
  private prefetch: Prefetch[] = [];
  private fillingGeneration?: number;
  private state: PlaybackState = "ready";
  private index = 0;
  private offset = 0;
  private error?: string;

  constructor(
    private segments: readonly ReadingSegment[],
    private audio: AudioAdapter,
    private transport: SpeechTransport,
    private changed: (snapshot: Snapshot) => void,
    private makeId: () => string = createRequestId,
    private enablePrefetch = true,
  ) {}

  get snapshot(): Snapshot {
    return {
      state: this.state,
      index: this.index,
      total: this.segments.length,
      offset: this.offset,
      highlightedIndex:
        this.buffer && (this.state === "playing" || this.state === "paused")
          ? this.index
          : null,
      error: this.error,
    };
  }
  private publish(state: PlaybackState, error?: string) {
    this.state = state;
    this.error = error;
    this.changed(this.snapshot);
  }
  private invalidate(release = true) {
    this.generation++;
    if (this.requestId && this.leaseId)
      this.transport.cancel(this.requestId, this.leaseId);
    this.requestId = undefined;
    this.prefetch = [];
    this.audio.stop();
    if (release && this.leaseId) {
      this.transport.release?.(this.leaseId);
      this.leaseId = undefined;
    }
  }
  replaceSegments(segments: readonly ReadingSegment[]) {
    this.stop();
    this.segments = segments;
    this.publish("ready");
  }
  play() {
    if (this.state === "playing" || this.state === "preparing") return;
    if (!this.segments.length) {
      this.publish("error", "Select a passage, then activate Kokoro again.");
      return;
    }
    if (this.state === "finished") this.index = 0;
    const generation = ++this.generation;
    const leaseId = this.makeId();
    this.leaseId = leaseId;
    let activated: Promise<void>;
    try {
      activated = this.audio.activate();
    } catch {
      this.publish("error", "Firefox could not start audio. Press Retry.");
      return;
    }
    this.publish("preparing");
    void Promise.all([activated, this.transport.claim?.(leaseId)])
      .then(async () => {
        if (generation !== this.generation) return;
        if (this.buffer) this.start(generation);
        else await this.load(generation);
      })
      .catch((error: unknown) => this.fail(generation, error));
  }
  private async request(index: number, generation: number, maxBytes: number) {
    const requestId = this.makeId();
    this.requestId = requestId;
    try {
      const bytes = await this.transport.fetch(
        this.segments[index]!.text,
        requestId,
        this.leaseId!,
        maxBytes,
      );
      return generation === this.generation ? bytes : undefined;
    } finally {
      if (this.requestId === requestId) this.requestId = undefined;
    }
  }
  private retainedBytes(): number {
    return this.prefetch.reduce(
      (total, entry) => total + bufferBytes(entry.buffer),
      bufferBytes(this.buffer),
    );
  }
  private requestBudget(): number {
    // Stream assembly needs two raw copies; decoding needs raw PCM16 plus float32.
    return Math.min(
      MAX_AUDIO_BYTES,
      Math.floor((MAX_BUFFER_BYTES - this.retainedBytes()) / 3),
    );
  }
  private async prepare(index: number, generation: number, maxBytes: number) {
    // An obsolete native decode cannot be aborted. Wait before allocating another response.
    await this.audio.waitForDecode?.();
    if (generation !== this.generation) return;
    const bytes = await this.request(index, generation, maxBytes);
    if (!bytes || generation !== this.generation) return;
    const rawBytes = bytes.byteLength;
    if (
      rawBytes > maxBytes ||
      this.retainedBytes() + rawBytes + wavDecodedBytes(bytes) >
        MAX_BUFFER_BYTES
    )
      throw new Error("The generated audio exceeds the playback memory limit.");
    const buffer = await this.audio.decode(bytes);
    if (generation !== this.generation) return;
    if (
      this.retainedBytes() + rawBytes + bufferBytes(buffer) >
      MAX_BUFFER_BYTES
    )
      throw new Error("The generated audio exceeds the playback memory limit.");
    return buffer;
  }
  private async load(generation: number) {
    try {
      const pending = this.prefetch[0];
      if (pending) {
        await pending.ready;
        if (generation !== this.generation) return;
        this.prefetch.shift();
        this.buffer = pending.buffer;
      }
      // A failed prefetch is best-effort. Retry once after previous audio is freed.
      const buffer =
        this.buffer ??
        (await this.prepare(this.index, generation, this.requestBudget()));
      if (generation !== this.generation || !buffer) return;
      this.buffer = buffer;
      this.start(generation);
    } catch (error) {
      this.fail(generation, error);
    }
  }
  private start(generation: number) {
    try {
      this.audio.play(this.buffer!, this.offset, () => {
        if (generation !== this.generation || this.state !== "playing") return;
        this.buffer = undefined;
        this.offset = 0;
        if (this.index + 1 >= this.segments.length) {
          this.invalidate();
          this.publish("finished");
        } else {
          this.index++;
          const next = this.prefetch[0];
          if (next?.buffer) {
            this.prefetch.shift();
            this.buffer = next.buffer;
            this.start(generation);
          } else {
            this.publish("preparing");
            void this.load(generation);
          }
        }
      });
    } catch (error) {
      this.fail(generation, error);
      return;
    }
    this.publish("playing");
    void this.fill(generation);
  }
  private async fill(generation: number) {
    if (!this.enablePrefetch || this.fillingGeneration === generation) return;
    this.fillingGeneration = generation;
    try {
      while (generation === this.generation && this.state === "playing") {
        const last = this.prefetch.at(-1);
        const index = (last?.index ?? this.index) + 1;
        const seconds = this.prefetch.reduce(
          (total, entry) => total + (entry.buffer?.duration ?? 0),
          0,
        );
        const maxBytes = this.requestBudget();
        if (
          index >= this.segments.length ||
          this.prefetch.length >= PREFETCH_SENTENCES ||
          seconds >= PREFETCH_SECONDS ||
          (last && !last.buffer) ||
          maxBytes < 46
        )
          return;
        const entry: Prefetch = { index, ready: Promise.resolve() };
        this.prefetch.push(entry);
        entry.ready = this.prepare(index, generation, maxBytes).then(
          (buffer) => {
            if (generation === this.generation) entry.buffer = buffer;
          },
          () => {
            // Prefetch is best-effort; foreground retry supplies any final error.
          },
        );
        await entry.ready;
        if (!entry.buffer) return;
      }
    } finally {
      if (this.fillingGeneration === generation)
        this.fillingGeneration = undefined;
    }
  }
  private fail(generation: number, error: unknown) {
    if (generation !== this.generation) return;
    this.invalidate();
    this.buffer = undefined;
    this.offset = 0;
    this.publish(
      "error",
      error instanceof Error
        ? error.message
        : "Speech playback failed. Retry this sentence.",
    );
  }
  pause() {
    if (this.state !== "playing" && this.state !== "preparing") return;
    if (this.state === "playing") this.offset = this.audio.pause();
    this.invalidate(false);
    this.publish("paused");
  }
  stop() {
    this.invalidate();
    this.buffer = undefined;
    this.offset = 0;
    this.index = 0;
    this.publish("ready");
  }
  seek(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= this.segments.length)
      return;
    this.stop();
    this.index = index;
    this.play();
  }
  revoke(leaseId: string) {
    if (this.leaseId === leaseId) this.stop();
  }
  settingsChanged() {
    // Settings apply to this document even if a delayed notice names an older lease.
    if (!this.leaseId) return;
    const resume = this.state === "playing" || this.state === "preparing";
    const paused = this.state === "paused";
    this.invalidate();
    this.buffer = undefined;
    this.offset = 0;
    this.publish(paused ? "paused" : "ready");
    if (resume) this.play();
  }
  close() {
    this.stop();
    this.audio.close();
  }
}
