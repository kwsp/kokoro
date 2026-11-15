import { MAX_BUFFER_BYTES, type AudioAdapter } from "./audio";
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
interface Prefetch {
  index: number;
  result: Promise<{ bytes?: ArrayBuffer; error?: unknown }>;
}

export class ReadingSession {
  private generation = 0;
  private requestId?: string;
  private leaseId?: string;
  private buffer?: AudioBuffer;
  private prefetch?: Prefetch;
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
    this.prefetch = undefined;
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
  private async load(generation: number) {
    try {
      // An obsolete browser decode cannot be aborted. Let it finish before allocating another response.
      await this.audio.waitForDecode?.();
      if (generation !== this.generation) return;
      const pending =
        this.prefetch?.index === this.index ? this.prefetch : undefined;
      this.prefetch = undefined;
      let result = pending
        ? await pending.result
        : {
            bytes: await this.request(
              this.index,
              generation,
              Math.min(MAX_AUDIO_BYTES, Math.floor(MAX_BUFFER_BYTES / 3)),
            ),
          };
      if (generation !== this.generation) return;
      if (result.error && pending) {
        // Prefetch is best-effort; the unread sentence gets its normal budget.
        result = {
          bytes: await this.request(
            this.index,
            generation,
            Math.min(MAX_AUDIO_BYTES, Math.floor(MAX_BUFFER_BYTES / 3)),
          ),
        };
        if (generation !== this.generation) return;
      }
      if (result.error) throw result.error;
      if (!result.bytes) return;
      const buffer = await this.audio.decode(result.bytes);
      if (generation !== this.generation) return;
      this.buffer = buffer;
      this.start(generation);
    } catch (error) {
      this.fail(generation, error);
    }
  }
  private start(generation: number) {
    this.audio.play(this.buffer!, this.offset, () => {
      if (generation !== this.generation || this.state !== "playing") return;
      this.buffer = undefined;
      this.offset = 0;
      if (this.index + 1 >= this.segments.length) {
        this.invalidate();
        this.publish("finished");
      } else {
        this.index++;
        this.publish("preparing");
        void this.load(generation);
      }
    });
    this.publish("playing");
    if (
      this.enablePrefetch &&
      this.index + 1 < this.segments.length &&
      !this.prefetch
    ) {
      const decodedBytes =
        this.buffer!.length * this.buffer!.numberOfChannels * 4;
      // Allow for both streamed chunks and their assembled ArrayBuffer.
      const maxBytes = Math.min(
        MAX_AUDIO_BYTES,
        Math.floor(MAX_BUFFER_BYTES / 3),
        Math.floor((MAX_BUFFER_BYTES - decodedBytes) / 2),
      );
      if (maxBytes >= 44) {
        const index = this.index + 1;
        this.prefetch = {
          index,
          result: this.request(index, generation, maxBytes).then(
            (bytes) => ({ bytes }),
            (error) => ({ error }),
          ),
        };
      }
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
