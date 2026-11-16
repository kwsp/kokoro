<script lang="ts">
  import { onMount, tick } from "svelte";
  import { defaults, validateSettings, type Settings } from "../settings";
  import { sentenceOffsets } from "../reading/mapping";
  import { ReadingSession, type Snapshot } from "../speech/session";
  import { WebAudioPlayer } from "../speech/audio";

  const defaultSample = `The Rainbow Passage
When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow. The rainbow is a division of white light into many beautiful colors. These take the shape of a long round arch, with its path high above, and its two ends apparently beyond the horizon. There is, according to legend, a boiling pot of gold at one end. People look, but no one ever finds it. When a man looks for something beyond his reach, his friends say he is looking for the pot of gold at the end of the rainbow. Throughout the centuries people have explained the rainbow in various ways. Some have accepted it as a miracle without physical explanation. To the Hebrews it was a token that there would be no more universal floods. The Greeks used to imagine that it was a sign from the gods to foretell war or heavy rain. The Norsemen considered the rainbow as a bridge over which the gods passed from earth to their home in the sky. Others have tried to explain the phenomenon physically. Aristotle thought that the rainbow was caused by reflection of the sun's rays by the rain. Since then physicists have found that it is not reflection, but refraction by the raindrops which causes the rainbows. Many complicated ideas about the rainbow have been formed. The difference in the rainbow depends considerably upon the size of the drops, and the width of the colored band increases as the size of the drops increases. The actual primary rainbow observed is said to be the effect of superimposition of a number of bows. If the red of the second bow falls upon the green of the first, the result is to give a bow with an abnormally wide yellow band, since red and green light when mixed form yellow. This is a very common type of bow, one showing mainly red and yellow, with little or no green or blue.`;
  let sampleText = $state(defaultSample);
  let editing = $state(false);
  let offsets = $state(sentenceOffsets(defaultSample));
  let snapshot = $state<Snapshot>({
    state: "ready",
    index: 0,
    total: 0,
    offset: 0,
    highlightedIndex: null,
  });
  let message = $state("");
  let pane: HTMLElement;
  const player = new WebAudioPlayer();
  const sessionId = crypto.randomUUID();
  let port: browser.runtime.Port;
  let portConnected = false;
  let runSettings: Settings | undefined;
  // Protocol callbacks do not drive rendered state.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const segments = () =>
    offsets.map(({ start, end }) => ({ text: sampleText.slice(start, end) }));
  function call(
    type: string,
    leaseId: string,
    values: Record<string, unknown> = {},
  ): Promise<unknown> {
    const callId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(callId, { resolve, reject });
      try {
        port.postMessage({ type, sessionId, leaseId, callId, ...values });
      } catch {
        pending.delete(callId);
        reject(new Error("Reading connection closed."));
      }
    });
  }
  function send(
    type: string,
    leaseId: string,
    values: Record<string, unknown> = {},
  ) {
    if (!portConnected) return;
    try {
      port.postMessage({ type, sessionId, leaseId, ...values });
    } catch {
      /* Disconnection releases ownership. */
    }
  }
  const session = new ReadingSession(
    segments(),
    player,
    {
      async claim(leaseId) {
        await call("reader:claim", leaseId);
      },
      release(leaseId) {
        send("reader:release", leaseId);
      },
      async fetch(text, requestId, leaseId, maxBytes) {
        const audio = await call("speech:generate", leaseId, {
          requestId,
          text,
          settings: runSettings,
          maxBytes,
        });
        if (!(audio instanceof ArrayBuffer))
          throw new Error("No audio received.");
        return audio;
      },
      cancel(requestId, leaseId) {
        send("speech:cancel", leaseId, { requestId });
      },
    },
    (next) => {
      const previous = snapshot.highlightedIndex;
      snapshot = next;
      if (
        next.highlightedIndex !== null &&
        next.highlightedIndex !== previous
      ) {
        requestAnimationFrame(() => {
          const element = pane?.querySelector<HTMLElement>(
            `[data-sentence-index="${next.highlightedIndex}"]`,
          );
          if (!element || !pane) return;
          if (snapshot.highlightedIndex !== next.highlightedIndex) return;
          const bounds = pane.getBoundingClientRect();
          const rects = element.getClientRects();
          const first = rects[0];
          const last = rects[rects.length - 1];
          if (!first || !last) return;
          if (first.top < bounds.top) pane.scrollTop += first.top - bounds.top;
          else if (last.bottom > bounds.bottom)
            pane.scrollTop += last.bottom - bounds.bottom;
        });
      }
    },
  );
  function captureSettings(): boolean {
    try {
      runSettings = readForm();
      message = "";
      return true;
    } catch (error) {
      message = error instanceof Error ? error.message : "Check settings.";
      return false;
    }
  }
  function playPause() {
    if (snapshot.state === "playing" || snapshot.state === "preparing") {
      session.pause();
      return;
    }
    if (snapshot.state !== "paused" && !captureSettings()) return;
    if (!offsets.length) {
      message = "Enter text to read.";
      return;
    }
    session.play();
  }
  function seek(index: number, pointer = false) {
    if (pointer && window.getSelection()?.toString()) return;
    if (!captureSettings()) return;
    message = "";
    session.seek(index);
  }
  async function toggleEdit() {
    if (!editing) {
      session.stop();
      editing = true;
    } else {
      offsets = sentenceOffsets(sampleText);
      session.replaceSegments(segments());
      editing = false;
    }
    message = "";
    await tick();
    document.getElementById(editing ? "sample-text" : "edit-text")?.focus();
  }

  let baseUrl = $state("");
  let token = $state("");
  let voice = $state("");
  let speed = $state<number | undefined>();
  let status = $state("");
  let voices = $state<string[]>([]);
  let requestGeneration = 0;

  const readForm = () =>
    validateSettings({ baseUrl, token, voice, speed: Number(speed) });

  onMount(() => {
    port = browser.runtime.connect({ name: "voice-preview" });
    portConnected = true;
    port.onMessage.addListener((raw) => {
      const value = raw as {
        type?: string;
        leaseId?: string;
        callId: string;
        ok?: boolean;
        audio?: ArrayBuffer;
        error?: string;
      };
      if (value.type === "reader:stop" || value.type === "reader:settings") {
        if (value.leaseId) session.revoke(value.leaseId);
        port.postMessage({ type: "notice:ack", leaseId: value.leaseId });
        return;
      }
      const item = pending.get(value.callId);
      if (!item) return;
      pending.delete(value.callId);
      if (value.ok) item.resolve(value.audio);
      else item.reject(new Error(value.error || "Could not read text."));
    });
    port.onDisconnect.addListener(() => {
      portConnected = false;
      session.stop();
      message = "Reading connection closed.";
      for (const item of pending.values()) item.reject(new Error(message));
      pending.clear();
    });
    void browser.storage.local.get("settings").then((stored) => {
      const settings = { ...defaults, ...stored.settings };
      baseUrl = settings.baseUrl;
      token = settings.token;
      voice = settings.voice;
      speed = settings.speed;
      if (token.trim()) void loadVoices(false);
    });
    return () => {
      session.close();
      port.disconnect();
    };
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    status = "Saving settings…";
    try {
      await browser.storage.local.set({ settings: readForm() });
      status = "Settings saved.";
    } catch (error) {
      status =
        error instanceof Error ? error.message : "Could not save settings.";
    }
  }

  function credentialsChanged() {
    requestGeneration += 1;
    voices = [];
    status = "";
  }

  async function loadVoices(reportStatus: boolean) {
    const generation = ++requestGeneration;
    voices = [];
    if (reportStatus) status = "Checking connection…";
    try {
      // Voice discovery only depends on the endpoint and token.
      const settings = validateSettings({
        baseUrl,
        token,
        voice: defaults.voice,
        speed: defaults.speed,
      });
      const response = await fetch(`${settings.baseUrl}/v1/voices`, {
        redirect: "error",
        headers: { Authorization: `Bearer ${settings.token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "Incorrect server token."
            : "Server connection failed.",
        );
      const result = (await response.json()) as { voices: { id: string }[] };
      if (generation !== requestGeneration) return;
      voices = result.voices.map((item) => item.id);
      if (reportStatus)
        status = `Connected. ${voices.length} voices available.`;
    } catch (error) {
      if (generation !== requestGeneration) return;
      if (reportStatus)
        status =
          error instanceof TypeError
            ? "Cannot reach the local speech server."
            : error instanceof Error
              ? error.message
              : "Connection failed.";
    }
  }
</script>

<div class="workspace-shell">
  <aside id="settings-panel" aria-labelledby="settings-heading">
    <div class="brand">Kokoro</div>
    <h2 id="settings-heading">Settings</h2>
    <p class="intro">Connect to your local speech server.</p>
    <form id="settings" onsubmit={save}>
      <label
        >Server URL<input
          id="base-url"
          type="url"
          required
          bind:value={baseUrl}
          oninput={credentialsChanged}
        /></label
      >
      <label
        >Server token<input
          id="token"
          type="password"
          autocomplete="off"
          required
          bind:value={token}
          oninput={credentialsChanged}
        /></label
      >
      <div class="voice-fields">
        <label>Voice<input id="voice" required bind:value={voice} /></label>
        <label
          >Available voices<select
            id="voices"
            value={voices.includes(voice) ? voice : ""}
            onchange={(event) => {
              if (event.currentTarget.value) voice = event.currentTarget.value;
            }}
            disabled={voices.length === 0}
          >
            <option value="" disabled
              >{voices.length
                ? "Choose a voice"
                : "No voices available"}</option
            >
            {#each voices as item}<option value={item}>{item}</option>{/each}
          </select></label
        >
      </div>
      <label class="speed-field"
        >Speed<input
          id="speed"
          type="number"
          min="0.5"
          max="2"
          step="0.1"
          required
          bind:value={speed}
        /></label
      >
      <div class="actions">
        <button type="submit">Save settings</button>
        <button type="button" id="test" onclick={() => loadVoices(true)}
          >Test connection</button
        >
      </div>
    </form>
    <p id="status" role="status">{status}</p>
  </aside>
  <main id="workspace">
    <header class="workspace-header">
      <div>
        <h1>Text to speech</h1>
      </div>
      <button type="button" id="edit-text" onclick={toggleEdit}
        >{editing ? "Done" : "Edit text"}</button
      >
    </header>
    <div class="playback" aria-label="Playback controls">
      <button
        type="button"
        id="play-sample"
        class="primary"
        onclick={playPause}
        disabled={editing}
      >
        {snapshot.state === "playing" || snapshot.state === "preparing"
          ? "Pause"
          : snapshot.state === "paused"
            ? "Resume"
            : "Play"}
      </button>
      <button
        type="button"
        id="stop-sample"
        onclick={() => {
          session.stop();
          message = "";
        }}
        disabled={editing || snapshot.state === "ready"}>Stop</button
      >
      <p id="sample-status" role="status">
        {message ||
          snapshot.error ||
          {
            ready: "Ready",
            preparing: "Preparing…",
            playing: "Playing",
            paused: "Paused",
            finished: "Finished",
            error: "Playback error",
          }[snapshot.state]}
      </p>
    </div>
    <div id="passage-pane" bind:this={pane}>
      {#if editing}
        <label class="edit-label" for="sample-text">Text to read</label>
        <textarea id="sample-text" bind:value={sampleText}></textarea>
      {:else}
        <div id="passage-text">
          {#each offsets as part, index}{sampleText.slice(
              index ? offsets[index - 1]!.end : 0,
              part.start,
            )}<span
              role="button"
              tabindex="0"
              data-sentence-index={index}
              class:speaking={snapshot.highlightedIndex === index &&
                snapshot.state === "playing"}
              class:paused={snapshot.highlightedIndex === index &&
                snapshot.state === "paused"}
              onclick={(event) => {
                if (
                  event.button === 0 &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.shiftKey &&
                  !event.altKey
                )
                  seek(index, true);
              }}
              onkeydown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  seek(index);
                }
              }}>{sampleText.slice(part.start, part.end)}</span
            >{/each}{sampleText.slice(offsets.at(-1)?.end ?? 0)}
        </div>
      {/if}
    </div>
    {#if !editing}<p class="hint">Click a sentence to play from there.</p>{/if}
  </main>
</div>
