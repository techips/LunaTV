/**
 * middleware（Edge 运行时）使用的会话校验，基于 WebCrypto。
 * 算法须与 src/lib/server-secret.ts + src/lib/session.ts 保持一致：
 *   secret = SESSION_SECRET || sha256hex("lunatv:session:" + PASSWORD)
 *   sig    = hmacSha256hex(secret, "session:" + u + "|" + v + "|" + exp)
 */

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function deriveSecret(): Promise<string> {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`lunatv:session:${process.env.PASSWORD || ''}`)
  );
  return toHex(digest);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifySessionCookieEdge(raw: string | undefined): Promise<boolean> {
  if (!raw) return false;
  let t: { u?: unknown; v?: unknown; exp?: unknown; sig?: unknown };
  try {
    t = JSON.parse(decodeURIComponent(raw));
  } catch {
    return false;
  }
  if (
    typeof t.u !== 'string' ||
    typeof t.v !== 'number' ||
    typeof t.exp !== 'number' ||
    typeof t.sig !== 'string' ||
    t.exp <= Date.now()
  ) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(await deriveSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = toHex(
    await crypto.subtle.sign('HMAC', key, encoder.encode(`session:${t.u}|${t.v}|${t.exp}`))
  );
  return constantTimeEqual(sig, t.sig);
}
