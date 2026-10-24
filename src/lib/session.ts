/**
 * 会话 Cookie。
 *
 * - `auth`（HttpOnly）：签名令牌，内容为 用户名 | 会话版本号 | 过期时间 | 签名。
 *   签名密钥为 SESSION_SECRET（未配置时由站长密码派生），服务端校验过期时间；
 *   用户改密 / 被封禁 / 被删除时递增会话版本号，旧令牌立即失效。
 * - `auth_info`（前端可读）：仅含用户名和角色，供界面展示，不含任何凭据。
 *
 * 签名算法须与 src/lib/session-edge.ts（middleware 使用的 WebCrypto 实现）保持一致。
 */

import { hmacHex, safeEqualHex } from './server-secret';

export const SESSION_COOKIE = 'auth';
export const SESSION_INFO_COOKIE = 'auth_info';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type Role = 'owner' | 'admin' | 'user';

export interface SessionToken {
  /** 用户名；localstorage 模式下为空字符串 */
  u: string;
  /** 会话版本号 */
  v: number;
  /** 过期时间（毫秒时间戳） */
  exp: number;
  sig: string;
}

export function sessionPayload(u: string, v: number, exp: number): string {
  return `${u}|${v}|${exp}`;
}

export function signSession(u: string, v: number, exp: number): string {
  return hmacHex('session', sessionPayload(u, v, exp));
}

/** 返回 JSON 字符串；写入 cookie 时由 Next 负责 URL 编码 */
export function createSessionToken(username: string, version: number, now = Date.now()): string {
  const exp = now + SESSION_TTL_MS;
  const token: SessionToken = { u: username, v: version, exp, sig: signSession(username, version, exp) };
  return JSON.stringify(token);
}

/** cookie 值可能是原始 JSON，也可能被编码过一到两次（不同读取方式），逐层尝试解析 */
export function parseCookieJson(raw: string): unknown {
  let cur = raw;
  for (let i = 0; i < 3; i++) {
    try {
      return JSON.parse(cur);
    } catch {
      try {
        const next = decodeURIComponent(cur);
        if (next === cur) return null;
        cur = next;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function parseSessionToken(raw: string | undefined | null): SessionToken | null {
  if (!raw) return null;
  try {
    const t = parseCookieJson(raw) as Partial<SessionToken> | null;
    if (
      t &&
      typeof t?.u === 'string' &&
      typeof t?.v === 'number' &&
      typeof t?.exp === 'number' &&
      typeof t?.sig === 'string'
    ) {
      return t as SessionToken;
    }
  } catch {
    // ignore
  }
  return null;
}

/** 校验签名与过期时间（不含会话版本号，版本号需要查库，见 require-auth） */
export function verifySessionToken(t: SessionToken | null, now = Date.now()): boolean {
  if (!t || t.exp <= now) return false;
  return safeEqualHex(signSession(t.u, t.v, t.exp), t.sig);
}

export interface CookieSpec {
  name: string;
  value: string;
  options: {
    path: string;
    expires: Date;
    sameSite: 'lax';
    httpOnly: boolean;
    secure: boolean;
  };
}

export function buildSessionCookies(
  username: string,
  role: Role,
  version: number,
  secure: boolean,
  now = Date.now()
): CookieSpec[] {
  const expires = new Date(now + SESSION_TTL_MS);
  return [
    {
      name: SESSION_COOKIE,
      value: createSessionToken(username, version, now),
      options: { path: '/', expires, sameSite: 'lax', httpOnly: true, secure },
    },
    {
      name: SESSION_INFO_COOKIE,
      value: JSON.stringify({ username, role }),
      options: { path: '/', expires, sameSite: 'lax', httpOnly: false, secure },
    },
  ];
}

export function buildClearCookies(secure: boolean): CookieSpec[] {
  const expires = new Date(0);
  return [SESSION_COOKIE, SESSION_INFO_COOKIE].map((name) => ({
    name,
    value: '',
    options: {
      path: '/',
      expires,
      sameSite: 'lax' as const,
      httpOnly: name === SESSION_COOKIE,
      secure,
    },
  }));
}

// 判断当前请求是否走 HTTPS，用于决定 Cookie 的 Secure 属性
export function isHttpsRequest(req: Request): boolean {
  const forwardedProto = req.headers
    .get('x-forwarded-proto')
    ?.split(',')[0]
    .trim()
    .toLowerCase();
  if (forwardedProto) return forwardedProto === 'https';
  return new URL(req.url).protocol === 'https:';
}
