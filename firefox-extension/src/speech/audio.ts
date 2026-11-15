export const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export interface AudioAdapter {
  activate(): Promise<void>;
  decode(bytes: ArrayBuffer): Promise<AudioBuffer>;
  play(buffer: AudioBuffer, offset: number, ended: () => void): void;
  pause(): number;
  stop(): void;
  close(): void;
  waitForDecode?(): Promise<void>;
}

/** Reject malformed or oversized PCM WAV before allocating decoded float samples. */
export function wavDecodedBytes(bytes: ArrayBuffer): number {
  const view = new DataView(bytes);
  const tag = (offset: number) =>
    String.fromCharCode(...new Uint8Array(bytes, offset, 4));
  if (
    bytes.byteLength < 44 ||
    tag(0) !== "RIFF" ||
    tag(8) !== "WAVE" ||
    view.getUint32(4, true) + 8 !== bytes.byteLength
  )
    throw new Error("The server returned invalid WAV audio.");
  let validFormat = false;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size;
    if (end > bytes.byteLength)
      throw new Error("The server returned truncated WAV audio.");
    if (tag(offset) === "fmt ") {
      validFormat =
        size >= 16 &&
        view.getUint16(offset + 8, true) === 1 &&
        view.getUint16(offset + 10, true) === 1 &&
        view.getUint32(offset + 12, true) === 24000 &&
        view.getUint16(offset + 22, true) === 16;
    }
    if (tag(offset) === "data") dataBytes += size;
    offset = end + (size % 2);
  }
  if (!validFormat || !dataBytes || dataBytes % 2)
    throw new Error("Expected 24 kHz mono PCM WAV from the speech server.");
  return dataBytes * 2;
}

export class WebAudioPlayer implements AudioAdapter {
  private context?: AudioContext;
  private source?: AudioBufferSourceNode;
  private startedAt = 0;
  private offset = 0;
  private decoding: Promise<void> = Promise.resolve();

  constructor(
    private createContext = () => new AudioContext({ sampleRate: 24000 }),
  ) {}

  activate(): Promise<void> {
    // Called synchronously from the user's Play/click gesture.
    this.context ??= this.createContext();
    return this.context.resume();
  }

  waitForDecode(): Promise<void> {
    return this.decoding.then(
      () => {},
      () => {},
    );
  }

  async decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
    if (!this.context) throw new Error("Press Play to enable audio.");
    const rawBytes = bytes.byteLength;
    if (rawBytes + wavDecodedBytes(bytes) > MAX_BUFFER_BYTES)
      throw new Error("The generated audio exceeds the playback memory limit.");
    let buffer: AudioBuffer;
    try {
      const decoding = this.context.decodeAudioData(bytes);
      this.decoding = decoding.then(
        () => {},
        () => {},
      );
      buffer = await decoding;
    } catch {
      throw new Error(
        "The server returned audio that Firefox could not decode. Retry this sentence.",
      );
    }
    if (
      rawBytes + buffer.length * buffer.numberOfChannels * 4 >
      MAX_BUFFER_BYTES
    )
      throw new Error("The generated audio exceeds the playback memory limit.");
    return buffer;
  }

  play(buffer: AudioBuffer, offset: number, ended: () => void): void {
    if (!this.context) throw new Error("Press Play to enable audio.");
    this.stop();
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = () => {
      if (this.source !== source) return;
      this.source = undefined;
      source.disconnect();
      ended();
    };
    this.source = source;
    this.offset = offset;
    this.startedAt = this.context.currentTime;
    source.start(0, offset);
  }

  pause(): number {
    const offset =
      this.source && this.context
        ? Math.min(
            this.source.buffer!.duration,
            this.offset + this.context.currentTime - this.startedAt,
          )
        : this.offset;
    this.stop();
    return offset;
  }

  stop(): void {
    if (!this.source) return;
    this.source.onended = null;
    this.source.stop();
    this.source.disconnect();
    this.source = undefined;
  }

  close(): void {
    this.stop();
    void this.context?.close();
    this.context = undefined;
  }
}
