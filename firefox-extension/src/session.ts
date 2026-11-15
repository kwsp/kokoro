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
  diagnostics?: Diagnostics;
}
export interface Diagnostics {
  readyCount: number;
  readySeconds: number;
  stage:
    "waiting for previous decode" | "waiting for server" | "decoding" | "idle";
  reason?: string;
  sentences: {
    index: number;
    text: string;
    status: string;
    duration?: number;
  }[];
  lastPreparationMs?: number;
  underruns: number;
  totalWaitMs: number;
  gap?: { index: number; started: number; stage: string; durationMs?: number };
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
  failed?: boolean;
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
  private stage: Diagnostics["stage"] = "idle";
  private preparingIndex?: number;
  private lastPreparationMs?: number;
  private underruns = 0;
  private totalWaitMs = 0;
  private gap?: Diagnostics["gap"];

  private notify() {
    this.changed(this.snapshot);
  }
  private getDiagnostics(): Diagnostics {
    const ready = this.prefetch.filter((entry) => entry.buffer);
    const seconds = ready.reduce(
      (sum, entry) => sum + entry.buffer!.duration,
      0,
    );
    let reason: string | undefined;
    if (this.stage === "idle") {
      if (this.state === "paused") reason = "paused";
      else if (this.state === "error") reason = "error";
      else if (this.prefetch.some((entry) => entry.failed))
        reason = "prefetch failed; will retry when reached";
      else if (
        (this.prefetch.at(-1)?.index ?? this.index) + 1 >=
          this.segments.length &&
        this.prefetch.every((entry) => entry.buffer)
      )
        reason = "end of passage";
      else if (seconds >= PREFETCH_SECONDS) reason = "buffer target reached";
      else if (this.prefetch.length >= PREFETCH_SENTENCES)
        reason = "sentence limit reached";
      else if (this.requestBudget() < 46) reason = "memory limit reached";
      else reason = "no preparation active";
    }
    return {
      readyCount: ready.length,
      readySeconds: seconds,
      stage: this.stage,
      reason,
      sentences: this.segments
        .slice(this.index, this.index + 5)
        .map((segment, offset) => {
          const index = this.index + offset;
          const entry = this.prefetch.find((item) => item.index === index);
          const buffer = index === this.index ? this.buffer : entry?.buffer;
          return {
            index,
            text: segment.text,
            status: buffer
              ? index === this.index
                ? this.state
                : "ready"
              : this.preparingIndex === index
                ? this.stage
                : "waiting",
            duration: buffer?.duration,
          };
        }),
      lastPreparationMs: this.lastPreparationMs,
      underruns: this.underruns,
      totalWaitMs: this.totalWaitMs,
      gap: this.gap,
    };
  }

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
      diagnostics: this.getDiagnostics(),
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
    this.stage = "idle";
    this.preparingIndex = undefined;
    if (this.gap && this.gap.durationMs === undefined) {
      this.gap.durationMs = performance.now() - this.gap.started;
      this.totalWaitMs += this.gap.durationMs;
    }
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
    const started = performance.now();
    this.preparingIndex = index;
    this.stage = "waiting for previous decode";
    this.notify();
    // An obsolete native decode cannot be aborted. Wait before allocating another response.
    await this.audio.waitForDecode?.();
    if (generation !== this.generation) return;
    this.stage = "waiting for server";
    if (this.gap?.durationMs === undefined && this.gap?.stage === "idle")
      this.gap.stage = this.stage;
    this.notify();
    const bytes = await this.request(index, generation, maxBytes);
    if (!bytes || generation !== this.generation) return;
    const rawBytes = bytes.byteLength;
    if (
      rawBytes > maxBytes ||
      this.retainedBytes() + rawBytes + wavDecodedBytes(bytes) >
        MAX_BUFFER_BYTES
    )
      throw new Error("The generated audio exceeds the playback memory limit.");
    this.stage = "decoding";
    this.notify();
    const buffer = await this.audio.decode(bytes);
    if (generation !== this.generation) return;
    if (
      this.retainedBytes() + rawBytes + bufferBytes(buffer) >
      MAX_BUFFER_BYTES
    )
      throw new Error("The generated audio exceeds the playback memory limit.");
    this.lastPreparationMs = performance.now() - started;
    this.stage = "idle";
    this.preparingIndex = undefined;
    this.notify();
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
      if (this.gap && this.gap.durationMs === undefined) {
        this.gap.durationMs = performance.now() - this.gap.started;
        this.totalWaitMs += this.gap.durationMs;
      }
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
            this.underruns++;
            this.gap = {
              index: this.index,
              started: performance.now(),
              stage: this.stage,
            };
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
        this.notify();
        entry.ready = this.prepare(index, generation, maxBytes).then(
          (buffer) => {
            if (generation === this.generation) {
              entry.buffer = buffer;
              this.notify();
            }
          },
          () => {
            if (generation === this.generation) {
              entry.failed = true;
              this.stage = "idle";
              this.preparingIndex = undefined;
              this.notify();
            }
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
    this.underruns = 0;
    this.totalWaitMs = 0;
    this.gap = undefined;
    this.lastPreparationMs = undefined;
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
