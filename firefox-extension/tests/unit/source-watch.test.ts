import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractPage } from "../../src/extraction";
import { segmentsFromRanges } from "../../src/mapping";
import { sameRanges, watchSource } from "../../src/source-watch";
beforeEach(() => {
  document.body.innerHTML =
    "<article><p>First sentence.</p><p>Second sentence.</p></article>";
});
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
describe("source lifecycle", () => {
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
  it("identifies identical selections without losing exact offsets", () => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("p")!);
    const copy = range.cloneRange();
    expect(sameRanges([range], [copy])).toBe(true);
    copy.setStart(copy.startContainer.firstChild!, 2);
    expect(sameRanges([range], [copy])).toBe(false);
  });
});
