import { beforeEach, describe, expect, it } from "vitest";
import {
  collectBlocks,
  editorRootFor,
  extractEditor,
  extractPage,
  uniqueOrderedMatches,
} from "../../src/extraction";

beforeEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
});
const texts = () =>
  extractPage(document).segments.map((segment) => segment.text);
const paragraph =
  "The quiet garden gives readers a place to notice small changes in the seasons, from the first leaves opening in the morning light to the patient work of bees visiting flowers beside the winding path and the fresh green shoots appearing after gentle rain.";

function unmarkedArticle() {
  document.body.innerHTML = `<header>Site navigation</header><div class="article-body"><p>${paragraph}</p><p>A second observation explains how the same garden changes during the afternoon, when shadows move across the path and the warmer air carries the smell of herbs, while birds find shelter among the branches and visitors stop to enjoy the peaceful scene.</p><p>Finally the evening brings a different rhythm to the garden, with softer light across the leaves and cooler air beside the stone wall, giving every visitor a chance to pause and remember the many small details that made this ordinary day memorable.</p></div><footer>Copyright and unrelated links</footer>`;
}

describe("page extraction", () => {
  it("maps an explicitly targeted document across editor blocks without exposing it to automatic reading", () => {
    document.body.innerHTML =
      '<main><p>Read-only response.</p><div role="document"><div contenteditable="true"><p>First editable block.</p></div><div contenteditable="true"><p>Second <em>editable</em> block.</p><a href="#">Document reference.</a><button>Editor action</button></div><aside>Sidebar.</aside><p hidden>Hidden text.</p></div><div contenteditable="true">Unsent composer.</div></main>';
    const target = document.querySelector("em")!;
    const root = editorRootFor(target)!;
    expect(root).toBe(document.querySelector('[role="document"]'));
    const before = document.body.innerHTML;
    const reading = extractEditor(root);
    expect(reading.segments.map((segment) => segment.text)).toEqual([
      "First editable block.",
      "Second editable block.",
      "Document reference.",
    ]);
    expect(
      reading.segments[1]!.ranges.map((range) => range.toString()).join(""),
    ).toBe("Second editable block.");
    expect(texts()).toEqual(["Read-only response."]);
    expect(document.body.innerHTML).toBe(before);
  });
  it("uses a containing main or standalone editor and rejects detached editor roots", () => {
    document.body.innerHTML =
      '<div role="main"><div contenteditable="true"><span>Block one.</span></div><div contenteditable="true">Block two.</div></div><div contenteditable="plaintext-only" id="standalone"><span>Standalone text.</span></div>';
    expect(editorRootFor(document.querySelector("span")!)).toBe(
      document.querySelector('[role="main"]'),
    );
    const standalone = document.getElementById("standalone")!;
    expect(editorRootFor(standalone.firstElementChild!)).toBe(standalone);
    expect(editorRootFor(document.body)).toBeUndefined();
    standalone.remove();
    expect(extractEditor(standalone).segments).toEqual([]);
  });
  it("prefers article over main and retains an article header heading", () => {
    document.body.innerHTML =
      "<header>Site title</header><main><p>Unrelated main text.</p><article><header><h1>Article heading</h1></header><p>Read <em>this</em> first.</p><h2>Next section</h2><ul><li>A list item.</li></ul><blockquote><p>A quotation.</p></blockquote></article></main><footer>Footer text.</footer>";
    const reading = extractPage(document);
    expect(reading.source).toBe("article");
    expect(reading.root.tagName).toBe("ARTICLE");
    expect(texts()).toEqual([
      "Article heading",
      "Read this first.",
      "Next section",
      "A list item.",
      "A quotation.",
    ]);
    expect(
      reading.segments[1]!.ranges.map((range) => range.toString()).join(""),
    ).toBe("Read this first.");
  });
  it("uses main when the article is hidden or contains only a heading", () => {
    document.body.innerHTML =
      "<article hidden><p>Hidden article.</p></article><article><h1>Empty card</h1></article><main><h1>Main heading</h1><p>Main prose.</p></main>";
    expect(extractPage(document).source).toBe("main");
    expect(texts()).toEqual(["Main heading", "Main prose."]);
  });
  it("reads an ARIA main landmark without HTML article or main tags", () => {
    document.body.innerHTML =
      '<nav>Workspace navigation.</nav><div role="main"><p>Main application text.</p></div>';
    const reading = extractPage(document);
    expect(reading.source).toBe("main");
    expect(reading.root).toBe(document.querySelector('[role="main"]'));
    expect(texts()).toEqual(["Main application text."]);
  });
  it.each(["<main>", '<div role="main">'])(
    "reads all article turns in one %s landmark while excluding the composer",
    (opening) => {
      const closing = opening === "<main>" ? "</main>" : "</div>";
      document.body.innerHTML = `<nav>Workspace navigation.</nav>${opening}<article><p>Short question.</p><button>Copy question</button></article><article><p>${paragraph}</p><button>Copy response</button></article><div role="textbox" contenteditable="true">Unsent composer draft.</div>${closing}`;
      const before = document.body.innerHTML;
      const reading = extractPage(document);
      expect(reading.source).toBe("main");
      expect(reading.segments.map((segment) => segment.text)).toEqual([
        "Short question.",
        paragraph,
      ]);
      expect(reading.segments[0]!.ranges[0]!.startContainer).toBe(
        document.querySelector("article p")!.firstChild,
      );
      expect(document.body.innerHTML).toBe(before);
    },
  );
  it("uses the outermost main landmark without duplicating nested turns", () => {
    document.body.innerHTML =
      '<main><div role="main"><article><p>First reply.</p></article><article><p>Other reply.</p></article></div></main>';
    expect(extractPage(document).root).toBe(document.querySelector("main"));
    expect(texts()).toEqual(["First reply.", "Other reply."]);
  });
  it("still prefers a single article within an ARIA main landmark", () => {
    document.body.innerHTML =
      '<div role="main"><p>Other application text.</p><article><p>Chosen article.</p></article></div>';
    expect(extractPage(document).source).toBe("article");
    expect(texts()).toEqual(["Chosen article."]);
  });
  it("ignores hidden main landmarks and does not combine unrelated article roots", () => {
    document.body.innerHTML =
      '<div role="main" hidden><p>Hidden application text.</p></div><main><p>Visible prose.</p></main>';
    expect(texts()).toEqual(["Visible prose."]);
    document.body.innerHTML =
      '<main><article><p>First story.</p></article></main><div role="main"><article><p>Other story.</p></article></div>';
    expect(() => extractPage(document)).toThrow("Select a passage");
  });
  it("excludes hidden prose, controls, editable areas, navigation, and aside content", () => {
    document.head.innerHTML = "<style>.concealed{display:none}</style>";
    document.body.innerHTML =
      '<article><p>Visible.</p><p class="concealed">Hidden.</p><p style="opacity:0">Invisible.</p><div aria-hidden="true"><p>Aria hidden.</p></div><nav><p>Navigation.</p></nav><aside><p>Related story.</p></aside><p><button>Skip button</button><span role="button">Skip custom button</span><span contenteditable="true">Skip editor</span>Readable end.</p></article>';
    expect(texts()).toEqual(["Visible.", "Readable end."]);
  });
  it("keeps nested block order and maps identical phrases to their own nodes", () => {
    document.body.innerHTML =
      "<article><p>Repeat.</p><blockquote>Before.<p>Inside.</p>After.</blockquote><p>Repeat.</p></article>";
    const reading = extractPage(document);
    expect(reading.segments.map((segment) => segment.text)).toEqual([
      "Repeat.",
      "Before.",
      "Inside.",
      "After.",
      "Repeat.",
    ]);
    expect(reading.segments[0]!.ranges[0]!.startContainer).not.toBe(
      reading.segments.at(-1)!.ranges[0]!.startContainer,
    );
  });
  it("chooses a clearly dominant article and rejects ambiguous article cards", () => {
    document.body.innerHTML = `<article><p>Short card.</p></article><article><p>${paragraph}</p></article>`;
    expect(texts()).toEqual([paragraph]);
    document.body.innerHTML =
      "<article><p>First story.</p></article><article><p>Other story.</p></article>";
    expect(() => extractPage(document)).toThrow("Select a passage");
  });
  it("does not duplicate nested semantic roots", () => {
    document.body.innerHTML =
      "<article><p>Outer.</p><article><p>Inner.</p></article></article>";
    expect(texts()).toEqual(["Outer.", "Inner."]);
  });
  it("splits long blocks without truncation or losing source mapping", () => {
    const text = "😀 ".repeat(1100).trim();
    document.body.innerHTML = `<main><p>${text}</p></main>`;
    const reading = extractPage(document);
    expect(reading.segments.length).toBeGreaterThan(1);
    expect(
      reading.segments.every(
        (segment) => Array.from(segment.text).length <= 1000,
      ),
    ).toBe(true);
    expect(reading.segments.map((segment) => segment.text).join(" ")).toBe(
      text,
    );
    expect(
      reading.segments.every(
        (segment) =>
          segment.ranges.map((range) => range.toString()).join("") ===
          segment.text,
      ),
    ).toBe(true);
  });
  it("reads only the summary of closed details and includes opened content", () => {
    document.body.innerHTML =
      "<article><p>Intro.</p><details><summary>Visible summary.</summary>Hidden direct text.<p>Hidden paragraph.</p></details></article>";
    expect(texts()).toEqual(["Intro.", "Visible summary."]);
    document.querySelector("details")!.open = true;
    expect(texts()).toEqual([
      "Intro.",
      "Visible summary.",
      "Hidden direct text.",
      "Hidden paragraph.",
    ]);
  });
  it("uses Readability on a clone and maps back to the unchanged live DOM", () => {
    unmarkedArticle();
    const before = document.documentElement.outerHTML;
    const first = document.querySelector(".article-body p")!.firstChild;
    const reading = extractPage(document);
    expect(reading.source).toBe("readability");
    expect(reading.segments[0]!.text).toBe(paragraph);
    expect(reading.segments[0]!.ranges[0]!.startContainer).toBe(first);
    expect(document.documentElement.outerHTML).toBe(before);
    expect(reading.segments).toHaveLength(3);
  });
  it("removes hidden live content from the Readability clone before parsing", () => {
    unmarkedArticle();
    document.head.innerHTML = "<style>.hidden-story{display:none}</style>";
    document
      .querySelector(".article-body")!
      .insertAdjacentHTML(
        "afterbegin",
        `<p class="hidden-story">${paragraph.repeat(3)}</p>`,
      );
    const reading = extractPage(document);
    expect(reading.segments).toHaveLength(3);
    expect(
      reading.segments[0]!.ranges[0]!.startContainer.parentElement!.className,
    ).toBe("");
  });
  it("rejects empty and navigation-only pages instead of reading the body blindly", () => {
    document.body.innerHTML =
      '<nav><a href="#">Navigation only.</a></nav><footer>Footer only.</footer><button>Press me</button>';
    expect(() => extractPage(document)).toThrow("No readable article");
  });
  it("normalizes source blocks without wrapping or replacing original nodes", () => {
    document.body.innerHTML =
      "<main><p>Inter<strong>national</strong>   text<br>continues.</p></main>";
    const original = document.querySelector("strong");
    const before = document.body.innerHTML;
    expect(
      collectBlocks(document.querySelector("main")!).map(
        (block) => block.mapped.text,
      ),
    ).toEqual(["International text continues."]);
    expect(document.body.innerHTML).toBe(before);
    expect(document.querySelector("strong")).toBe(original);
  });
});

describe("conservative Readability mapping", () => {
  it("uses surrounding ordered blocks to resolve repeated text", () => {
    expect(
      uniqueOrderedMatches(
        ["Other", "Repeat", "Context", "Repeat", "End"],
        ["Context", "Repeat", "End"],
      ),
    ).toEqual([2, 3, 4]);
    expect(
      uniqueOrderedMatches(["Repeat", "Repeat"], ["Repeat", "Repeat"]),
    ).toEqual([0, 1]);
  });
  it("rejects an ambiguous duplicate instead of choosing the first occurrence", () => {
    expect(() =>
      uniqueOrderedMatches(["Repeat", "Repeat"], ["Repeat"]),
    ).toThrow("confidently");
  });
  it("rejects missing or reordered blocks", () => {
    expect(() =>
      uniqueOrderedMatches(["First", "Second"], ["Missing"]),
    ).toThrow("confidently");
    expect(() =>
      uniqueOrderedMatches(["First", "Second"], ["Second", "First"]),
    ).toThrow("confidently");
  });
});
