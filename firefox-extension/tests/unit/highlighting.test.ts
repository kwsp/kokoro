import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeakingHighlight } from "../../src/reading/highlighting";

function fixture() {
  document.body.innerHTML =
    '<p style="outline: 1px dotted blue; outline-offset: 1px">Selected text.</p>';
  const block = document.querySelector("p")!;
  const range = document.createRange();
  range.selectNodeContents(block);
  window.getSelection()!.addRange(range);
  return { block, segment: { text: "Selected text.", block, ranges: [range] } };
}
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("highlight fallback", () => {
  it("outlines the current block and restores prior styles without touching selection", () => {
    vi.stubGlobal("CSS", {});
    const { block, segment } = fixture();
    const original = block.style.cssText;
    const highlight = new SpeakingHighlight();
    highlight.show(segment);
    expect(highlight.usesFallback).toBe(true);
    expect(block.style.outline).toBe("2px solid rgb(153, 82, 0)");
    expect(block.style.getPropertyPriority("outline")).toBe("important");
    highlight.show(segment, true);
    expect(block.style.outline).toBe("2px dashed rgb(70, 102, 116)");
    highlight.clear();
    expect(block.style.cssText).toBe(original);
    expect(window.getSelection()!.toString()).toBe("Selected text.");
    expect(highlight.usesFallback).toBe(false);
    highlight.close();
  });
  it("does not erase a page's later outline update", () => {
    vi.stubGlobal("CSS", {});
    const { block, segment } = fixture();
    const highlight = new SpeakingHighlight();
    highlight.show(segment);
    block.style.outline = "4px solid red";
    highlight.close();
    expect(block.style.outline).toBe("4px solid red");
    expect(block.style.outlineOffset).toBe("1px");
  });
  it("cleans up newly introduced style attributes and handles missing CSS entirely", () => {
    vi.stubGlobal("CSS", undefined);
    const { block, segment } = fixture();
    block.removeAttribute("style");
    const highlight = new SpeakingHighlight();
    highlight.show(segment);
    highlight.close();
    expect(block.hasAttribute("style")).toBe(false);
  });
});
