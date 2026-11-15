import { createRuntimeTransport } from "./speech/runtime-transport";
import { WebAudioPlayer } from "./speech/audio";
import {
  editorRootFor,
  extractEditor,
  extractPage,
  type ReadingDocument,
} from "./reading/extraction";
import { createControls, HOST_ID } from "./ui/controls";
import { SpeakingHighlight } from "./reading/highlighting";
import {
  captureSelection,
  segmentsFromRanges,
  type ReadingSegment,
} from "./reading/mapping";
import { ReadingSession, createRequestId } from "./speech/session";
import { watchSource, sameRanges } from "./reading/source-watch";
import { watchSelection } from "./reading/selection";
import { ClickReader, type ClickScope } from "./reading/mouse";

if (!document.getElementById(HOST_ID)) mount();

function mount() {
  let segments: ReadingSegment[] = [];
  let extractionError: string | undefined;
  const sessionId = createRequestId();
  let scopeRanges: Range[] = [];
  let pendingRanges: Range[] = [];
  let selectionScope = false;
  let editorRoot: Element | undefined;
  let editorPreview: ReadingDocument | undefined;
  let unwatchPreview: (() => void) | undefined;
  let invalidated = false;
  let unwatch: (() => void) | undefined;
  let closed = false;
  const highlight = new SpeakingHighlight();
  const session = new ReadingSession(
    segments,
    new WebAudioPlayer(),
    createRuntimeTransport(sessionId),
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
      prepareReading();
      if (segments.length) session.play();
    },
    pause: () => session.pause(),
    stop: () => {
      clickReader.clearPreview();
      session.stop();
    },
    clickMode: () => {
      if (!clickReader.isEnabled) prepareReading();
      clickReader.toggle();
    },
    settings: () => {
      void browser.runtime.sendMessage({ type: "settings:open" });
    },
    close,
  });
  const clickReader = new ClickReader(
    document,
    controls.host,
    () => segments,
    (index) => session.seek(index),
    (enabled) => {
      if (!enabled) clearEditorPreview();
      controls.setClickMode(enabled);
    },
    {
      scopeForTarget: clickScope,
      available: () => controls.setClickFeedback(),
      unavailable: () =>
        controls.setClickFeedback(
          "No readable sentence here. Try selecting a passage.",
        ),
    },
  );
  const stopWatchingSelection = watchSelection(
    document,
    controls.host,
    (ranges) => {
      pendingRanges =
        isNewSelection(ranges) && segmentsFromRanges(ranges).length
          ? ranges
          : [];
      controls.setSelectionAvailable(pendingRanges.length > 0);
    },
  );

  function isNewSelection(ranges: readonly Range[]) {
    return (
      ranges.length > 0 && (!selectionScope || !sameRanges(ranges, scopeRanges))
    );
  }

  function prepareReading() {
    const ranges = pendingRanges.length
      ? pendingRanges
      : captureSelection(window.getSelection());
    if (isNewSelection(ranges)) {
      selectionScope = true;
      editorRoot = undefined;
      scopeRanges = ranges;
      refresh();
    } else if (invalidated || !segments.length) refresh();
  }

  function clearEditorPreview() {
    unwatchPreview?.();
    unwatchPreview = undefined;
    editorPreview = undefined;
  }

  function clickScope(target: Element): ClickScope {
    if (invalidated) refresh();
    const active = { segments, seek: (index: number) => session.seek(index) };
    // A chosen passage remains a strict boundary, even inside an editor.
    if (selectionScope) return active;
    const root = editorRootFor(target);
    if (!root || (root === editorRoot && segments.length)) return active;
    if (editorPreview?.root !== root) {
      clearEditorPreview();
      editorPreview = extractEditor(root);
      unwatchPreview = watchSource(
        root,
        editorPreview.segments,
        false,
        () => {
          clearEditorPreview();
          clickReader.clearPreview();
        },
        "document",
      );
    }
    return {
      segments: editorPreview.segments,
      seek: (index) => {
        editorRoot = root;
        scopeRanges = [];
        refresh();
        session.seek(index);
      },
    };
  }

  function refresh() {
    unwatch?.();
    clearEditorPreview();
    clickReader.reset();
    invalidated = false;
    pendingRanges = [];
    controls.setSelectionAvailable(false);
    extractionError = undefined;
    try {
      let root: Element;
      if (selectionScope) {
        segments = segmentsFromRanges(scopeRanges);
        root = document.body;
      } else if (editorRoot) {
        const reading = extractEditor(editorRoot);
        segments = reading.segments;
        root = reading.root;
      } else {
        const reading = extractPage(document);
        segments = reading.segments;
        root = reading.root;
      }
      if (!segments.length)
        extractionError =
          "No readable text selected. Select a passage, then press Read selection.";
      else
        unwatch = watchSource(
          root,
          segments,
          selectionScope,
          () => {
            invalidated = true;
            extractionError = "Page changed; press Play to refresh.";
            segments = [];
            clickReader.reset();
            session.replaceSegments([]);
          },
          editorRoot && !selectionScope ? "document" : undefined,
        );
    } catch (error) {
      segments = [];
      extractionError =
        error instanceof Error
          ? error.message
          : "Could not read this page. Select a passage, then press Read selection.";
    }
    session.replaceSegments(segments);
  }

  function activate(selectionOnly = false) {
    const current = captureSelection(window.getSelection());
    const ranges = current.length ? current : pendingRanges;
    const newSelection = isNewSelection(ranges);
    if (newSelection || selectionOnly || !segments.length) {
      selectionScope = ranges.length > 0 || selectionOnly;
      editorRoot = undefined;
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
    stopWatchingSelection();
    clearEditorPreview();
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
