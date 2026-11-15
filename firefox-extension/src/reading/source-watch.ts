import { readableText, type ReadingSegment, type TextMode } from "./mapping";

export interface SourceChangeDiagnostic {
  reason: "root-disconnected" | "node-count" | "node-identity" | "text";
  initialCount: number;
  currentCount: number;
  firstDifference: number | null;
  sameTextAtDifference: boolean | null;
  mutations: {
    inside: number;
    outside: number;
    ancestor: number;
    childList: number;
    characterData: number;
    attributes: number;
    attributeNames: Record<string, number>;
  };
}

/** Watch source text and visibility, rather than reacting to our outline styles. */
export function watchSource(
  root: Element,
  segments: readonly ReadingSegment[],
  selectionOnly: boolean,
  changed: () => void,
  mode: TextMode = selectionOnly ? "selection" : "page",
  diagnostic?: (data: SourceChangeDiagnostic) => void,
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
        .filter((node) => node.isConnected && readableText(node, mode))
        .map((node) => ({ node, text: node.data }));
    const walker = root.ownerDocument.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
    );
    const result: { node: Text; text: string }[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (readableText(node as Text, mode) && node.textContent?.trim())
        result.push({ node: node as Text, text: (node as Text).data });
    }
    return result;
  };
  const initial = snapshot();
  const observer = new MutationObserver((records) => {
    const current = snapshot();
    const firstDifference = current.findIndex(
      (value, index) =>
        value.node !== initial[index]?.node ||
        value.text !== initial[index]?.text,
    );
    const reason = !root.isConnected
      ? "root-disconnected"
      : current.length !== initial.length
        ? "node-count"
        : firstDifference >= 0 &&
            current[firstDifference]!.node !== initial[firstDifference]?.node
          ? "node-identity"
          : firstDifference >= 0
            ? "text"
            : undefined;
    if (reason) {
      const mutations = {
        inside: 0,
        outside: 0,
        ancestor: 0,
        childList: 0,
        characterData: 0,
        attributes: 0,
        attributeNames: {} as Record<string, number>,
      };
      for (const record of records) {
        if (root.contains(record.target)) mutations.inside++;
        else if (record.target.contains(root)) mutations.ancestor++;
        else mutations.outside++;
        mutations[record.type]++;
        if (record.type === "attributes" && record.attributeName) {
          mutations.attributeNames[record.attributeName] =
            (mutations.attributeNames[record.attributeName] ?? 0) + 1;
        }
      }
      diagnostic?.({
        reason,
        initialCount: initial.length,
        currentCount: current.length,
        firstDifference:
          firstDifference < 0
            ? current.length !== initial.length
              ? Math.min(current.length, initial.length)
              : null
            : firstDifference,
        sameTextAtDifference:
          firstDifference < 0
            ? null
            : current[firstDifference]?.text === initial[firstDifference]?.text,
        mutations,
      });
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
