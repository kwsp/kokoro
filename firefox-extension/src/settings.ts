export interface Settings {
  baseUrl: string;
  token: string;
  voice: string;
  speed: number;
}

export const defaults: Settings = {
  baseUrl: "http://127.0.0.1:8880",
  token: "",
  voice: "af_heart",
  speed: 1,
};

export function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== "object") throw new Error("Invalid settings.");
  const candidate = value as Record<string, unknown>;
  let url: URL;
  try {
    url = new URL(String(candidate.baseUrl));
  } catch {
    throw new Error("Enter a valid server URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Use an HTTP or HTTPS server URL without credentials, a path, query, or fragment.",
    );
  }
  if (typeof candidate.token !== "string" || !candidate.token.trim())
    throw new Error("Enter the local server token.");
  if (
    typeof candidate.voice !== "string" ||
    !/^[ab][fm]_[a-z0-9_]+$/.test(candidate.voice)
  )
    throw new Error("Choose an English Kokoro voice.");
  if (
    typeof candidate.speed !== "number" ||
    !Number.isFinite(candidate.speed) ||
    candidate.speed < 0.5 ||
    candidate.speed > 2
  )
    throw new Error("Speed must be between 0.5 and 2.");
  return {
    baseUrl: url.origin,
    token: candidate.token,
    voice: candidate.voice,
    speed: candidate.speed,
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get("settings");
  return validateSettings(stored.settings ?? defaults);
}
