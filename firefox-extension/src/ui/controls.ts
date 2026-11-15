import controlsCss from "./controls.css?raw";
import { flushSync, mount, unmount } from "svelte";
import Controls from "./Controls.svelte";
import type { Snapshot } from "../speech/session";

export const HOST_ID = "kokoro-reader-controls";

export function createControls(actions: {
  play: () => void;
  pause: () => void;
  stop: () => void;
  clickMode: () => void;
  settings: () => void;
  downloadLogs: () => void;
  close: () => void;
}) {
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText =
    "all:initial;position:fixed;bottom:16px;right:16px;z-index:2147483647;max-width:calc(100vw - 32px)";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = controlsCss;
  shadow.append(style);
  const controls = mount(Controls, { target: shadow, props: { actions } });
  document.documentElement.append(host);
  function update(next: Snapshot, note?: string) {
    if (host.dataset.state !== next.state) host.dataset.state = next.state;
    const sentence = String(next.index + 1);
    if (host.dataset.sentence !== sentence) host.dataset.sentence = sentence;
    flushSync(() => controls.update(next, note));
  }
  update({
    state: "ready",
    index: 0,
    total: 0,
    offset: 0,
    highlightedIndex: null,
  });
  return {
    host,
    update,
    setSelectionAvailable: (value: boolean) =>
      flushSync(() => controls.setSelectionAvailable(value)),
    setClickMode: (value: boolean) =>
      flushSync(() => controls.setClickMode(value)),
    setClickFeedback: (value?: string) =>
      flushSync(() => controls.setClickFeedback(value)),
    focus: () => controls.focus(),
    close: () => {
      controls.cleanup();
      void unmount(controls);
      host.remove();
    },
  };
}
