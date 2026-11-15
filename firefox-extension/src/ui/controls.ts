import { ChevronUp, createElement, Settings, X } from "lucide";
import type { Snapshot } from "../speech/session";

export const HOST_ID = "kokoro-reader-controls";

export function createControls(actions: {
  play: () => void;
  pause: () => void;
  stop: () => void;
  clickMode: () => void;
  settings: () => void;
  close: () => void;
}) {
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText =
    "all:initial;position:fixed;bottom:16px;right:16px;z-index:2147483647;max-width:calc(100vw - 32px)";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent =
    ":host{color-scheme:light}section{font:14px system-ui;color:#17252c;background:#fff;border:1px solid #c8d5db;border-radius:12px;padding:12px;box-shadow:0 4px 22px #0002}nav{display:flex;gap:8px;align-items:center;flex-wrap:wrap}button{font:inherit;padding:6px 10px;border-radius:6px;border:1px solid #bbc9ce;background:#f5f9fa;color:inherit;cursor:pointer}button.icon{display:inline-flex;align-items:center;justify-content:center;padding:6px}button.icon svg{width:18px;height:18px;display:block}#advanced-toggle[aria-expanded=true] svg{transform:rotate(180deg)}button:focus-visible{outline:3px solid #238072}button[aria-pressed=true]{background:#d5eee7;border-color:#238072}p{margin:8px 0 0;font-size:12px;max-width:32em;overflow-wrap:anywhere}.advanced{max-height:min(45vh,24em);overflow:auto;margin-bottom:10px;border-bottom:1px solid #c8d5db;padding-bottom:8px}.advanced p{margin:5px 0}.advanced ol{font-size:12px;margin:6px 0;padding-left:2em}.advanced li{margin:4px 0;overflow-wrap:anywhere}.advanced[hidden]{display:none}";
  shadow.append(style);
  const panel = document.createElement("section");
  panel.setAttribute("aria-label", "Kokoro reader");
  const nav = document.createElement("nav");
  const title = document.createElement("strong");
  title.textContent = "Kokoro";
  nav.append(title);
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  let snapshot: Snapshot = {
    state: "ready",
    index: 0,
    total: 0,
    offset: 0,
    highlightedIndex: null,
  };
  let selectionAvailable = false;
  let highlightNote: string | undefined;
  let clickModeEnabled = false;
  let clickFeedback: string | undefined;
  const addButton = (id: string, text: string, click: () => void) => {
    const button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", click);
    nav.append(button);
    return button;
  };
  const setIcon = (
    button: HTMLButtonElement,
    label: string,
    icon: Parameters<typeof createElement>[0],
  ) => {
    button.classList.add("icon");
    button.setAttribute("aria-label", label);
    button.title = label;
    button.replaceChildren(createElement(icon, { "aria-hidden": "true" }));
  };
  const play = addButton("play", "Play", () => {
    if (
      !selectionAvailable &&
      (snapshot.state === "playing" || snapshot.state === "preparing")
    )
      actions.pause();
    else actions.play();
  });
  addButton("stop", "Stop", actions.stop);
  const clickMode = addButton("click-mode", "Click to read", actions.clickMode);
  clickMode.setAttribute("aria-pressed", "false");
  clickMode.title = "Choose a sentence on the page. Escape exits this mode.";
  setIcon(addButton("settings", "", actions.settings), "Settings", Settings);
  setIcon(addButton("close", "", actions.close), "Close", X);
  const advanced = document.createElement("div");
  advanced.className = "advanced";
  advanced.id = "advanced-panel";
  advanced.hidden = true;
  const details = document.createElement("div");
  advanced.append(details);
  const toggle = addButton("advanced-toggle", "Advanced", () => {
    setExpanded(advanced.hidden);
    void browser.storage.local
      .set({ advancedExpanded: !advanced.hidden })
      .catch(() => {});
  });
  setIcon(toggle, "Advanced", ChevronUp);
  toggle.setAttribute("aria-controls", advanced.id);
  toggle.setAttribute("aria-expanded", "false");
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let preferenceChanged = false;
  function renderDiagnostics() {
    const d = snapshot.diagnostics;
    details.replaceChildren();
    if (!d) return;
    const line = (text: string) => {
      const p = document.createElement("p");
      p.textContent = text;
      details.append(p);
    };
    line(
      `Ready ahead: ${d.readyCount} sentences · ${d.readySeconds.toFixed(1)} seconds`,
    );
    line(`Preparation: ${d.stage}${d.reason ? ` · ${d.reason}` : ""}`);
    line(
      `Latest preparation: ${d.lastPreparationMs === undefined ? "none yet" : `${(d.lastPreparationMs / 1000).toFixed(1)} seconds`}`,
    );
    const gapMs =
      d.gap && (d.gap.durationMs ?? performance.now() - d.gap.started);
    line(
      `Underruns: ${d.underruns} · total wait ${((d.totalWaitMs + (d.gap && d.gap.durationMs === undefined ? gapMs! : 0)) / 1000).toFixed(1)} seconds`,
    );
    if (d.gap && gapMs !== undefined)
      line(
        `Last gap: sentence ${d.gap.index + 1} · ${(gapMs / 1000).toFixed(1)} seconds · ${d.gap.stage}`,
      );
    const list = document.createElement("ol");
    list.start = snapshot.index + 1;
    for (const sentence of d.sentences) {
      const item = document.createElement("li");
      const snippet =
        sentence.text.length > 100
          ? `${sentence.text.slice(0, 100)}…`
          : sentence.text;
      item.textContent = `${snippet} · ${sentence.status}${sentence.duration === undefined ? "" : ` · ${sentence.duration.toFixed(1)} seconds`}`;
      list.append(item);
    }
    details.append(list);
  }
  function setExpanded(expanded: boolean) {
    advanced.hidden = !expanded;
    toggle.setAttribute("aria-expanded", String(expanded));
    if (timer) clearInterval(timer);
    timer = undefined;
    if (expanded) {
      renderDiagnostics();
      timer = setInterval(renderDiagnostics, 1000);
    }
  }
  toggle.addEventListener("click", () => {
    preferenceChanged = true;
  });
  void browser.storage.local
    .get("advancedExpanded")
    .then((stored) => {
      if (!closed && !preferenceChanged && stored.advancedExpanded === true)
        setExpanded(true);
    })
    .catch(() => {});
  panel.append(advanced, nav, status);
  shadow.append(panel);
  document.documentElement.append(host);
  function update(next: Snapshot, note?: string) {
    snapshot = next;
    if (!advanced.hidden) renderDiagnostics();
    highlightNote = note;
    if (host.dataset.state !== next.state) host.dataset.state = next.state;
    const sentence = String(next.index + 1);
    if (host.dataset.sentence !== sentence) host.dataset.sentence = sentence;
    play.textContent = selectionAvailable
      ? "Read selection"
      : next.state === "playing" || next.state === "preparing"
        ? "Pause"
        : next.state === "error"
          ? next.error?.startsWith("Page changed")
            ? "Play"
            : "Retry"
          : next.state === "paused"
            ? "Resume"
            : "Play";
    const label = next.state[0]!.toUpperCase() + next.state.slice(1);
    let statusText = selectionAvailable
      ? "Selected text is ready to read."
      : (next.error ??
        (next.total
          ? `Sentence ${next.index + 1} of ${next.total} · ${label}`
          : "Select a passage, then press Read selection."));
    if (note) statusText += ` · ${note}`;
    if (clickModeEnabled) {
      if (clickFeedback) statusText = clickFeedback;
      else if (!next.total)
        statusText = "Hover over document text to choose a sentence.";
      statusText += " · Click a sentence · Esc to exit";
    }
    if (status.textContent !== statusText) status.textContent = statusText;
  }
  update(snapshot);
  return {
    host,
    update,
    setSelectionAvailable: (available: boolean) => {
      selectionAvailable = available;
      update(snapshot, highlightNote);
    },
    setClickMode: (enabled: boolean) => {
      clickModeEnabled = enabled;
      clickFeedback = undefined;
      clickMode.setAttribute("aria-pressed", String(enabled));
      update(snapshot, highlightNote);
    },
    setClickFeedback: (message?: string) => {
      if (clickFeedback === message) return;
      clickFeedback = message;
      update(snapshot, highlightNote);
    },
    focus: () => play.focus(),
    close: () => {
      closed = true;
      if (timer) clearInterval(timer);
      host.remove();
    },
  };
}
