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

function isPrivateHttpHost(hostname: string): boolean {
  if (hostname === "localhost") return true;
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part)))
    return false;
  return (
    octets[0] === 127 ||
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

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
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isPrivateHttpHost(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Use HTTPS, or HTTP with a loopback or private LAN IPv4 address (for example http://192.168.1.10:8880).",
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
