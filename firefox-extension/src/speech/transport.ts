import type { Settings } from "../settings";

export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const BUSY_RETRY_WINDOW_MS = 5_000;
const MIN_BUSY_DELAY_MS = 250;

export function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function fetchSpeech(
  settings: Settings,
  text: string,
  signal: AbortSignal,
  fetcher = fetch,
  maxBytes = MAX_AUDIO_BYTES,
  delay = abortableDelay,
  now = () => performance.now(),
): Promise<ArrayBuffer> {
  if (!text.trim() || Array.from(text).length > 4096)
    throw new Error("Choose a shorter, nonempty passage.");
  signal.throwIfAborted();
  let response: Response;
  let retryDeadline: number | undefined;
  for (;;) {
    response = await fetcher(`${settings.baseUrl}/v1/audio/speech`, {
      method: "POST",
      redirect: "error",
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
    if (response.status !== 429) break;
    retryDeadline ??= now() + BUSY_RETRY_WINDOW_MS;
    const retry = response.headers.get("retry-after");
    const seconds = retry === null ? 0.25 : Number(retry);
    const milliseconds = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1000)
      : Math.max(0, Date.parse(retry!) - Date.now());
    const wait = Math.max(MIN_BUSY_DELAY_MS, milliseconds);
    if (!Number.isFinite(wait) || wait >= retryDeadline - now()) break;
    await response.body?.cancel();
    await delay(wait, signal);
    signal.throwIfAborted();
    if (now() >= retryDeadline) break;
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401)
      throw new Error("The server token is incorrect. Open Settings.");
    if (response.status === 429)
      throw new Error("The speech server is busy. Try again shortly.");
    throw new Error(`Speech generation failed (${response.status}).`);
  }
  if (
    !response.headers.get("content-type")?.includes("audio/wav") ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error("The server did not return WAV audio.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > Math.min(maxBytes, MAX_AUDIO_BYTES))
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
