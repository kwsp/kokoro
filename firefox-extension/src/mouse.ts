import { HOST_ID } from "./controls";
import { HoverHighlight } from "./highlighting";
import { readableText, type ReadingSegment } from "./mapping";

// Editors and focusable/delegated-handler containers can contain ordinary prose.
// Preserve concrete controls while click mode explicitly owns prose clicks.
const INTERACTIVE = `a,button,input,textarea,select,option,label,summary,audio,video,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="slider"],[role="combobox"],#${HOST_ID}`;

export function ordinaryPointer(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

export function readableTarget(
  target: EventTarget | null,
  document: Document,
): boolean {
  const element = target instanceof Element ? target : null;
  return Boolean(
    element &&
    element.getRootNode() === document &&
    !element.closest(INTERACTIVE),
  );
}

/** Caret offsets alone also match nearby whitespace; require a text rectangle. */
export function segmentAtPoint(
  document: Document,
  segments: readonly ReadingSegment[],
  x: number,
  y: number,
): number | undefined {
  const caret = document.caretPositionFromPoint?.(x, y);
  if (
    !caret ||
    caret.offsetNode.nodeType !== Node.TEXT_NODE ||
    !caret.offsetNode.isConnected ||
    !readableText(caret.offsetNode as Text, "selection")
  )
    return;
  const index = segments.findIndex((segment) =>
    segment.ranges.some(
      (range) =>
        range.startContainer.isConnected &&
        range.endContainer.isConnected &&
        range.isPointInRange(caret.offsetNode, caret.offset) &&
        [...range.getClientRects()].some(
          (rect) =>
            rect.width > 0 &&
            rect.height > 0 &&
            x >= rect.left &&
            x <= rect.right &&
            y >= rect.top &&
            y <= rect.bottom,
        ),
    ),
  );
  return index < 0 ? undefined : index;
}

function selectionPosition(document: Document) {
  const selection = document.getSelection();
  return selection
    ? {
        anchor: selection.anchorNode,
        anchorOffset: selection.anchorOffset,
        focus: selection.focusNode,
        focusOffset: selection.focusOffset,
        collapsed: selection.isCollapsed,
      }
    : undefined;
}

interface Preview {
  show(segment?: ReadingSegment): void;
  close(): void;
}

export interface ClickScope {
  segments: readonly ReadingSegment[];
  seek(index: number): void;
}

interface ClickReaderOptions {
  preview?: Preview;
  hitTest?: typeof segmentAtPoint;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
  scopeForTarget?: (target: Element) => ClickScope | undefined;
  unavailable?: () => void;
  available?: () => void;
}

export class ClickReader {
  private enabled = false;
  private frame?: number;
  private hoverGeneration = 0;
  private pending?: { x: number; y: number; target: EventTarget | null };
  private down?: {
    x: number;
    y: number;
    dragged: boolean;
    selection: ReturnType<typeof selectionPosition>;
  };
  private preview: Preview;
  private hitTest: typeof segmentAtPoint;
  private requestFrame: (callback: FrameRequestCallback) => number;
  private cancelFrame: (id: number) => void;

  constructor(
    private document: Document,
    private segments: () => readonly ReadingSegment[],
    private seek: (index: number) => void,
    private modeChanged: (enabled: boolean) => void,
    private options: ClickReaderOptions = {},
  ) {
    this.preview = options.preview ?? new HoverHighlight();
    this.hitTest = options.hitTest ?? segmentAtPoint;
    this.requestFrame =
      options.requestFrame ??
      ((callback) => window.requestAnimationFrame(callback));
    this.cancelFrame =
      options.cancelFrame ?? ((id) => window.cancelAnimationFrame(id));
    document.addEventListener("mousedown", this.onDown, true);
    document.addEventListener("mousemove", this.onMove, true);
    document.addEventListener("click", this.onClick, true);
    document.addEventListener("mouseout", this.onOut);
    document.addEventListener("scroll", this.onLeave, true);
    document.addEventListener("keydown", this.onKey, true);
    document.defaultView?.addEventListener("blur", this.onLeave);
    document.defaultView?.addEventListener("resize", this.onLeave);
  }

  get isEnabled() {
    return this.enabled;
  }

  private scopeFor(target: EventTarget | null): ClickScope | undefined {
    if (!(target instanceof Element)) return;
    return this.options.scopeForTarget
      ? this.options.scopeForTarget(target)
      : { segments: this.segments(), seek: this.seek };
  }

  toggle() {
    this.enabled = !this.enabled;
    this.reset();
    this.modeChanged(this.enabled);
  }

  clearPreview() {
    this.hoverGeneration++;
    if (this.frame !== undefined) this.cancelFrame(this.frame);
    this.frame = undefined;
    this.pending = undefined;
    this.preview.show();
  }

  reset() {
    this.down = undefined;
    this.clearPreview();
  }

  private onDown = (event: MouseEvent) => {
    this.down = undefined;
    if (
      !this.enabled ||
      !ordinaryPointer(event) ||
      !readableTarget(event.target, this.document)
    )
      return;
    this.down = {
      x: event.clientX,
      y: event.clientY,
      dragged: false,
      selection: selectionPosition(this.document),
    };
  };

  private onMove = (event: MouseEvent) => {
    if (!this.enabled) return;
    if (
      this.down &&
      Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > 5
    )
      this.down.dragged = true;
    if (
      event.buttons ||
      !ordinaryPointer(event) ||
      !readableTarget(event.target, this.document)
    ) {
      this.clearPreview();
      return;
    }
    this.pending = { x: event.clientX, y: event.clientY, target: event.target };
    if (this.frame !== undefined) return;
    const generation = this.hoverGeneration;
    this.frame = this.requestFrame(() => {
      if (generation !== this.hoverGeneration) return;
      this.frame = undefined;
      const pending = this.pending;
      this.pending = undefined;
      if (
        !this.enabled ||
        !pending ||
        !readableTarget(pending.target, this.document)
      )
        return;
      const scope = this.scopeFor(pending.target);
      const index = scope
        ? this.hitTest(this.document, scope.segments, pending.x, pending.y)
        : undefined;
      if (index !== undefined) this.options.available?.();
      this.preview.show(
        index === undefined ? undefined : scope?.segments[index],
      );
    });
  };

  private onClick = (event: MouseEvent) => {
    const down = this.down;
    this.down = undefined;
    if (
      !this.enabled ||
      !down ||
      down.dragged ||
      Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5 ||
      event.detail !== 1 ||
      event.defaultPrevented ||
      !ordinaryPointer(event) ||
      !readableTarget(event.target, this.document)
    )
      return;
    const selection = selectionPosition(this.document);
    if (
      selection &&
      !selection.collapsed &&
      (selection.anchor !== down.selection?.anchor ||
        selection.anchorOffset !== down.selection?.anchorOffset ||
        selection.focus !== down.selection?.focus ||
        selection.focusOffset !== down.selection?.focusOffset)
    )
      return;
    const scope = this.scopeFor(event.target);
    const index = scope
      ? this.hitTest(
          this.document,
          scope.segments,
          event.clientX,
          event.clientY,
        )
      : undefined;
    if (!scope || index === undefined) {
      this.options.unavailable?.();
      return;
    }
    this.options.available?.();
    event.preventDefault();
    event.stopPropagation();
    this.clearPreview();
    // Preserve the click's user activation through the synchronous seek call.
    scope.seek(index);
  };

  private onKey = (event: KeyboardEvent) => {
    if (this.enabled && event.key === "Escape") this.toggle();
  };

  private onLeave = () => this.reset();
  private onOut = (event: MouseEvent) => {
    if (!event.relatedTarget) this.reset();
  };

  close() {
    this.enabled = false;
    this.reset();
    this.preview.close();
    this.document.removeEventListener("mousedown", this.onDown, true);
    this.document.removeEventListener("mousemove", this.onMove, true);
    this.document.removeEventListener("click", this.onClick, true);
    this.document.removeEventListener("mouseout", this.onOut);
    this.document.removeEventListener("scroll", this.onLeave, true);
    this.document.removeEventListener("keydown", this.onKey, true);
    this.document.defaultView?.removeEventListener("blur", this.onLeave);
    this.document.defaultView?.removeEventListener("resize", this.onLeave);
  }
}
