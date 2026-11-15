import type { SpeechTransport } from "./session";

export function createRuntimeTransport(sessionId: string): SpeechTransport {
  return {
    async claim(leaseId) {
      const result = (await browser.runtime.sendMessage({
        type: "reader:claim",
        sessionId,
        leaseId,
      })) as { ok: boolean; error?: string };
      if (!result?.ok)
        throw new Error(result?.error ?? "Could not start reading. Retry.");
    },
    release(leaseId) {
      void browser.runtime
        .sendMessage({ type: "reader:release", sessionId, leaseId })
        .catch(() => {});
    },
    async fetch(text, requestId, leaseId, maxBytes) {
      const result = (await browser.runtime.sendMessage({
        type: "speech:generate",
        text,
        requestId,
        sessionId,
        leaseId,
        maxBytes,
      })) as { ok: boolean; audio?: ArrayBuffer; error?: string };
      if (!result?.ok || !(result.audio instanceof ArrayBuffer))
        throw new Error(
          result?.error ?? "No audio received. Retry this sentence.",
        );
      return result.audio;
    },
    cancel(requestId, leaseId) {
      void browser.runtime
        .sendMessage({ type: "speech:cancel", requestId, sessionId, leaseId })
        .catch(() => {});
    },
  };
}
