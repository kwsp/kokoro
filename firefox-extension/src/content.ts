import { WebAudioPlayer } from "./audio";
import { extractPage } from "./extraction";
import { createControls, HOST_ID } from "./controls";
import { SpeakingHighlight } from "./highlighting";
import {
  captureSelection,
  segmentsFromRanges,
  type ReadingSegment,
} from "./mapping";
import { ReadingSession } from "./session";
import { ClickReader } from "./mouse";

if (!document.getElementById(HOST_ID)) mount();

function mount() {
  let segments: ReadingSegment[] = [];
  let extractionError: string | undefined;
  const highlight = new SpeakingHighlight();
  const session = new ReadingSession(
    segments,
    new WebAudioPlayer(),
    {
      async fetch(text, requestId) {
        const result = (await browser.runtime.sendMessage({
          type: "speech:generate",
          text,
          requestId,
        })) as { ok: boolean; audio?: ArrayBuffer; error?: string };
        if (!result?.ok || !(result.audio instanceof ArrayBuffer))
          throw new Error(
            result?.error ?? "No audio received. Retry this sentence.",
          );
        return result.audio;
      },
      cancel(requestId) {
        void browser.runtime
          .sendMessage({ type: "speech:cancel", requestId })
          .catch(() => {});
      },
    },
    (snapshot) => {
      highlight.show(
        snapshot.highlightedIndex === null
          ? undefined
          : segments[snapshot.highlightedIndex],
        snapshot.state === "paused",
      );
      controls.update(
        extractionError && !snapshot.total
          ? { ...snapshot, state: "error", error: extractionError }
          : snapshot,
        highlight.usesFallback ? "Block highlight" : undefined,
      );
    },
  );
  const controls = createControls({
    play: () => {
      if (!segments.length) activate();
      if (segments.length) session.play();
    },
    pause: () => session.pause(),
    stop: () => {
      clickReader.clearPreview();
      session.stop();
    },
    clickMode: () => clickReader.toggle(),
    settings: () => {
      void browser.runtime.sendMessage({ type: "settings:open" });
    },
    close,
  });
  const clickReader = new ClickReader(
    document,
    () => segments,
    (index) => session.seek(index),
    (enabled) => controls.setClickMode(enabled),
  );

  function activate(selectionOnly = false) {
    const ranges = captureSelection(window.getSelection());
    if (ranges.length || !segments.length || selectionOnly) {
      clickReader.reset();
      extractionError = undefined;
      try {
        segments = ranges.length
          ? segmentsFromRanges(ranges)
          : selectionOnly
            ? []
            : extractPage(document).segments;
        if (!segments.length)
          extractionError =
            "No readable text selected. Select a passage, then activate Kokoro again.";
      } catch (error) {
        segments = [];
        extractionError =
          error instanceof Error
            ? error.message
            : "Could not read this page. Select a passage, then activate Kokoro again.";
      }
      session.replaceSegments(segments);
    }
    controls.focus();
  }

  const onMessage = (
    message: unknown,
    sender: browser.runtime.MessageSender,
  ) => {
    if (
      sender.id !== browser.runtime.id ||
      sender.tab ||
      !message ||
      typeof message !== "object"
    )
      return;
    const value = message as Record<string, unknown>;
    if (value.type === "reader:activate")
      activate(value.selectionOnly === true);
  };

  function close() {
    clickReader.close();
    session.close();
    highlight.close();
    controls.close();
    browser.runtime.onMessage.removeListener(onMessage);
    window.removeEventListener("pagehide", close);
  }

  browser.runtime.onMessage.addListener(onMessage);
  window.addEventListener("pagehide", close, { once: true });
}
