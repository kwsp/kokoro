import {
  blockFor,
  readableText,
  type ReadingSegment,
  type TextMode,
} from "./mapping";

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
  remapped?: () => void,
) {
  const selectedNodes = [
    ...new Set(
      segments.flatMap((segment) =>
        segment.ranges.map((range) => range.startContainer as Text),
      ),
    ),
  ];
  const snapshot = (includeWhitespace = false) => {
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
      if (
        readableText(node as Text, mode) &&
        (includeWhitespace || node.textContent?.trim())
      )
        result.push({ node: node as Text, text: (node as Text).data });
    }
    return result;
  };
  let initial = snapshot();
  let fullInitial = snapshot(true);
  // Ranges are live: capture their original endpoints before a DOM replacement
  // causes Firefox to move them to the removed node's parent.
  const endpoints = segments.map((segment) =>
    segment.ranges.map((range) => ({
      startNode: range.startContainer,
      startOffset: range.startOffset,
      endNode: range.endContainer,
      endOffset: range.endOffset,
    })),
  );
  const path = (node: Text) => {
    const names: string[] = [];
    for (
      let element = node.parentElement;
      element && element !== root;
      element = element.parentElement
    )
      names.push(element.tagName);
    return names.join("/");
  };
  let paths = fullInitial.map(({ node }) => path(node));
  const blockPattern = (entries: typeof initial) => {
    const seen = new Map<Element, number>();
    return entries.map(({ node }) => {
      const block = blockFor(node);
      if (!seen.has(block)) seen.set(block, seen.size);
      return seen.get(block);
    });
  };
  let blocks = blockPattern(fullInitial);
  function rebind(current: typeof initial): boolean {
    const fullCurrent = snapshot(true);
    if (
      selectionOnly ||
      mode !== "page" ||
      !segments.length ||
      current.length !== initial.length ||
      fullCurrent.length !== fullInitial.length ||
      fullCurrent.some(
        (item, index) =>
          item.text !== fullInitial[index]!.text ||
          path(item.node) !== paths[index],
      )
    )
      return false;
    if (
      blockPattern(fullCurrent).some((block, index) => block !== blocks[index])
    )
      return false;
    const indexes = new Map(
      fullInitial.map(({ node }, index) => [node as Node, index]),
    );
    const replacement: Range[][] = [];
    for (const ranges of endpoints) {
      const next: Range[] = [];
      for (const endpoint of ranges) {
        const start = indexes.get(endpoint.startNode);
        const end = indexes.get(endpoint.endNode);
        if (
          start === undefined ||
          end === undefined ||
          start !== end ||
          endpoint.startOffset > fullCurrent[start]!.node.length ||
          endpoint.endOffset > fullCurrent[end]!.node.length ||
          endpoint.startOffset > endpoint.endOffset
        )
          return false;
        const range = root.ownerDocument.createRange();
        range.setStart(fullCurrent[start]!.node, endpoint.startOffset);
        range.setEnd(fullCurrent[end]!.node, endpoint.endOffset);
        next.push(range);
      }
      if (!next.length) return false;
      replacement.push(next);
    }
    for (const [index, segment] of segments.entries()) {
      segment.ranges = replacement[index]!;
      segment.block = blockFor(segment.ranges[0]!.startContainer as Text);
      for (const [rangeIndex, range] of segment.ranges.entries()) {
        const endpoint = endpoints[index]![rangeIndex]!;
        endpoint.startNode = range.startContainer;
        endpoint.endNode = range.endContainer;
      }
    }
    initial = current;
    fullInitial = fullCurrent;
    paths = fullCurrent.map(({ node }) => path(node));
    blocks = blockPattern(fullCurrent);
    remapped?.();
    return true;
  }
  const observer = new MutationObserver((records) => {
    const current = snapshot();
    const firstDifference = current.findIndex(
      (value, index) =>
        value.node !== initial[index]?.node ||
        value.text !== initial[index]?.text,
    );
    const detachedEndpoint = endpoints.some((ranges) =>
      ranges.some(
        (endpoint) =>
          !root.contains(endpoint.startNode) ||
          !root.contains(endpoint.endNode),
      ),
    );
    const endpointNodes = new Set(
      endpoints.flatMap((ranges) =>
        ranges.flatMap((endpoint) => [endpoint.startNode, endpoint.endNode]),
      ),
    );
    const changedEndpointText = fullInitial.some(
      ({ node, text }) => endpointNodes.has(node) && node.data !== text,
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
            : detachedEndpoint
              ? "node-identity"
              : changedEndpointText
                ? "text"
                : undefined;
    if (reason) {
      if (reason === "node-identity" && rebind(current)) return;
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
