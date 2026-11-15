import { readableText, type ReadingSegment } from "./mapping";

/** Watch source text and visibility, rather than reacting to our outline styles. */
export function watchSource(
  root: Element,
  segments: readonly ReadingSegment[],
  selectionOnly: boolean,
  changed: () => void,
) {
  const selectedNodes = [
    ...new Set(
      segments.flatMap((segment) =>
        segment.ranges.map((range) => range.startContainer as Text),
      ),
    ),
  ];
  const snapshot = () => {
    if (!root.isConnected) return [];
    if (selectionOnly)
      return selectedNodes
        .filter((node) => node.isConnected && readableText(node))
        .map((node) => ({ node, text: node.data }));
    const walker = root.ownerDocument.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
    );
    const result: { node: Text; text: string }[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (readableText(node as Text) && node.textContent?.trim())
        result.push({ node: node as Text, text: (node as Text).data });
    }
    return result;
  };
  const initial = snapshot();
  const observer = new MutationObserver(() => {
    const current = snapshot();
    if (
      !root.isConnected ||
      current.length !== initial.length ||
      current.some(
        (value, index) =>
          value.node !== initial[index]?.node ||
          value.text !== initial[index]?.text,
      )
    ) {
      observer.disconnect();
      changed();
    }
  });
  observer.observe(root.ownerDocument.documentElement, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "class",
      "style",
      "hidden",
      "aria-hidden",
      "open",
      "contenteditable",
    ],
  });
  return () => observer.disconnect();
}

export function sameRanges(left: readonly Range[], right: readonly Range[]) {
  return (
    left.length === right.length &&
    left.every((range, index) => {
      const other = right[index]!;
      return (
        range.startContainer === other.startContainer &&
        range.startOffset === other.startOffset &&
        range.endContainer === other.endContainer &&
        range.endOffset === other.endOffset
      );
    })
  );
}
