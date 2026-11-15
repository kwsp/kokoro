import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoverHighlight } from "../../src/reading/highlighting";
import { segmentsFromRanges } from "../../src/reading/mapping";
import {
  ClickReader,
  ordinaryPointer,
  readableTarget,
  segmentAtPoint,
} from "../../src/reading/mouse";

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
function fixture(options: ConstructorParameters<typeof ClickReader>[4] = {}) {
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
  const reader = new ClickReader(document, () => values, seek, changed, {
    preview,
    hitTest: hit,
    requestFrame: request,
    cancelFrame: cancel,
    ...options,
  });
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
    '<span role="button">Button</span>',
    '<span role="slider">Slider</span>',
    '<span role="link">Link</span>',
    '<span role="checkbox">Checkbox</span>',
    '<span role="radio">Radio</span>',
    '<span role="switch">Switch</span>',
    '<span role="combobox">Combobox</span>',
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
  it.each([
    '<div contenteditable="true" role="textbox"><p>Editor prose.</p></div>',
    '<main tabindex="0"><p>Focusable prose.</p></main>',
    '<div onclick="void 0"><p>Delegated prose.</p></div>',
    '<div draggable="true"><p>Movable document block.</p></div>',
  ])("permits prose in application containers: %s", (html) => {
    document.body.innerHTML = html;
    expect(readableTarget(document.querySelector("p"), document)).toBe(true);
  });
  it("still protects controls nested inside editable or focusable containers", () => {
    document.body.innerHTML =
      '<main tabindex="0"><div contenteditable="true"><a href="#"><span>Link</span></a><button>Action</button><span role="button">Custom action</span></div></main>';
    for (const element of document.querySelectorAll(
      "a span,button,[role=button]",
    ))
      expect(readableTarget(element, document)).toBe(false);
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
  it.each(["article", "aside", "nav", "footer"])(
    "finds a selected inline sentence in %s only within its text rectangles",
    (tag) => {
      document.body.innerHTML = `<${tag}><p>First <em>sentence.</em> Second sentence.</p></${tag}>`;
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
              {
                left: 10,
                right: 70,
                top: 10,
                bottom: 30,
                width: 60,
                height: 20,
              },
            ] as unknown as DOMRectList;
      expect(segmentAtPoint(document, values, 20, 20)).toBe(0);
      expect(segmentAtPoint(document, values, 200, 20)).toBeUndefined();
      expect(segmentAtPoint(document, values, 20, 40)).toBeUndefined();
    },
  );
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
      preview: { show: vi.fn(), close: vi.fn() },
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
    expect(reader.isEnabled).toBe(false);
    reader.toggle();
    expect(reader.isEnabled).toBe(true);
    expect(changed).toHaveBeenCalledWith(true);
    mouse(p, "mousedown");
    expect(mouse(p, "click").defaultPrevented).toBe(true);
    expect(seek).toHaveBeenCalledWith(1);
    reader.close();
    expect(reader.isEnabled).toBe(false);
  });
  it("does not seek without a pointer down, from keyboard/double clicks, or outside text", () => {
    const { reader, p, seek, hit } = fixture();
    reader.toggle();
    mouse(p, "click");
    mouse(p, "mousedown");
    mouse(p, "click", { detail: 0 });
    mouse(p, "mousedown");
    mouse(p, "click", { detail: 2 });
    hit.mockReturnValue(undefined);
    mouse(p, "mousedown");
    expect(mouse(p, "click").defaultPrevented).toBe(false);
    expect(seek).not.toHaveBeenCalled();
    reader.close();
  });
  it("resolves a transient editor scope for preview and resolves again before synchronous activation", () => {
    const values = segments();
    const oldSeek = vi.fn();
    const newSeek = vi.fn();
    let scope = { segments: values, seek: oldSeek };
    const resolve = vi.fn(() => scope);
    const { reader, p, preview, seek, frames } = fixture({
      scopeForTarget: resolve,
    });
    p.setAttribute("contenteditable", "true");
    reader.toggle();
    mouse(p, "mousemove");
    frames[0]!(0);
    expect(resolve).toHaveBeenCalledWith(p);
    expect(preview.show).toHaveBeenLastCalledWith(values[1]);
    expect(oldSeek).not.toHaveBeenCalled();
    expect(seek).not.toHaveBeenCalled();
    scope = { segments: values, seek: newSeek };
    expect(mouse(p, "mousedown").defaultPrevented).toBe(false);
    expect(mouse(p, "click").defaultPrevented).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(newSeek).toHaveBeenCalledWith(1);
    expect(oldSeek).not.toHaveBeenCalled();
    expect(seek).not.toHaveBeenCalled();
    reader.close();
  });
  it("clears targeting feedback only after finding readable text", () => {
    const available = vi.fn();
    const unavailable = vi.fn();
    const { reader, p, hit, frames } = fixture({ available, unavailable });
    reader.toggle();
    hit.mockReturnValue(undefined);
    mouse(p, "mousedown");
    mouse(p, "click");
    expect(unavailable).toHaveBeenCalledOnce();
    mouse(p, "mousemove");
    frames.at(-1)!(0);
    expect(available).not.toHaveBeenCalled();
    hit.mockReturnValue(0);
    mouse(p, "mousemove");
    frames.at(-1)!(0);
    expect(available).toHaveBeenCalledOnce();
    mouse(p, "mousedown");
    mouse(p, "click");
    expect(available).toHaveBeenCalledTimes(2);
    reader.close();
  });
  it.each(["missing scope", "outside text"])(
    "reports %s only on an eligible ordinary click",
    (kind) => {
      const unavailable = vi.fn();
      const options =
        kind === "missing scope"
          ? { scopeForTarget: () => undefined, unavailable }
          : { unavailable };
      const { reader, p, hit, frames, seek } = fixture(options);
      hit.mockReturnValue(undefined);
      reader.toggle();
      mouse(p, "mousemove");
      frames[0]!(0);
      expect(unavailable).not.toHaveBeenCalled();
      mouse(p, "mousedown");
      expect(mouse(p, "click").defaultPrevented).toBe(false);
      expect(unavailable).toHaveBeenCalledOnce();
      const button = document.createElement("button");
      p.append(button);
      mouse(button, "mousedown");
      mouse(button, "click");
      mouse(p, "mousedown");
      mouse(p, "click", { ctrlKey: true });
      expect(unavailable).toHaveBeenCalledOnce();
      expect(seek).not.toHaveBeenCalled();
      reader.close();
    },
  );
  it("returns editable prose clicks to the page immediately on Escape", () => {
    const { reader, p, seek } = fixture();
    p.setAttribute("contenteditable", "true");
    reader.toggle();
    expect(mouse(p, "mousedown").defaultPrevented).toBe(false);
    expect(mouse(p, "click").defaultPrevented).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(reader.isEnabled).toBe(false);
    expect(mouse(p, "mousedown").defaultPrevented).toBe(false);
    expect(mouse(p, "click").defaultPrevented).toBe(false);
    expect(seek).toHaveBeenCalledOnce();
    expect(p.getAttribute("contenteditable")).toBe("true");
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
