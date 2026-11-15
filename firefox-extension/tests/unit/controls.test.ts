import { afterEach, describe, expect, it, vi } from "vitest";
import { createControls } from "../../src/controls";
import { SpeakingHighlight } from "../../src/highlighting";
import type { Snapshot } from "../../src/session";

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById("kokoro-reader-controls")?.remove();
  vi.unstubAllGlobals();
});

describe("reader controls", () => {
  it("offers an explicit selection action without interrupting playback automatically", () => {
    const actions = {
      play: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      clickMode: vi.fn(),
      settings: vi.fn(),
      close: vi.fn(),
    };
    const controls = createControls(actions);
    controls.update({
      state: "playing",
      index: 0,
      total: 3,
      offset: 0,
      highlightedIndex: 0,
    });
    controls.setSelectionAvailable(true);
    const button = controls.host.shadowRoot!.getElementById(
      "play",
    ) as HTMLButtonElement;
    expect(button.textContent).toBe("Read selection");
    expect(
      controls.host.shadowRoot!.querySelector('[role="status"]')!.textContent,
    ).toBe("Selected text is ready to read.");
    expect(actions.play).not.toHaveBeenCalled();
    expect(actions.pause).not.toHaveBeenCalled();
    button.click();
    expect(actions.play).toHaveBeenCalledOnce();
    expect(actions.pause).not.toHaveBeenCalled();
    controls.setSelectionAvailable(false);
    expect(button.textContent).toBe("Pause");
    button.click();
    expect(actions.pause).toHaveBeenCalledOnce();
    controls.close();
  });
  it("shows progress and dispatches Play, Pause, Resume, and Retry correctly", () => {
    const actions = {
      play: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      clickMode: vi.fn(),
      settings: vi.fn(),
      close: vi.fn(),
    };
    const controls = createControls(actions);
    const root = controls.host.shadowRoot!;
    const button = root.getElementById("play") as HTMLButtonElement;
    const snapshot: Snapshot = {
      state: "ready",
      index: 1,
      total: 4,
      offset: 0,
      highlightedIndex: null,
    };
    controls.update(snapshot);
    button.click();
    expect(actions.play).toHaveBeenCalledOnce();
    expect(root.querySelector('[role="status"]')!.textContent).toBe(
      "Sentence 2 of 4 · Ready",
    );
    for (const state of ["preparing", "playing"] as const) {
      controls.update({ ...snapshot, state });
      expect(button.textContent).toBe("Pause");
      button.click();
    }
    expect(actions.pause).toHaveBeenCalledTimes(2);
    const mode = root.getElementById("click-mode") as HTMLButtonElement;
    expect(mode.getAttribute("aria-pressed")).toBe("false");
    mode.click();
    expect(actions.clickMode).toHaveBeenCalledOnce();
    controls.setClickMode(true);
    expect(mode.getAttribute("aria-pressed")).toBe("true");
    controls.update({ ...snapshot, state: "paused" });
    expect(button.textContent).toBe("Resume");
    button.click();
    controls.update({
      ...snapshot,
      state: "error",
      error: "Start the server.",
    });
    expect(button.textContent).toBe("Retry");
    button.click();
    expect(actions.play).toHaveBeenCalledTimes(3);
    expect(root.querySelector('[role="status"]')!.textContent).toBe(
      "Start the server.",
    );
    for (const name of ["stop", "settings", "close"] as const) {
      (root.getElementById(name) as HTMLButtonElement).click();
      expect(actions[name]).toHaveBeenCalledOnce();
    }
    controls.close();
    expect(controls.host.isConnected).toBe(false);
  });
  it("renders error text safely and exposes keyboard focus", () => {
    const noop = () => {};
    const controls = createControls({
      play: noop,
      pause: noop,
      stop: noop,
      clickMode: noop,
      settings: noop,
      close: noop,
    });
    controls.update({
      state: "error",
      index: 0,
      total: 0,
      offset: 0,
      highlightedIndex: null,
      error: '<img src=x onerror="bad()">',
    });
    expect(controls.host.shadowRoot!.querySelector("img")).toBeNull();
    controls.focus();
    expect(controls.host.shadowRoot!.activeElement?.id).toBe("play");
    expect(
      controls.host
        .shadowRoot!.querySelector("section")!
        .getAttribute("aria-label"),
    ).toBe("Kokoro reader");
    controls.close();
  });
});

describe("speaking highlights", () => {
  it("uses exact ranges for speech/pause and clears only its own marks", () => {
    const highlights = new Map<string, unknown>();
    vi.stubGlobal("CSS", { highlights });
    vi.stubGlobal(
      "Highlight",
      class {
        ranges: Range[];
        constructor(...ranges: Range[]) {
          this.ranges = ranges;
        }
      },
    );
    highlights.set("page-owned", "keep");
    document.body.innerHTML = "<p>Read this.</p>";
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("p")!);
    const segment = {
      text: "Read this.",
      ranges: [range],
      block: document.body,
    };
    const marks = new SpeakingHighlight();
    marks.show(segment);
    expect(highlights.get("kokoro-speaking")).toEqual({ ranges: [range] });
    marks.show(segment, true);
    expect(highlights.has("kokoro-speaking")).toBe(false);
    expect(highlights.has("kokoro-paused")).toBe(true);
    marks.close();
    expect([...highlights.entries()]).toEqual([["page-owned", "keep"]]);
  });
});
