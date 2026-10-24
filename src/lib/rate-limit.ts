/**
 * 登录失败限流（进程内）。
 * 同一用户名或同一来源 IP 连续失败后锁定一段时间，锁定时长随失败次数指数增长。
 */

const MAX_FREE_ATTEMPTS = 5;
const BASE_LOCK_MS = 60 * 1000;
const MAX_LOCK_MS = 30 * 60 * 1000;
const FORGET_AFTER_MS = 60 * 60 * 1000;

interface Entry {
  failures: number;
  lockedUntil: number;
  lastFailure: number;
}

const entries = new Map<string, Entry>();

function prune(now: number) {
  if (entries.size < 5000) return;
  entries.forEach((e, k) => {
    if (now - e.lastFailure > FORGET_AFTER_MS) entries.delete(k);
  });
}

/** 返回需要等待的毫秒数；0 表示允许尝试 */
export function loginRetryAfter(keys: string[], now = Date.now()): number {
  let wait = 0;
  for (const k of keys) {
    const e = entries.get(k);
    if (e && e.lockedUntil > now) wait = Math.max(wait, e.lockedUntil - now);
  }
  return wait;
}

export function recordLoginFailure(keys: string[], now = Date.now()): void {
  prune(now);
  for (const k of keys) {
    const e = entries.get(k) || { failures: 0, lockedUntil: 0, lastFailure: 0 };
    if (now - e.lastFailure > FORGET_AFTER_MS) e.failures = 0;
    e.failures += 1;
    e.lastFailure = now;
    if (e.failures >= MAX_FREE_ATTEMPTS) {
      const exp = e.failures - MAX_FREE_ATTEMPTS;
      e.lockedUntil = now + Math.min(BASE_LOCK_MS * 2 ** exp, MAX_LOCK_MS);
    }
    entries.set(k, e);
  }
}

export function recordLoginSuccess(keys: string[]): void {
  for (const k of keys) entries.delete(k);
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

export function _resetRateLimitForTests() {
  entries.clear();
}
