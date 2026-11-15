import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractEditor, extractPage } from "../../src/reading/extraction";
import { segmentsFromRanges } from "../../src/reading/mapping";
import { sameRanges, watchSource } from "../../src/reading/source-watch";
beforeEach(() => {
  document.body.innerHTML =
    "<article><p>First sentence.</p><p>Second sentence.</p></article>";
});
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
describe("source lifecycle", () => {
  it.each(["edit", "append", "hide"])(
    "tracks the full explicit document when editor content changes: %s",
    async (change) => {
      document.body.innerHTML =
        '<main><div contenteditable="true">Editable block.</div><button>Editor action</button></main>';
      const root = document.querySelector("main")!;
      const reading = extractEditor(root);
      const changed = vi.fn();
      watchSource(root, reading.segments, false, changed, "document");
      document.querySelector("button")!.textContent = "New action label";
      await settle();
      expect(changed).not.toHaveBeenCalled();
      if (change === "edit")
        document.querySelector("[contenteditable]")!.firstChild!.textContent =
          "Changed block.";
      if (change === "append")
        root.insertAdjacentHTML(
          "beforeend",
          '<div contenteditable="true">New block.</div>',
        );
      if (change === "hide")
        (root.firstElementChild as HTMLElement).hidden = true;
      await settle();
      expect(changed).toHaveBeenCalledOnce();
    },
  );
  it("ignores owned outlines and unrelated controls but detects text changes", async () => {
    const reading = extractPage(document);
    const changed = vi.fn();
    const stop = watchSource(reading.root, reading.segments, false, changed);
    document.querySelector("p")!.style.outline = "2px solid brown";
    const ui = document.createElement("div");
    ui.id = "kokoro-reader-controls";
    ui.textContent = "UI";
    document.body.append(ui);
    await settle();
    expect(changed).not.toHaveBeenCalled();
    document.querySelector("p")!.firstChild!.textContent = "Updated sentence.";
    await settle();
    expect(changed).toHaveBeenCalledOnce();
    stop();
  });
  it.each(["remove", "hide", "append"])(
    "invalidates when source changes: %s",
    async (kind) => {
      const reading = extractPage(document);
      const changed = vi.fn();
      watchSource(reading.root, reading.segments, false, changed);
      if (kind === "remove") reading.root.remove();
      if (kind === "hide") document.querySelector("p")!.hidden = true;
      if (kind === "append")
        reading.root.insertAdjacentHTML("beforeend", "<p>New prose.</p>");
      await settle();
      expect(changed).toHaveBeenCalledOnce();
    },
  );
  it("selection scopes ignore unrelated source changes but track their own nodes", async () => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("p")!);
    const changed = vi.fn();
    watchSource(document.body, segmentsFromRanges([range]), true, changed);
    document.querySelectorAll("p")[1]!.textContent = "Unrelated update.";
    await settle();
    expect(changed).not.toHaveBeenCalled();
    document.querySelector("p")!.remove();
    await settle();
    expect(changed).toHaveBeenCalledOnce();
  });
  it("reports node replacement without exposing source text", async () => {
    const root = document.querySelector("article")!;
    const report = vi.fn();
    watchSource(root, [], false, vi.fn(), "page", report);
    const paragraph = root.querySelector("p")!;
    paragraph.replaceChild(
      document.createTextNode(paragraph.textContent!),
      paragraph.firstChild!,
    );
    await settle();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "node-identity",
        sameTextAtDifference: true,
        mutations: expect.objectContaining({ inside: 1, childList: 1 }),
      }),
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain("First sentence");
  });
  it("identifies identical selections without losing exact offsets", () => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("p")!);
    const copy = range.cloneRange();
    expect(sameRanges([range], [copy])).toBe(true);
    copy.setStart(copy.startContainer.firstChild!, 2);
    expect(sameRanges([range], [copy])).toBe(false);
  });
  it("invalidates selected editor text when it is edited or hidden", async () => {
    document.body.innerHTML =
      '<div contenteditable="true"><p>Editable note.</p></div>';
    const paragraph = document.querySelector("p")!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const changed = vi.fn();
    const unwatch = watchSource(
      document.body,
      segmentsFromRanges([range]),
      true,
      changed,
    );
    paragraph.style.outline = "2px solid brown";
    await settle();
    expect(changed).not.toHaveBeenCalled();
    paragraph.firstChild!.textContent = "Revised note.";
    await settle();
    expect(changed).toHaveBeenCalledOnce();
    unwatch();
    const hidden = vi.fn();
    watchSource(document.body, segmentsFromRanges([range]), true, hidden);
    paragraph.hidden = true;
    await settle();
    expect(hidden).toHaveBeenCalledOnce();
  });
});
