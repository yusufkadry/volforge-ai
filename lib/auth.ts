const encoder = new TextEncoder();
const SESSION_COOKIE = "volforge_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;

function toBase64Url(value: string) {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(padded);
}

async function signature(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const raw = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return toBase64Url(String.fromCharCode(...new Uint8Array(raw)));
}

export async function createSession(secret: string) {
  const payload = toBase64Url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }));
  return `${payload}.${await signature(payload, secret)}`;
}

export async function isValidSession(value: string | undefined, secret: string | undefined) {
  if (!value || !secret) return false;
  const [payload, received] = value.split(".");
  if (!payload || !received || received !== await signature(payload, secret)) return false;
  try {
    const parsed = JSON.parse(fromBase64Url(payload)) as { exp?: number };
    return typeof parsed.exp === "number" && parsed.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

export { SESSION_COOKIE, SESSION_TTL_SECONDS };
