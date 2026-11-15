import type { ReadingSegment } from "./mapping";

interface OutlineBackup {
  element: HTMLElement;
  values: {
    property: string;
    value: string;
    priority: string;
    applied: string;
  }[];
  hadStyle: boolean;
}

export class SpeakingHighlight {
  private style = document.createElement("style");
  private outline?: OutlineBackup;

  constructor() {
    this.style.textContent =
      "::highlight(kokoro-speaking){background-color:#ffe39a;color:#17252c;text-decoration-line:underline;text-decoration-color:#995200;text-decoration-thickness:2px}::highlight(kokoro-paused){background-color:#dce8ee;color:#17252c;text-decoration-line:underline;text-decoration-style:dotted;text-decoration-color:#466674;text-decoration-thickness:2px}";
    document.documentElement.append(this.style);
  }

  get usesFallback() {
    return Boolean(this.outline);
  }

  show(segment?: ReadingSegment, paused = false) {
    this.clear();
    if (!segment) return;
    if (
      typeof CSS !== "undefined" &&
      CSS.highlights &&
      typeof Highlight !== "undefined"
    ) {
      CSS.highlights.set(
        paused ? "kokoro-paused" : "kokoro-speaking",
        new Highlight(...segment.ranges),
      );
      return;
    }
    const element = segment.block as HTMLElement;
    if (!element.style) return;
    const values = [
      {
        property: "outline",
        applied: paused ? "2px dashed #466674" : "2px solid #995200",
      },
      { property: "outline-offset", applied: "3px" },
    ].map(({ property, applied }) => ({
      property,
      applied,
      value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property),
    }));
    this.outline = { element, values, hadStyle: element.hasAttribute("style") };
    for (const entry of values) {
      element.style.setProperty(entry.property, entry.applied, "important");
      entry.applied = element.style.getPropertyValue(entry.property);
    }
  }

  clear() {
    if (typeof CSS !== "undefined") {
      CSS.highlights?.delete("kokoro-speaking");
      CSS.highlights?.delete("kokoro-paused");
    }
    if (this.outline) {
      const { element, values, hadStyle } = this.outline;
      for (const { property, value, priority, applied } of values) {
        // Preserve any subsequent page-owned update to these properties.
        if (
          element.style.getPropertyValue(property) === applied &&
          element.style.getPropertyPriority(property) === "important"
        ) {
          if (value) element.style.setProperty(property, value, priority);
          else element.style.removeProperty(property);
        }
      }
      if (!hadStyle && !element.getAttribute("style"))
        element.removeAttribute("style");
      this.outline = undefined;
    }
  }

  close() {
    this.clear();
    this.style.remove();
  }
}
