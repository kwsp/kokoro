import type { Snapshot } from "./session";

export const HOST_ID = "kokoro-reader-controls";

export function createControls(actions: {
  play: () => void;
  pause: () => void;
  stop: () => void;
  settings: () => void;
  close: () => void;
}) {
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText =
    "all:initial;position:fixed;bottom:20px;right:20px;z-index:2147483647;max-width:calc(100vw - 24px)";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent =
    ":host{color-scheme:light}section{font:14px system-ui;color:#17252c;background:#fff;border:1px solid #c8d5db;border-radius:12px;padding:12px;box-shadow:0 4px 22px #0002}nav{display:flex;gap:8px;align-items:center;flex-wrap:wrap}button{font:inherit;padding:6px 10px;border-radius:6px;border:1px solid #bbc9ce;background:#f5f9fa;color:inherit;cursor:pointer}button:focus-visible{outline:3px solid #238072}p{margin:8px 0 0;font-size:12px;max-width:32em;overflow-wrap:anywhere}";
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
  const addButton = (id: string, text: string, click: () => void) => {
    const button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", click);
    nav.append(button);
    return button;
  };
  const play = addButton("play", "Play", () => {
    if (snapshot.state === "playing" || snapshot.state === "preparing")
      actions.pause();
    else actions.play();
  });
  addButton("stop", "Stop", actions.stop);
  addButton("settings", "Settings", actions.settings);
  addButton("close", "Close", actions.close);
  panel.append(nav, status);
  shadow.append(panel);
  document.documentElement.append(host);
  function update(next: Snapshot) {
    snapshot = next;
    host.dataset.state = next.state;
    host.dataset.sentence = String(next.index + 1);
    play.textContent =
      next.state === "playing" || next.state === "preparing"
        ? "Pause"
        : next.state === "error"
          ? "Retry"
          : next.state === "paused"
            ? "Resume"
            : "Play";
    const label = next.state[0]!.toUpperCase() + next.state.slice(1);
    status.textContent =
      next.error ??
      (next.total
        ? `Sentence ${next.index + 1} of ${next.total} · ${label}`
        : "Select a passage, then activate Kokoro again.");
  }
  update(snapshot);
  return {
    host,
    update,
    focus: () => play.focus(),
    close: () => host.remove(),
  };
}
