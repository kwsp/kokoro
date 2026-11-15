<script lang="ts">
  import { onMount } from "svelte";
  import { defaults, validateSettings } from "../settings";

  let baseUrl = $state("");
  let token = $state("");
  let voice = $state("");
  let speed = $state<number | undefined>();
  let status = $state("");
  let voices = $state<string[]>([]);

  const readForm = () =>
    validateSettings({ baseUrl, token, voice, speed: Number(speed) });

  onMount(() => {
    void browser.storage.local.get("settings").then((stored) => {
      const settings = { ...defaults, ...stored.settings };
      baseUrl = settings.baseUrl;
      token = settings.token;
      voice = settings.voice;
      speed = settings.speed;
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

  async function testConnection() {
    try {
      const settings = readForm();
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
      voices = result.voices.map((item) => item.id);
      status = `Connected. ${result.voices.length} voices available.`;
    } catch (error) {
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
    /></label
  >
  <label
    >Server token<input
      id="token"
      type="password"
      autocomplete="off"
      required
      bind:value={token}
    /></label
  >
  <label
    >Voice<input
      id="voice"
      list="voices"
      required
      bind:value={voice}
    /><datalist id="voices"
      >{#each voices as item}<option value={item}></option>{/each}</datalist
    ></label
  >
  <label
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
  <button type="submit">Save settings</button>
  <button type="button" id="test" onclick={testConnection}
    >Test connection</button
  >
</form>
<p id="status" role="status">{status}</p>
