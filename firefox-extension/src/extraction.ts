import { Readability } from "@mozilla/readability";
import {
  blockFor,
  mapTextSlices,
  readableElement,
  readableText,
  segmentMappedText,
  type MappedText,
  type ReadingSegment,
  type TextSlice,
} from "./mapping";

export interface ReadingDocument {
  root: Element;
  source: "article" | "main" | "readability";
  segments: ReadingSegment[];
}

interface MappedBlock {
  element: Element;
  mapped: MappedText;
}

const EMPTY_MESSAGE =
  "No readable article found. Select a passage, then activate Kokoro again.";
const AMBIGUOUS_MESSAGE =
  "Could not confidently identify the article. Select a passage, then activate Kokoro again.";

/** Consecutive groups preserve DOM order even when prose blocks are nested. */
export function collectBlocks(root: Element): MappedBlock[] {
  const groups: { element: Element; slices: TextSlice[] }[] = [];
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!readableText(text)) continue;
    const nearest = blockFor(text);
    const element = root.contains(nearest) ? nearest : root;
    let group = groups.at(-1);
    if (!group || group.element !== element) {
      group = { element, slices: [] };
      groups.push(group);
    }
    group.slices.push({ node: text, start: 0, end: text.length });
  }
  return groups
    .map(({ element, slices }) => ({ element, mapped: mapTextSlices(slices) }))
    .filter(({ mapped }) => mapped.text.length > 0);
}

function toSegments(blocks: readonly MappedBlock[]): ReadingSegment[] {
  return blocks.flatMap(({ element, mapped }) =>
    segmentMappedText(mapped).map((segment) => ({
      ...segment,
      block: element,
    })),
  );
}

function semanticRoot(document: Document, tag: "article" | "main") {
  const candidates = [...document.querySelectorAll(tag)]
    .filter(
      (element) =>
        readableElement(element) && !element.parentElement?.closest(tag),
    )
    .map((element) => ({ element, blocks: collectBlocks(element) }))
    .filter(({ blocks }) =>
      blocks.some(({ element }) => !element.matches("h1,h2,h3,h4,h5,h6")),
    )
    .map((candidate) => ({
      ...candidate,
      size: candidate.blocks.reduce(
        (sum, block) => sum + block.mapped.text.length,
        0,
      ),
    }))
    .sort((left, right) => right.size - left.size);
  const first = candidates[0];
  if (!first) return;
  // Similar article cards are not a single reading scope.
  if (candidates[1] && first.size < candidates[1].size * 2)
    throw new Error(AMBIGUOUS_MESSAGE);
  return first;
}

/** Earliest and latest matches agree only when the ordered mapping is unique. */
export function uniqueOrderedMatches(
  source: readonly string[],
  targets: readonly string[],
): number[] {
  const earliest: number[] = [];
  let cursor = 0;
  for (const target of targets) {
    while (cursor < source.length && source[cursor] !== target) cursor++;
    if (cursor === source.length) throw new Error(AMBIGUOUS_MESSAGE);
    earliest.push(cursor++);
  }
  cursor = source.length - 1;
  for (let index = targets.length - 1; index >= 0; index--) {
    while (cursor >= 0 && source[cursor] !== targets[index]) cursor--;
    if (cursor !== earliest[index]) throw new Error(AMBIGUOUS_MESSAGE);
    cursor--;
  }
  return earliest;
}

function readableClone(document: Document): Document {
  const clone = document.cloneNode(true) as Document;
  // Use the live computed styles before Readability changes its detached clone.
  const textNodes = (root: Element) => {
    const nodes: Text[] = [];
    const walker = root.ownerDocument.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      nodes.push(node as Text);
    return nodes;
  };
  const originalTexts = textNodes(document.body);
  const copiedTexts = textNodes(clone.body);
  originalTexts.forEach((node, index) => {
    if (!readableText(node)) copiedTexts[index]!.remove();
  });
  const originals = [...document.body.querySelectorAll("*")];
  const copies = [...clone.body.querySelectorAll("*")];
  originals.forEach((element, index) => {
    if (!readableElement(element)) copies[index]!.remove();
  });
  return clone;
}

export function extractPage(document: Document): ReadingDocument {
  for (const source of ["article", "main"] as const) {
    const candidate = semanticRoot(document, source);
    if (candidate)
      return {
        root: candidate.element,
        source,
        segments: toSegments(candidate.blocks),
      };
  }
  if (!document.body) throw new Error(EMPTY_MESSAGE);
  const original = collectBlocks(document.body);
  if (!original.length) throw new Error(EMPTY_MESSAGE);
  const clone = readableClone(document);
  let content: Node | null | undefined;
  try {
    content = new Readability<Node>(clone, {
      serializer: (node) => node,
      maxElemsToParse: 20000,
      disableJSONLD: true,
    }).parse()?.content;
  } catch {
    throw new Error(AMBIGUOUS_MESSAGE);
  }
  if (!content || content.nodeType !== Node.ELEMENT_NODE)
    throw new Error(EMPTY_MESSAGE);
  const extracted = collectBlocks(content as Element);
  if (!extracted.length) throw new Error(EMPTY_MESSAGE);
  const matches = uniqueOrderedMatches(
    original.map(({ mapped }) => mapped.text),
    extracted.map(({ mapped }) => mapped.text),
  );
  return {
    root: document.body,
    source: "readability",
    segments: toSegments(matches.map((index) => original[index]!)),
  };
}
