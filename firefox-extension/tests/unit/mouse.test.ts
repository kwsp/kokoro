import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoverHighlight } from "../../src/highlighting";
import { segmentsFromRanges } from "../../src/mapping";
import {
  ClickReader,
  ordinaryPointer,
  readableTarget,
  segmentAtPoint,
} from "../../src/mouse";

beforeEach(() => {
  document.body.innerHTML =
    "<article><p>First <em>sentence.</em> Second sentence.</p></article>";
  document.getSelection()?.removeAllRanges();
});
afterEach(() => vi.unstubAllGlobals());

function segments() {
  const range = document.createRange();
  range.selectNodeContents(document.querySelector("p")!);
  return segmentsFromRanges([range]);
}
function mouse(target: EventTarget, type: string, init: MouseEventInit = {}) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 20,
    clientY: 20,
    detail: 1,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}
function fixture() {
  const values = segments();
  const preview = { show: vi.fn(), close: vi.fn() };
  const seek = vi.fn();
  const changed = vi.fn();
  const hit = vi.fn<typeof segmentAtPoint>(() => 1);
  const frames: FrameRequestCallback[] = [];
  const request = vi.fn((callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  const cancel = vi.fn();
  const reader = new ClickReader(
    document,
    () => values,
    seek,
    changed,
    preview,
    hit,
    request,
    cancel,
  );
  return {
    reader,
    values,
    preview,
    seek,
    changed,
    hit,
    frames,
    request,
    cancel,
    p: document.querySelector("p")!,
  };
}

describe("pointer policy", () => {
  it.each(["altKey", "ctrlKey", "metaKey", "shiftKey"])("ignores %s", (key) => {
    expect(ordinaryPointer(new MouseEvent("click", { [key]: true }))).toBe(
      false,
    );
  });
  it.each([1, 2])("ignores mouse button %s", (button) => {
    expect(ordinaryPointer(new MouseEvent("click", { button }))).toBe(false);
  });
  it.each([
    '<a href="#"><span>Link</span></a>',
    "<button><span>Button</span></button>",
    "<input>",
    "<textarea></textarea>",
    "<label>Label</label>",
    "<summary>Summary</summary>",
    '<span contenteditable="true">Editor</span>',
    '<span role="button">Button</span>',
    '<span role="slider">Slider</span>',
    '<span tabindex="0">Focusable</span>',
    '<span onclick="void 0">Handler</span>',
    '<span draggable="true">Drag</span>',
    '<div id="kokoro-reader-controls">Controls</div>',
  ])("preserves interactive targets: %s", (html) => {
    document.body.innerHTML = html;
    expect(
      readableTarget(
        document.body.firstElementChild!.lastElementChild ??
          document.body.firstElementChild,
        document,
      ),
    ).toBe(false);
  });
  it("allows ordinary prose under a skip-link target but excludes shadow roots", () => {
    document.body.innerHTML =
      '<main tabindex="-1"><p>Prose.</p></main><div id="shadow"></div>';
    expect(readableTarget(document.querySelector("p"), document)).toBe(true);
    const root = document
      .getElementById("shadow")!
      .attachShadow({ mode: "open" });
    root.innerHTML = "<p>Private shadow prose.</p>";
    expect(readableTarget(root.querySelector("p"), document)).toBe(false);
  });
});

describe("caret and rendered text hit testing", () => {
  it("finds an inline sentence only within its actual text rectangles", () => {
    const values = segments();
    const text = document.querySelector("em")!.firstChild!;
    Object.defineProperty(document, "caretPositionFromPoint", {
      configurable: true,
      value: () => ({ offsetNode: text, offset: 4 }),
    });
    for (const value of values)
      for (const range of value.ranges)
        range.getClientRects = () =>
          [
            { left: 10, right: 70, top: 10, bottom: 30, width: 60, height: 20 },
          ] as unknown as DOMRectList;
    expect(segmentAtPoint(document, values, 20, 20)).toBe(0);
    expect(segmentAtPoint(document, values, 200, 20)).toBeUndefined();
    expect(segmentAtPoint(document, values, 20, 40)).toBeUndefined();
  });
  it("ignores missing carets, element carets, detached and hidden text", () => {
    const values = segments();
    const node = document.querySelector("p")!.firstChild!;
    let caret: { offsetNode: Node; offset: number } | null = null;
    Object.defineProperty(document, "caretPositionFromPoint", {
      configurable: true,
      value: () => caret,
    });
    expect(segmentAtPoint(document, values, 20, 20)).toBeUndefined();
    caret = { offsetNode: document.body, offset: 0 };
    expect(segmentAtPoint(document, values, 20, 20)).toBeUndefined();
    caret = { offsetNode: node, offset: 1 };
    document.querySelector("p")!.hidden = true;
    expect(segmentAtPoint(document, values, 20, 20)).toBeUndefined();
    node.parentNode!.removeChild(node);
    expect(segmentAtPoint(document, values, 20, 20)).toBeUndefined();
  });
});

describe("explicit click mode", () => {
  it("calls native animation-frame methods with their Window receiver", () => {
    const request = vi.fn(function (
      this: Window,
      callback: FrameRequestCallback,
    ) {
      expect(this).toBe(window);
      expect(callback).toBeTypeOf("function");
      return 7;
    });
    const cancel = vi.fn(function (this: Window, id: number) {
      expect(this).toBe(window);
      expect(id).toBe(7);
    });
    vi.stubGlobal("requestAnimationFrame", request);
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const reader = new ClickReader(document, segments, vi.fn(), vi.fn(), {
      show: vi.fn(),
      close: vi.fn(),
    });
    reader.toggle();
    mouse(document.querySelector("p")!, "mousemove");
    expect(request).toHaveBeenCalledOnce();
    reader.reset();
    expect(cancel).toHaveBeenCalledWith(7);
    reader.close();
  });
  it("leaves ordinary clicks untouched until enabled, then seeks synchronously", () => {
    const { reader, p, seek, changed } = fixture();
    mouse(p, "mousedown");
    expect(mouse(p, "click").defaultPrevented).toBe(false);
    expect(seek).not.toHaveBeenCalled();
    reader.toggle();
    expect(changed).toHaveBeenCalledWith(true);
    mouse(p, "mousedown");
    expect(mouse(p, "click").defaultPrevented).toBe(true);
    expect(seek).toHaveBeenCalledWith(1);
    reader.close();
  });
  it("does not seek without a pointer down, from keyboard clicks, or outside text", () => {
    const { reader, p, seek, hit } = fixture();
    reader.toggle();
    mouse(p, "click");
    mouse(p, "mousedown");
    mouse(p, "click", { detail: 0 });
    hit.mockReturnValue(undefined);
    mouse(p, "mousedown");
    expect(mouse(p, "click").defaultPrevented).toBe(false);
    expect(seek).not.toHaveBeenCalled();
    reader.close();
  });
  it("preserves modified clicks and drags even when the pointer returns to its start", () => {
    const { reader, p, seek } = fixture();
    reader.toggle();
    mouse(p, "mousedown");
    expect(mouse(p, "click", { ctrlKey: true }).defaultPrevented).toBe(false);
    mouse(p, "mousedown");
    mouse(p, "mousemove", { clientX: 40, buttons: 1 });
    mouse(p, "mousemove", { buttons: 1 });
    expect(mouse(p, "click").defaultPrevented).toBe(false);
    expect(seek).not.toHaveBeenCalled();
    reader.close();
  });
  it("preserves a selection changed by a tiny drag", () => {
    const { reader, p, seek } = fixture();
    reader.toggle();
    mouse(p, "mousedown");
    const range = document.createRange();
    range.setStart(p.firstChild!, 0);
    range.setEnd(p.firstChild!, 1);
    document.getSelection()!.addRange(range);
    expect(mouse(p, "click").defaultPrevented).toBe(false);
    expect(seek).not.toHaveBeenCalled();
    reader.close();
  });
  it("coalesces hover work and ignores canceled callbacks after reset or Escape", () => {
    const { reader, p, preview, request, frames, changed, hit } = fixture();
    reader.toggle();
    preview.show.mockClear();
    mouse(p, "mousemove", { clientX: 20 });
    mouse(p, "mousemove", { clientX: 22 });
    expect(request).toHaveBeenCalledOnce();
    frames[0]!(0);
    expect(hit.mock.calls[0]?.[2]).toBe(22);
    expect(preview.show).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "Second sentence." }),
    );
    mouse(p, "mousemove");
    reader.reset();
    mouse(p, "mousemove");
    frames[1]!(0);
    expect(preview.show).toHaveBeenLastCalledWith();
    frames[2]!(0);
    expect(preview.show).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "Second sentence." }),
    );
    mouse(p, "mousemove");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    frames[3]!(0);
    expect(changed).toHaveBeenLastCalledWith(false);
    expect(preview.show).toHaveBeenLastCalledWith();
    reader.close();
  });
  it("clears preview on interactive hover, scrolling and Close without touching playback", () => {
    const { reader, p, preview, seek, frames } = fixture();
    reader.toggle();
    mouse(p, "mousemove");
    frames[0]!(0);
    const link = document.createElement("a");
    p.append(link);
    mouse(link, "mousemove");
    expect(preview.show).toHaveBeenLastCalledWith();
    document.dispatchEvent(new Event("scroll"));
    reader.close();
    mouse(p, "mousedown");
    mouse(p, "click");
    expect(seek).not.toHaveBeenCalled();
    expect(preview.close).toHaveBeenCalledOnce();
  });
});

describe("hover marks", () => {
  it("keeps speaking and page-owned marks while showing a lower-priority preview", () => {
    const highlights = new Map<string, unknown>([
      ["kokoro-speaking", "speech"],
      ["page-owned", "keep"],
    ]);
    vi.stubGlobal("CSS", { highlights });
    vi.stubGlobal(
      "Highlight",
      class {
        priority = 0;
        constructor(public ranges: unknown) {}
      },
    );
    const preview = new HoverHighlight();
    preview.show(segments()[0]);
    expect(highlights.get("kokoro-hover")).toMatchObject({ priority: -1 });
    preview.close();
    expect([...highlights.entries()]).toEqual([
      ["kokoro-speaking", "speech"],
      ["page-owned", "keep"],
    ]);
  });
});
