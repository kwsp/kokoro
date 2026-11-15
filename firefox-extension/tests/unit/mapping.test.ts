import { beforeEach, describe, expect, it } from "vitest";
import {
  captureSelection,
  segmentsFromRanges,
  MAX_SEGMENT_CODEPOINTS,
} from "../../src/mapping";

beforeEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});
function select(element: Node) {
  const range = document.createRange();
  range.selectNodeContents(element);
  return range;
}
function read(html: string) {
  document.body.innerHTML = html;
  return segmentsFromRanges([select(document.body)]);
}
function sourceText(segment: ReturnType<typeof read>[number]) {
  return segment.ranges.map((range) => range.toString()).join("");
}

describe("selection source mapping", () => {
  it("clips exact selection boundaries across inline nodes", () => {
    document.body.innerHTML =
      "<p>Before. Read <em>this 😀</em> sentence. After.</p>";
    const p = document.querySelector("p")!;
    const range = document.createRange();
    range.setStart(p.firstChild!, 8);
    range.setEnd(p.lastChild!, 10);
    const segments = segmentsFromRanges([range]);
    expect(segments.map((s) => s.text)).toEqual(["Read this 😀 sentence."]);
    expect(sourceText(segments[0]!)).toBe("Read this 😀 sentence.");
    expect(segments[0]!.ranges[0]!.startOffset).toBe(8);
    expect(segments[0]!.ranges.at(-1)!.endOffset).toBe(10);
  });
  it("collapses whitespace while retaining original UTF-16 offsets", () => {
    const segments = read("<p>  😀 Café   here.\n  Again.</p>");
    expect(segments.map((s) => s.text)).toEqual(["😀 Café here.", "Again."]);
    expect(sourceText(segments[0]!)).toBe("😀 Café   here.");
    expect(segments[0]!.ranges[0]!.startOffset).toBe(2);
    expect(segments[1]!.ranges[0]!.startOffset).toBe(21);
  });
  it("preserves unspaced inline text and inserts block/line-break boundaries", () => {
    const segments = read(
      "<p>Inter<strong>national</strong> text<br>continues.</p><p>Next.</p>",
    );
    expect(segments.map((s) => s.text)).toEqual([
      "International text continues.",
      "Next.",
    ]);
  });
  it("omits controls and hidden content without highlighting them", () => {
    const segments = read(
      '<p>Read <span hidden>hidden</span><button>button</button><span style="display:none">secret</span><span contenteditable="true">editor</span>this.</p><nav>Navigation.</nav><script>bad()</script>',
    );
    expect(segments.map((s) => s.text)).toEqual(["Read this."]);
    expect(sourceText(segments[0]!)).toBe("Read this.");
    expect(segments[0]!.ranges).toHaveLength(2);
  });
  it("maps repeated phrases to their own occurrence", () => {
    const segments = read("<p>Repeat. Repeat.</p>");
    expect(segments.map((s) => s.text)).toEqual(["Repeat.", "Repeat."]);
    expect(segments.map((s) => s.ranges[0]!.startOffset)).toEqual([0, 8]);
  });
  it("does not include gaps in disjoint selections on one text node", () => {
    document.body.innerHTML = "<p>Read OMITTED this.</p>";
    const node = document.querySelector("p")!.firstChild!;
    const first = document.createRange();
    first.setStart(node, 0);
    first.setEnd(node, 4);
    const second = document.createRange();
    second.setStart(node, 13);
    second.setEnd(node, 18);
    const segments = segmentsFromRanges([second, first]);
    expect(segments[0]!.text).toBe("Read this.");
    expect(segments[0]!.ranges.map((r) => r.toString())).toEqual([
      "Read",
      "this.",
    ]);
  });
  it("keeps disjoint words separated when only whitespace was omitted", () => {
    document.body.innerHTML = "<p>Read   this.</p>";
    const node = document.querySelector("p")!.firstChild!;
    const first = document.createRange();
    first.setStart(node, 0);
    first.setEnd(node, 4);
    const second = document.createRange();
    second.setStart(node, 7);
    second.setEnd(node, 12);
    const segments = segmentsFromRanges([first, second]);
    expect(segments[0]!.text).toBe("Read this.");
    expect(segments[0]!.ranges.map((range) => range.toString())).toEqual([
      "Read",
      "this.",
    ]);
  });
  it("merges overlapping selections without duplicating text", () => {
    document.body.innerHTML = "<p>Read this.</p>";
    const node = document.querySelector("p")!.firstChild!;
    const first = document.createRange();
    first.setStart(node, 0);
    first.setEnd(node, 7);
    const second = document.createRange();
    second.setStart(node, 5);
    second.setEnd(node, 10);
    expect(segmentsFromRanges([first, second]).map((s) => s.text)).toEqual([
      "Read this.",
    ]);
  });
  it("supports a selection whose common ancestor is the document", () => {
    document.body.innerHTML = "<p>Whole page.</p>";
    expect(segmentsFromRanges([select(document)]).map((s) => s.text)).toEqual([
      "Whole page.",
    ]);
  });
  it("clones selection before focus or subsequent selection changes", () => {
    document.body.innerHTML = "<p>Selected.</p>";
    const selection = window.getSelection()!;
    selection.addRange(select(document.querySelector("p")!));
    const ranges = captureSelection(selection);
    selection.removeAllRanges();
    expect(segmentsFromRanges(ranges)[0]!.text).toBe("Selected.");
    expect(captureSelection(selection)).toEqual([]);
  });
  it.each(["😀".repeat(2001), "word ".repeat(601) + "end."])(
    "splits long sentences without truncation or broken surrogate pairs",
    (text) => {
      document.body.textContent = text;
      const segments = segmentsFromRanges([select(document.body)]);
      expect(
        segments.every(
          (s) => Array.from(s.text).length <= MAX_SEGMENT_CODEPOINTS,
        ),
      ).toBe(true);
      expect(
        segments
          .map((s) => s.text)
          .join("")
          .replaceAll(" ", ""),
      ).toBe(text.replaceAll(" ", ""));
      for (const segment of segments)
        expect(sourceText(segment)).toBe(segment.text);
    },
  );
  it("ignores selections inside a shadow root", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<p>Extension or shadow UI.</p>";
    expect(segmentsFromRanges([select(shadow.querySelector("p")!)])).toEqual(
      [],
    );
  });
  it("returns no segments for empty or excluded selections", () => {
    expect(
      read('<p>   </p><input value="secret"><textarea>secret</textarea>'),
    ).toEqual([]);
  });
});
