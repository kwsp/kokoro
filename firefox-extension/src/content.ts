import { WebAudioPlayer } from "./audio";
import { createControls, HOST_ID } from "./controls";
import { SpeakingHighlight } from "./highlighting";
import {
  captureSelection,
  segmentsFromRanges,
  type ReadingSegment,
} from "./mapping";
import { ReadingSession } from "./session";

if (!document.getElementById(HOST_ID)) mount();

function mount() {
  let segments: ReadingSegment[] = [];
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
      controls.update(snapshot);
      highlight.show(
        snapshot.highlightedIndex === null
          ? undefined
          : segments[snapshot.highlightedIndex],
        snapshot.state === "paused",
      );
    },
  );
  const controls = createControls({
    play: () => session.play(),
    pause: () => session.pause(),
    stop: () => session.stop(),
    settings: () => {
      void browser.runtime.sendMessage({ type: "settings:open" });
    },
    close,
  });

  function activate(selectionOnly = false) {
    const ranges = captureSelection(window.getSelection());
    if (ranges.length) {
      segments = segmentsFromRanges(ranges);
      session.replaceSegments(segments);
    } else if (!segments.length || selectionOnly) {
      const target = selectionOnly
        ? null
        : document.querySelector("article p, main p");
      const range = document.createRange();
      if (target) range.selectNodeContents(target);
      segments = target ? segmentsFromRanges([range]) : [];
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
    session.close();
    highlight.close();
    controls.close();
    browser.runtime.onMessage.removeListener(onMessage);
    window.removeEventListener("pagehide", close);
  }

  browser.runtime.onMessage.addListener(onMessage);
  window.addEventListener("pagehide", close, { once: true });
}
