import type { Settings } from "./settings";

export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;

export async function fetchSpeech(
  settings: Settings,
  text: string,
  signal: AbortSignal,
  fetcher = fetch,
): Promise<ArrayBuffer> {
  if (!text.trim() || Array.from(text).length > 4096)
    throw new Error("Choose a shorter, nonempty passage.");
  const response = await fetcher(`${settings.baseUrl}/v1/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "kokoro",
      input: text,
      voice: settings.voice,
      speed: settings.speed,
      response_format: "wav",
    }),
    signal,
  });
  if (!response.ok) {
    if (response.status === 401)
      throw new Error("The server token is incorrect. Open Settings.");
    if (response.status === 429)
      throw new Error("The speech server is busy. Try again shortly.");
    throw new Error(`Speech generation failed (${response.status}).`);
  }
  if (
    !response.headers.get("content-type")?.includes("audio/wav") ||
    !response.body
  )
    throw new Error("The server did not return WAV audio.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AUDIO_BYTES)
        throw new Error(
          "The generated audio is too large. Choose a shorter passage.",
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
