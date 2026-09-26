/**
 * Webhook authenticity. Meta signs every delivery with the app secret.
 *
 * Without this check the webhook is an open endpoint that anyone who learns the
 * URL can use to spoof trips and drain the fleet.
 */

/**
 * Verify the `X-Hub-Signature-256` header against the raw body.
 *
 * The raw body text matters — re-serializing the parsed JSON changes the bytes
 * and the signature will not match.
 */
export async function verifySignature(
  rawBody: string,
  header: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;

  const expected = header.slice("sha256=".length).toLowerCase();

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const actual = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(expected, actual);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** The one-time GET handshake Meta performs when you save the webhook URL. */
export function handleVerification(
  url: URL,
  verifyToken: string,
): { ok: true; challenge: string } | { ok: false } {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === verifyToken && challenge) {
    return { ok: true, challenge };
  }
  return { ok: false };
}
