import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createControls } from "../../src/ui/controls";
import { SpeakingHighlight } from "../../src/reading/highlighting";
import type { Snapshot } from "../../src/speech/session";

beforeEach(() => {
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
  });
});

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById("kokoro-reader-controls")?.remove();
  vi.unstubAllGlobals();
});

describe("reader controls", () => {
  it("does not emit playback attribute mutations for unchanged snapshots", () => {
    const noop = () => {};
    const controls = createControls({
      play: noop,
      pause: noop,
      stop: noop,
      clickMode: noop,
      settings: noop,
      downloadLogs: noop,
      close: noop,
    });
    const snapshot: Snapshot = {
      state: "playing",
      index: 0,
      total: 2,
      offset: 0,
      highlightedIndex: 0,
    };
    controls.update(snapshot);
    const observer = new MutationObserver(() => {});
    observer.observe(controls.host, { attributes: true });
    controls.update(snapshot);
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    controls.close();
  });
  it("persists the advanced panel preference and keeps it above controls", async () => {
    const noop = () => {};
    const controls = createControls({
      play: noop,
      pause: noop,
      stop: noop,
      clickMode: noop,
      settings: noop,
      downloadLogs: noop,
      close: noop,
    });
    const root = controls.host.shadowRoot!;
    const panel = root.getElementById("advanced-panel")!;
    const toggle = root.getElementById("advanced-toggle") as HTMLButtonElement;
    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-label")).toBe("Advanced");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    for (const [id, label] of [
      ["settings", "Settings"],
      ["close", "Close"],
      ["advanced-toggle", "Advanced"],
    ] as const) {
      const button = root.getElementById(id)!;
      expect(button.getAttribute("aria-label")).toBe(label);
      expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      expect(button.textContent).toBe("");
    }
    toggle.click();
    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(browser.storage.local.set).toHaveBeenCalledWith({
      advancedExpanded: true,
    });
    expect(panel.nextElementSibling?.tagName).toBe("NAV");
    toggle.click();
    expect(panel.hidden).toBe(true);
    controls.close();
  });
  it("offers log download after source invalidation", () => {
    const noop = () => {};
    const downloadLogs = vi.fn();
    const controls = createControls({
      play: noop,
      pause: noop,
      stop: noop,
      clickMode: noop,
      settings: noop,
      close: noop,
      downloadLogs,
    });
    controls.update({
      state: "error",
      index: 0,
      total: 0,
      offset: 0,
      highlightedIndex: null,
      error: "Page changed; press Play to refresh.",
    });
    const root = controls.host.shadowRoot!;
    (root.getElementById("advanced-toggle") as HTMLButtonElement).click();
    const button = Array.from(root.querySelectorAll("button")).find(
      (item) => item.textContent === "Download debug logs",
    )!;
    button.click();
    expect(downloadLogs).toHaveBeenCalledOnce();
    controls.close();
  });
  it("restores the saved expansion preference after reopening", async () => {
    let expanded = false;
    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: vi.fn(async () => ({ advancedExpanded: expanded })),
          set: vi.fn(async (value: { advancedExpanded: boolean }) => {
            expanded = value.advancedExpanded;
          }),
        },
      },
    });
    const noop = () => {};
    const actions = {
      play: noop,
      pause: noop,
      stop: noop,
      clickMode: noop,
      settings: noop,
      downloadLogs: noop,
      close: noop,
    };
    const first = createControls(actions);
    (
      first.host.shadowRoot!.getElementById(
        "advanced-toggle",
      ) as HTMLButtonElement
    ).click();
    first.close();
    const second = createControls(actions);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      second.host.shadowRoot!.getElementById("advanced-panel")!.hidden,
    ).toBe(false);
    second.close();
  });
  it("updates diagnostics only while expanded and retains visible list nodes", async () => {
    vi.useFakeTimers();
    try {
      const noop = () => {};
      const controls = createControls({
        play: noop,
        pause: noop,
        stop: noop,
        clickMode: noop,
        settings: noop,
        downloadLogs: noop,
        close: noop,
      });
      const root = controls.host.shadowRoot!;
      const toggle = root.getElementById(
        "advanced-toggle",
      ) as HTMLButtonElement;
      const details = root.querySelector("#advanced-panel > div")!;
      const snapshot: Snapshot = {
        state: "playing",
        index: 0,
        total: 1,
        offset: 0,
        highlightedIndex: 0,
        diagnostics: {
          readyCount: 1,
          readySeconds: 1,
          stage: "idle",
          underruns: 1,
          totalWaitMs: 0,
          gap: { index: 0, started: performance.now(), stage: "waiting" },
          sentences: [{ index: 0, text: "Hello", status: "ready" }],
        },
      };
      controls.update(snapshot);
      expect(details.querySelector("p")).toBeNull();
      toggle.click();
      expect(details.textContent).toContain("Ready ahead: 1 sentences");
      const item = details.querySelector("li");
      const before = details.textContent;
      await vi.advanceTimersByTimeAsync(1000);
      expect(details.textContent).not.toBe(before);
      expect(details.querySelector("li")).toBe(item);
      toggle.click();
      const collapsed = details.textContent;
      controls.update({
        ...snapshot,
        diagnostics: { ...snapshot.diagnostics!, readyCount: 2 },
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(details.textContent).toBe(collapsed);
      expect(details.querySelector("li")).toBe(item);
      toggle.click();
      expect(details.textContent).toContain("Ready ahead: 2 sentences");
      expect(details.querySelector("li")).toBe(item);
      controls.close();
    } finally {
      vi.useRealTimers();
    }
  });
  it("clears the elapsed timer on collapse and close", () => {
    vi.useFakeTimers();
    try {
      const noop = () => {};
      const controls = createControls({
        play: noop,
        pause: noop,
        stop: noop,
        clickMode: noop,
        settings: noop,
        downloadLogs: noop,
        close: noop,
      });
      const toggle = controls.host.shadowRoot!.getElementById(
        "advanced-toggle",
      ) as HTMLButtonElement;
      const clear = vi.spyOn(globalThis, "clearInterval");
      toggle.click();
      toggle.click();
      expect(clear).toHaveBeenCalledTimes(1);
      toggle.click();
      controls.close();
      expect(clear).toHaveBeenCalledTimes(2);
      clear.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
  it("explains click mode and failed targeting, then restores the prior status when disabled", () => {
    const noop = () => {};
    const controls = createControls({
      play: noop,
      pause: noop,
      stop: noop,
      clickMode: noop,
      settings: noop,
      downloadLogs: noop,
      close: noop,
    });
    controls.update({
      state: "error",
      index: 0,
      total: 0,
      offset: 0,
      highlightedIndex: null,
      error: "Select a passage.",
    });
    const status = controls.host.shadowRoot!.querySelector('[role="status"]')!;
    controls.setClickMode(true);
    expect(status.textContent).toContain("Hover over document text");
    expect(status.textContent).toContain("Esc to exit");
    controls.setClickFeedback("No readable sentence here.");
    expect(status.textContent).toContain("No readable sentence here.");
    controls.setClickFeedback();
    expect(status.textContent).toContain("Hover over document text");
    controls.setClickMode(false);
    expect(status.textContent).toBe("Select a passage.");
    controls.close();
  });
  it("offers an explicit selection action without interrupting playback automatically", () => {
    const actions = {
      play: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      clickMode: vi.fn(),
      settings: vi.fn(),
      downloadLogs: vi.fn(),
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
      downloadLogs: vi.fn(),
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
      "Start the server. · Click a sentence · Esc to exit",
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
      downloadLogs: noop,
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
