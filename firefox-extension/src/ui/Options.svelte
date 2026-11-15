<script lang="ts">
  import { onMount } from "svelte";
  import { defaults, validateSettings } from "../settings";

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
    void browser.storage.local.get("settings").then((stored) => {
      const settings = { ...defaults, ...stored.settings };
      baseUrl = settings.baseUrl;
      token = settings.token;
      voice = settings.voice;
      speed = settings.speed;
      if (token.trim()) void loadVoices(false);
    });
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
