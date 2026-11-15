import type { AudioAdapter } from "./audio";
import type { ReadingSegment } from "./mapping";

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
  fetch(text: string, requestId: string): Promise<ArrayBuffer>;
  cancel(requestId: string): void;
}

export function createRequestId(): string {
  // getRandomValues also works on ordinary HTTP pages, unlike randomUUID.
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) =>
    value.toString(16).padStart(8, "0"),
  ).join("");
}

export class ReadingSession {
  private generation = 0;
  private requestId?: string;
  private buffer?: AudioBuffer;
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

  private invalidate() {
    this.generation++;
    if (this.requestId) this.transport.cancel(this.requestId);
    this.requestId = undefined;
    this.audio.stop();
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
    // Activation must start before this handler yields to the event loop.
    let activated: Promise<void>;
    try {
      activated = this.audio.activate();
    } catch {
      this.publish("error", "Firefox could not start audio. Press Retry.");
      return;
    }
    this.publish("preparing");
    void activated
      .then(async () => {
        if (generation !== this.generation) return;
        if (this.buffer) this.start(generation);
        else await this.load(generation);
      })
      .catch((error: unknown) => this.fail(generation, error));
  }

  private async load(generation: number) {
    const requestId = this.makeId();
    this.requestId = requestId;
    try {
      const bytes = await this.transport.fetch(
        this.segments[this.index]!.text,
        requestId,
      );
      if (generation !== this.generation) return;
      this.requestId = undefined;
      const buffer = await this.audio.decode(bytes);
      if (generation !== this.generation) return;
      this.buffer = buffer;
      this.start(generation);
    } catch (error) {
      this.fail(generation, error);
    } finally {
      if (this.requestId === requestId) this.requestId = undefined;
    }
  }

  private start(generation: number) {
    this.audio.play(this.buffer!, this.offset, () => {
      if (generation !== this.generation || this.state !== "playing") return;
      this.buffer = undefined;
      this.offset = 0;
      if (this.index + 1 >= this.segments.length) this.publish("finished");
      else {
        this.index++;
        this.publish("preparing");
        void this.load(generation);
      }
    });
    this.publish("playing");
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
    this.invalidate();
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

  close() {
    this.stop();
    this.audio.close();
  }
}
