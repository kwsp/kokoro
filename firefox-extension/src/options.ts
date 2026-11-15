import { defaults, validateSettings } from "./settings";

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const status = document.getElementById("status")!;
const readForm = () =>
  validateSettings({
    baseUrl: input("base-url").value,
    token: input("token").value,
    voice: input("voice").value,
    speed: Number(input("speed").value),
  });

void browser.storage.local.get("settings").then((stored) => {
  const settings = { ...defaults, ...stored.settings };
  input("base-url").value = settings.baseUrl;
  input("token").value = settings.token;
  input("voice").value = settings.voice;
  input("speed").value = String(settings.speed);
});

document.getElementById("settings")!.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    try {
      await browser.storage.local.set({ settings: readForm() });
      status.textContent = "Settings saved.";
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : "Could not save settings.";
    }
  })();
});

document.getElementById("test")!.addEventListener("click", () => {
  void (async () => {
    try {
      const settings = readForm();
      const response = await fetch(`${settings.baseUrl}/v1/voices`, {
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
      const list = document.getElementById("voices")!;
      list.replaceChildren(
        ...result.voices.map((voice) => {
          const option = document.createElement("option");
          option.value = voice.id;
          return option;
        }),
      );
      status.textContent = `Connected. ${result.voices.length} voices available.`;
    } catch (error) {
      status.textContent =
        error instanceof TypeError
          ? "Cannot reach the local speech server."
          : error instanceof Error
            ? error.message
            : "Connection failed.";
    }
  })();
});
