import { WebAudioPlayer } from "./audio";
import { extractPage } from "./extraction";
import { createControls, HOST_ID } from "./controls";
import { SpeakingHighlight } from "./highlighting";
import {
  captureSelection,
  segmentsFromRanges,
  type ReadingSegment,
} from "./mapping";
import { ReadingSession, createRequestId } from "./session";
import { watchSource, sameRanges } from "./source-watch";
import { ClickReader } from "./mouse";

if (!document.getElementById(HOST_ID)) mount();

function mount() {
  let segments: ReadingSegment[] = [];
  let extractionError: string | undefined;
  const sessionId = createRequestId();
  let scopeRanges: Range[] = [];
  let selectionScope = false;
  let invalidated = false;
  let unwatch: (() => void) | undefined;
  let closed = false;
  const highlight = new SpeakingHighlight();
  const session = new ReadingSession(
    segments,
    new WebAudioPlayer(),
    {
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
      if (invalidated) refresh();
      else if (!segments.length) activate();
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

  function refresh() {
    unwatch?.();
    clickReader.reset();
    invalidated = false;
    extractionError = undefined;
    try {
      let root: Element;
      if (selectionScope) {
        segments = segmentsFromRanges(scopeRanges);
        root = document.body;
      } else {
        const reading = extractPage(document);
        segments = reading.segments;
        root = reading.root;
      }
      if (!segments.length)
        extractionError =
          "No readable text selected. Select a passage, then activate Kokoro again.";
      else
        unwatch = watchSource(root, segments, selectionScope, () => {
          invalidated = true;
          extractionError = "Page changed; press Play to refresh.";
          segments = [];
          clickReader.reset();
          session.replaceSegments([]);
        });
    } catch (error) {
      segments = [];
      extractionError =
        error instanceof Error
          ? error.message
          : "Could not read this page. Select a passage, then activate Kokoro again.";
    }
    session.replaceSegments(segments);
  }

  function activate(selectionOnly = false) {
    const ranges = captureSelection(window.getSelection());
    const newSelection =
      ranges.length > 0 &&
      (!selectionScope || !sameRanges(ranges, scopeRanges));
    if (newSelection || selectionOnly || !segments.length) {
      selectionScope = ranges.length > 0 || selectionOnly;
      scopeRanges = ranges;
      refresh();
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
    if (value.sessionId === sessionId && typeof value.leaseId === "string") {
      if (value.type === "reader:stop") {
        clickReader.clearPreview();
        session.revoke(value.leaseId);
      }
      if (value.type === "reader:settings") {
        clickReader.clearPreview();
        session.settingsChanged();
      }
    }
  };

  function close() {
    if (closed) return;
    closed = true;
    unwatch?.();
    clickReader.close();
    session.close();
    highlight.close();
    controls.close();
    browser.runtime.onMessage.removeListener(onMessage);
    window.removeEventListener("pagehide", close);
    document.removeEventListener("visibilitychange", redraw);
  }

  const redraw = () => {
    const state = session.snapshot;
    highlight.show(
      state.highlightedIndex === null
        ? undefined
        : segments[state.highlightedIndex],
      state.state === "paused",
    );
  };
  document.addEventListener("visibilitychange", redraw);
  browser.runtime.onMessage.addListener(onMessage);
  window.addEventListener("pagehide", close, { once: true });
}
