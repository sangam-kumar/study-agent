// Auth for /admin/* routes. Separate from the Telegram webhook secret so that leaking one
// does not grant the other. If ADMIN_TOKEN is not configured the admin routes are disabled
// everywhere, including local dev (unlike the webhook, which skips its check without a secret).

const enc = new TextEncoder();

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/** Compare via fixed-length digests so the comparison time does not depend on where strings differ. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}

export async function isAdminAuthorized(authorization: string | null, token: string | undefined): Promise<boolean> {
  if (!token || !authorization) return false;
  const m = /^Bearer (.+)$/.exec(authorization);
  if (!m) return false;
  return safeEqual(m[1], token);
}
