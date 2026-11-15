import type { ReadingSegment } from "./mapping";

export class SpeakingHighlight {
  private style = document.createElement("style");

  constructor() {
    this.style.textContent =
      "::highlight(kokoro-speaking){background-color:#ffe39a;color:#17252c}::highlight(kokoro-paused){background-color:#dce8ee;color:#17252c}";
    document.documentElement.append(this.style);
  }

  show(segment?: ReadingSegment, paused = false) {
    this.clear();
    if (!segment || !CSS.highlights || typeof Highlight === "undefined") return;
    CSS.highlights.set(
      paused ? "kokoro-paused" : "kokoro-speaking",
      new Highlight(...segment.ranges),
    );
  }

  clear() {
    CSS.highlights?.delete("kokoro-speaking");
    CSS.highlights?.delete("kokoro-paused");
  }

  close() {
    this.clear();
    this.style.remove();
  }
}
