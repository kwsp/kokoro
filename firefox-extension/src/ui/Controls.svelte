<script lang="ts">
  import { ChevronUp, createElement, Settings, X } from "lucide";
  import { flushSync } from "svelte";
  import Diagnostics from "./Diagnostics.svelte";
  import type { Snapshot } from "../speech/session";

  let {
    actions,
  }: {
    actions: {
      play: () => void;
      pause: () => void;
      stop: () => void;
      clickMode: () => void;
      settings: () => void;
      close: () => void;
    };
  } = $props();
  let snapshot: Snapshot = $state.raw({
    state: "ready",
    index: 0,
    total: 0,
    offset: 0,
    highlightedIndex: null,
  });
  let selectionAvailable = $state(false);
  let highlightNote = $state<string | undefined>();
  let clickModeEnabled = $state(false);
  let clickFeedback = $state<string | undefined>();
  let expanded = $state(false);
  let now = $state(performance.now());
  let diagnosticSnapshot: Snapshot | undefined = $state.raw();
  let playButton: HTMLButtonElement;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let preferenceChanged = false;
  function icon(
    node: HTMLElement,
    definition: Parameters<typeof createElement>[0],
  ) {
    node.append(createElement(definition, { "aria-hidden": "true" }));
  }
  function setExpanded(value: boolean) {
    expanded = value;
    if (timer) clearInterval(timer);
    timer = undefined;
    if (value) {
      diagnosticSnapshot = snapshot;
      now = performance.now();
      timer = setInterval(() => {
        now = performance.now();
      }, 1000);
    }
  }
  function toggle() {
    preferenceChanged = true;
    flushSync(() => setExpanded(!expanded));
    void browser.storage.local
      .set({ advancedExpanded: expanded })
      .catch(() => {});
  }
  void browser.storage.local
    .get("advancedExpanded")
    .then((stored) => {
      if (!closed && !preferenceChanged && stored.advancedExpanded === true)
        flushSync(() => setExpanded(true));
    })
    .catch(() => {});
  let playText = $derived(
    selectionAvailable
      ? "Read selection"
      : snapshot.state === "playing" || snapshot.state === "preparing"
        ? "Pause"
        : snapshot.state === "error"
          ? snapshot.error?.startsWith("Page changed")
            ? "Play"
            : "Retry"
          : snapshot.state === "paused"
            ? "Resume"
            : "Play",
  );
  let statusText = $derived.by(() => {
    const label = snapshot.state[0]!.toUpperCase() + snapshot.state.slice(1);
    let text = selectionAvailable
      ? "Selected text is ready to read."
      : (snapshot.error ??
        (snapshot.total
          ? `Sentence ${snapshot.index + 1} of ${snapshot.total} · ${label}`
          : "Select a passage, then press Read selection."));
    if (highlightNote) text += ` · ${highlightNote}`;
    if (clickModeEnabled) {
      if (clickFeedback) text = clickFeedback;
      else if (!snapshot.total)
        text = "Hover over document text to choose a sentence.";
      text += " · Click a sentence · Esc to exit";
    }
    return text;
  });
  export function update(next: Snapshot, note?: string) {
    snapshot = { ...next };
    highlightNote = note;
    if (expanded) {
      diagnosticSnapshot = snapshot;
      now = performance.now();
    }
  }
  export function setSelectionAvailable(value: boolean) {
    selectionAvailable = value;
  }
  export function setClickMode(value: boolean) {
    clickModeEnabled = value;
    clickFeedback = undefined;
  }
  export function setClickFeedback(value?: string) {
    clickFeedback = value;
  }
  export function focus() {
    playButton.focus();
  }
  export function cleanup() {
    closed = true;
    if (timer) clearInterval(timer);
  }
</script>

<section aria-label="Kokoro reader">
  <div class="advanced" id="advanced-panel" hidden={!expanded}>
    <div>
      {#if diagnosticSnapshot}
        <Diagnostics snapshot={diagnosticSnapshot} {now} />
      {/if}
    </div>
  </div>
  <nav>
    <strong>Kokoro</strong>
    <button
      id="play"
      type="button"
      bind:this={playButton}
      onclick={() => {
        if (
          !selectionAvailable &&
          (snapshot.state === "playing" || snapshot.state === "preparing")
        )
          actions.pause();
        else actions.play();
      }}>{playText}</button
    >
    <button id="stop" type="button" onclick={actions.stop}>Stop</button>
    <button
      id="click-mode"
      type="button"
      aria-pressed={clickModeEnabled}
      title="Choose a sentence on the page. Escape exits this mode."
      onclick={actions.clickMode}>Click to read</button
    >
    <button
      id="settings"
      type="button"
      class="icon"
      aria-label="Settings"
      title="Settings"
      use:icon={Settings}
      onclick={actions.settings}
    ></button>
    <button
      id="close"
      type="button"
      class="icon"
      aria-label="Close"
      title="Close"
      use:icon={X}
      onclick={actions.close}
    ></button>
    <button
      id="advanced-toggle"
      type="button"
      class="icon"
      aria-label="Advanced"
      title="Advanced"
      aria-controls="advanced-panel"
      aria-expanded={expanded}
      use:icon={ChevronUp}
      onclick={toggle}
    ></button>
  </nav>
  <p role="status">{statusText}</p>
</section>
