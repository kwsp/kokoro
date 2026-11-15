export interface TextSlice {
  node: Text;
  start: number;
  end: number;
}

interface CharacterSource {
  group: number;
  node: Text;
  start: number;
  end: number;
}

export interface MappedText {
  text: string;
  characters: (CharacterSource | null)[];
}

export interface ReadingSegment {
  text: string;
  ranges: Range[];
  block: Element;
}

export const MAX_SEGMENT_CODEPOINTS = 1000;
export type TextMode = "page" | "selection" | "document";
const BLOCKS =
  "p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,dd,dt,figcaption,details,summary,div,section,article,main";
const EXCLUDED =
  'script,style,noscript,template,button,input,textarea,select,[hidden],[aria-hidden="true"],#kokoro-reader-controls';
const PAGE_EXCLUDED =
  'nav,footer,aside,[role="navigation"],[role="button"],[role="menu"],[role="toolbar"]';

function hiddenByDetails(node: Node): boolean {
  for (
    let ancestor = node.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    if (
      ancestor.matches("details:not([open])") &&
      !ancestor.querySelector(":scope > summary")?.contains(node)
    )
      return true;
  }
  return false;
}

export function readableElement(
  parent: Element,
  mode: TextMode = "page",
): boolean {
  if (parent.closest(EXCLUDED)) return false;
  if (mode !== "selection" && parent.closest(PAGE_EXCLUDED)) return false;
  if (
    mode === "page" &&
    parent.closest('[contenteditable]:not([contenteditable="false"])')
  )
    return false;
  if (hiddenByDetails(parent)) return false;
  const header = parent.closest("header");
  if (
    mode !== "selection" &&
    header &&
    !header.closest('article,main,[role="main"],[role="document"]')
  )
    return false;
  for (
    let element: Element | null = parent;
    element;
    element = element.parentElement
  ) {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (
      style?.display === "none" ||
      style?.visibility === "hidden" ||
      style?.visibility === "collapse" ||
      style?.contentVisibility === "hidden" ||
      style?.opacity === "0"
    )
      return false;
  }
  return true;
}

export function readableText(node: Text, mode: TextMode = "page"): boolean {
  if (hiddenByDetails(node)) return false;
  return Boolean(
    node.parentElement && readableElement(node.parentElement, mode),
  );
}

export function blockFor(node: Text): Element {
  return node.parentElement!.closest(BLOCKS) ?? node.parentElement!;
}

/** Normalize whitespace while retaining one source entry per UTF-16 code unit. */
export function mapTextSlices(slices: readonly TextSlice[]): MappedText {
  let text = "";
  const characters: MappedText["characters"] = [];
  let previousBlock: Element | undefined;
  let previousSlice: TextSlice | undefined;
  function append(character: string, source: CharacterSource | null) {
    if (/\s/u.test(character)) {
      if (!text || text.endsWith(" ")) return;
      character = " ";
    }
    text += character;
    characters.push(source);
  }
  for (const [group, slice] of slices.entries()) {
    const { node, start, end } = slice;
    const block = blockFor(node);
    let gap = false;
    if (previousSlice) {
      const between = node.ownerDocument.createRange();
      between.setStart(previousSlice.node, previousSlice.end);
      between.setEnd(node, start);
      const fragment = between.cloneContents();
      gap = Boolean(fragment.querySelector("br") || fragment.textContent);
    }
    if ((previousBlock && previousBlock !== block) || gap) append(" ", null);
    previousBlock = block;
    previousSlice = slice;
    for (let offset = start; offset < end; offset++) {
      append(node.data[offset]!, {
        group,
        node,
        start: offset,
        end: offset + 1,
      });
    }
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    characters.pop();
  }
  return { text, characters };
}

/** Preserve disjoint source nodes, so excluded controls are never highlighted. */
export function rangesForOffsets(
  mapped: MappedText,
  start: number,
  end: number,
): Range[] {
  const ranges: Range[] = [];
  let current: Range | undefined;
  let currentGroup: number | undefined;
  for (const source of mapped.characters.slice(start, end)) {
    if (!source) {
      current = undefined;
      continue;
    }
    if (
      currentGroup === source.group &&
      current?.endContainer === source.node &&
      current.endOffset <= source.start
    ) {
      current.setEnd(source.node, source.end);
    } else {
      current = source.node.ownerDocument.createRange();
      current.setStart(source.node, source.start);
      current.setEnd(source.node, source.end);
      ranges.push(current);
      currentGroup = source.group;
    }
  }
  return ranges;
}

export function segmentMappedText(mapped: MappedText): ReadingSegment[] {
  const segments: ReadingSegment[] = [];
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  for (const sentence of segmenter.segment(mapped.text)) {
    let start = sentence.index;
    const end = start + sentence.segment.length;
    while (start < end) {
      while (start < end && /\s/u.test(mapped.text[start]!)) start++;
      if (start === end) break;
      const points = Array.from(mapped.text.slice(start, end));
      let length = points.slice(0, MAX_SEGMENT_CODEPOINTS).join("").length;
      if (points.length > MAX_SEGMENT_CODEPOINTS) {
        const prefix = mapped.text.slice(start, start + length);
        const boundary = Math.max(
          prefix.lastIndexOf(" "),
          prefix.lastIndexOf(";"),
          prefix.lastIndexOf(","),
        );
        if (boundary >= length / 2) length = boundary + 1;
      }
      let stop = start + length;
      while (stop > start && /\s/u.test(mapped.text[stop - 1]!)) stop--;
      const ranges = rangesForOffsets(mapped, start, stop);
      const first = ranges[0]?.startContainer;
      if (first)
        segments.push({
          text: mapped.text.slice(start, stop),
          ranges,
          block: blockFor(first as Text),
        });
      start += length;
    }
  }
  return segments;
}

export function captureSelection(selection: Selection | null): Range[] {
  if (!selection || selection.isCollapsed) return [];
  return Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index).cloneRange(),
  );
}

/** Intersect every selected node with exact boundaries, merging overlapping ranges. */
export function segmentsFromRanges(ranges: readonly Range[]): ReadingSegment[] {
  const selected = new Map<Text, { start: number; end: number }[]>();
  for (const range of ranges) {
    const root = range.commonAncestorContainer;
    const owner = root.ownerDocument ?? (root as Document);
    if (root.getRootNode() !== owner) continue;
    const walker = owner.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null =
      root.nodeType === Node.TEXT_NODE ? root : walker.nextNode();
    while (node) {
      const text = node as Text;
      // Explicit selection can include an editor or application sidebar that
      // automatic article extraction intentionally leaves out.
      if (readableText(text, "selection") && range.intersectsNode(text)) {
        const start = range.startContainer === text ? range.startOffset : 0;
        const end = range.endContainer === text ? range.endOffset : text.length;
        if (start < end) {
          const intervals = selected.get(text) ?? [];
          intervals.push({ start, end });
          selected.set(text, intervals);
        }
      }
      node = walker.nextNode();
    }
  }
  const slices: TextSlice[] = [];
  const nodes = [...selected.keys()].sort((left, right) =>
    left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING
      ? -1
      : 1,
  );
  for (const node of nodes) {
    const intervals = selected
      .get(node)!
      .sort((left, right) => left.start - right.start);
    for (const interval of intervals) {
      const previous = slices.at(-1);
      if (previous?.node === node && interval.start <= previous.end)
        previous.end = Math.max(previous.end, interval.end);
      else slices.push({ node, ...interval });
    }
  }
  return segmentMappedText(mapTextSlices(slices));
}
