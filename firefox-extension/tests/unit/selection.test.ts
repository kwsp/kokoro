import { afterEach, describe, expect, it, vi } from "vitest";
import { watchSelection } from "../../src/selection";

afterEach(() => {
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
});

describe("selection while the reader is open", () => {
  it("retains ranges when control focus collapses the page selection", () => {
    document.body.innerHTML =
      '<div contenteditable="true">Chosen note.</div><div id="controls"></div>';
    const editor = document.querySelector("[contenteditable]") as HTMLElement;
    const host = document.getElementById("controls")!;
    const shadow = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    shadow.append(button);
    const changed = vi.fn();
    const close = watchSelection(document, host, changed);
    editor.focus();
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(changed).toHaveBeenCalledOnce();
    const saved = changed.mock.calls[0]![0] as Range[];
    button.focus();
    selection.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    expect(changed).toHaveBeenCalledOnce();
    expect(saved.map((item) => item.toString())).toEqual(["Chosen note."]);
    editor.focus();
    document.dispatchEvent(new Event("selectionchange"));
    expect(changed).toHaveBeenLastCalledWith([]);
    close();
    changed.mockClear();
    document.dispatchEvent(new Event("selectionchange"));
    host.dispatchEvent(new MouseEvent("mousedown"));
    expect(changed).not.toHaveBeenCalled();
  });

  it("captures on reader mousedown before focus even if selectionchange has not fired", () => {
    document.body.innerHTML = '<p>Chosen passage.</p><div id="controls"></div>';
    const host = document.getElementById("controls")!;
    const changed = vi.fn();
    const close = watchSelection(document, host, changed);
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("p")!);
    document.getSelection()!.addRange(range);
    host.dispatchEvent(new MouseEvent("mousedown"));
    expect(changed).toHaveBeenCalledOnce();
    expect(changed.mock.calls[0]![0][0].toString()).toBe("Chosen passage.");
    close();
  });
});
