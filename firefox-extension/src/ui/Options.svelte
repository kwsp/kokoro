<script lang="ts">
  import { onMount } from "svelte";
  import { defaults, validateSettings } from "../settings";
  import { WebAudioPlayer } from "../speech/audio";

  const defaultSample = `The Rainbow Passage
When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow. The rainbow is a division of white light into many beautiful colors. These take the shape of a long round arch, with its path high above, and its two ends apparently beyond the horizon. There is, according to legend, a boiling pot of gold at one end. People look, but no one ever finds it. When a man looks for something beyond his reach, his friends say he is looking for the pot of gold at the end of the rainbow. Throughout the centuries people have explained the rainbow in various ways. Some have accepted it as a miracle without physical explanation. To the Hebrews it was a token that there would be no more universal floods. The Greeks used to imagine that it was a sign from the gods to foretell war or heavy rain. The Norsemen considered the rainbow as a bridge over which the gods passed from earth to their home in the sky. Others have tried to explain the phenomenon physically. Aristotle thought that the rainbow was caused by reflection of the sun's rays by the rain. Since then physicists have found that it is not reflection, but refraction by the raindrops which causes the rainbows. Many complicated ideas about the rainbow have been formed. The difference in the rainbow depends considerably upon the size of the drops, and the width of the colored band increases as the size of the drops increases. The actual primary rainbow observed is said to be the effect of superimposition of a number of bows. If the red of the second bow falls upon the green of the first, the result is to give a bow with an abnormally wide yellow band, since red and green light when mixed form yellow. This is a very common type of bow, one showing mainly red and yellow, with little or no green or blue.`;
  let sampleText = $state(defaultSample);
  let sampleStatus = $state("");
  let sampleActive = $state(false);
  const player = new WebAudioPlayer();
  const sessionId = crypto.randomUUID();
  let leaseId = "";
  let requestId = "";
  let generation = 0;
  let port: browser.runtime.Port;
  let portConnected = false;
  // This map tracks protocol callbacks, not rendered state.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  function call(
    type: string,
    values: Record<string, unknown> = {},
  ): Promise<unknown> {
    const callId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(callId, { resolve, reject });
      try {
        port.postMessage({ type, sessionId, leaseId, callId, ...values });
      } catch {
        pending.delete(callId);
        reject(new Error("Sample connection closed."));
      }
    });
  }

  function stopSample(message = "Sample stopped.") {
    generation += 1;
    player.stop();
    const oldLease = leaseId;
    const oldRequest = requestId;
    leaseId = "";
    requestId = "";
    sampleActive = false;
    sampleStatus = message;
    if (oldLease && portConnected) {
      try {
        if (oldRequest)
          port.postMessage({
            type: "speech:cancel",
            sessionId,
            leaseId: oldLease,
            requestId: oldRequest,
          });
        port.postMessage({
          type: "reader:release",
          sessionId,
          leaseId: oldLease,
        });
      } catch {
        // A disconnected port is already released by the background.
      }
    }
  }

  async function playSample() {
    stopSample("");
    const current = ++generation;
    try {
      const settings = readForm();
      const text = sampleText;
      if (!text.trim() || Array.from(text).length > 4096)
        throw new Error("Choose a shorter, nonempty passage.");
      const activation = player.activate();
      leaseId = crypto.randomUUID();
      requestId = crypto.randomUUID();
      sampleActive = true;
      sampleStatus = "Preparing sample…";
      await Promise.all([activation, call("reader:claim")]);
      if (current !== generation) return;
      const audio = await call("speech:generate", {
        requestId,
        text,
        settings,
      });
      if (current !== generation) return;
      if (!(audio instanceof ArrayBuffer))
        throw new Error("No audio received.");
      const buffer = await player.decode(audio);
      if (current !== generation) return;
      player.play(buffer, 0, () => stopSample("Sample finished."));
      sampleStatus = "Playing sample.";
    } catch (error) {
      if (current !== generation) return;
      stopSample(
        error instanceof Error ? error.message : "Could not play sample.",
      );
    }
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
      const message = raw as {
        type?: string;
        leaseId?: string;
        callId: string;
        ok?: boolean;
        audio?: ArrayBuffer;
        error?: string;
      };
      if (
        message.type === "reader:stop" ||
        message.type === "reader:settings"
      ) {
        if (message.leaseId === leaseId) stopSample("Sample stopped.");
        port.postMessage({ type: "notice:ack", leaseId: message.leaseId });
        return;
      }
      const item = pending.get(message.callId);
      if (!item) return;
      pending.delete(message.callId);
      if (message.ok) item.resolve(message.audio);
      else item.reject(new Error(message.error || "Could not play sample."));
    });
    port.onDisconnect.addListener(() => {
      portConnected = false;
      if (sampleActive) stopSample("Sample connection closed.");
      for (const item of pending.values())
        item.reject(new Error("Sample connection closed."));
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
      stopSample("");
      player.close();
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

<h1>Kokoro settings</h1>
<p>Connect to your local speech server.</p>
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
          >{voices.length ? "Choose a voice" : "No voices available"}</option
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

<section aria-labelledby="sample-heading">
  <h2 id="sample-heading">Voice sample</h2>
  <label
    >Sample text<textarea id="sample-text" rows="8" bind:value={sampleText}
    ></textarea></label
  >
  <div class="actions sample-actions">
    <button
      type="button"
      id="play-sample"
      onclick={playSample}
      disabled={sampleActive}>Play sample</button
    >
    <button
      type="button"
      id="stop-sample"
      onclick={() => stopSample()}
      disabled={!sampleActive}>Stop</button
    >
  </div>
  <p id="sample-status" role="status">{sampleStatus}</p>
</section>
