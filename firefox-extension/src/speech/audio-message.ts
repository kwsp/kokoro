import { MAX_AUDIO_BYTES } from "./transport";

declare const __SAFARI__: boolean;

/** Safari serializes extension messages as JSON; Firefox preserves ArrayBuffers. */
export function encodeAudioMessage(audio: ArrayBuffer): ArrayBuffer | string {
  if (typeof __SAFARI__ === "undefined" || !__SAFARI__) return audio;
  const bytes = new Uint8Array(audio);
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(parts.join(""));
}

export function decodeAudioMessage(
  audio: unknown,
  maxBytes: number,
): ArrayBuffer {
  const limit = Math.min(maxBytes, MAX_AUDIO_BYTES);
  if (audio instanceof ArrayBuffer && audio.byteLength <= limit) return audio;
  if (
    typeof __SAFARI__ === "undefined" ||
    !__SAFARI__ ||
    typeof audio !== "string" ||
    audio.length > 4 * Math.ceil(limit / 3) ||
    audio.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      audio,
    )
  )
    throw new Error("No audio received. Retry this sentence.");
  const binary = atob(audio);
  if (binary.length > limit)
    throw new Error("The generated audio is too large.");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
