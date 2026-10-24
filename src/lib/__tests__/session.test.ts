/**
 * @jest-environment node
 */
import { webcrypto } from 'crypto';

import {
  buildSessionCookies,
  createSessionToken,
  parseSessionToken,
  SESSION_TTL_MS,
  verifySessionToken,
} from '@/lib/session';
import { verifySessionCookieEdge } from '@/lib/session-edge';

describe('会话令牌', () => {
  const env = process.env;
  beforeAll(() => {
    // jest node 环境下 middleware 用到的全局 WebCrypto
    if (!(globalThis as { crypto?: unknown }).crypto) {
      (globalThis as { crypto?: unknown }).crypto = webcrypto;
    }
  });
  beforeEach(() => {
    process.env = { ...env, PASSWORD: 'owner-pass', SESSION_SECRET: '' };
  });
  afterAll(() => {
    process.env = env;
  });

  it('签发的令牌可以通过 Node 与 Edge 两种实现的校验', async () => {
    const raw = createSessionToken('alice', 3);
    expect(verifySessionToken(parseSessionToken(raw))).toBe(true);
    expect(await verifySessionCookieEdge(raw)).toBe(true);
  });

  it('篡改用户名 / 版本号 / 过期时间后校验失败', async () => {
    const t = parseSessionToken(createSessionToken('alice', 3));
    if (!t) throw new Error('token should parse');
    for (const forged of [
      { ...t, u: 'owner' },
      { ...t, v: 4 },
      { ...t, exp: t.exp + 1000 },
    ]) {
      expect(verifySessionToken(forged)).toBe(false);
      expect(await verifySessionCookieEdge(encodeURIComponent(JSON.stringify(forged)))).toBe(false);
    }
  });

  it('过期令牌被拒绝', async () => {
    const past = Date.now() - SESSION_TTL_MS - 1000;
    const raw = createSessionToken('alice', 0, past);
    expect(verifySessionToken(parseSessionToken(raw))).toBe(false);
    expect(await verifySessionCookieEdge(raw)).toBe(false);
  });

  it('站长改密码（派生密钥变化）后旧令牌全部失效', async () => {
    const raw = createSessionToken('alice', 0);
    process.env.PASSWORD = 'new-owner-pass';
    expect(verifySessionToken(parseSessionToken(raw))).toBe(false);
    expect(await verifySessionCookieEdge(raw)).toBe(false);
  });

  it('旧版 cookie 格式（username+signature）不再被接受', async () => {
    const legacy = encodeURIComponent(JSON.stringify({ username: 'alice', signature: 'ab', role: 'owner' }));
    expect(parseSessionToken(legacy)).toBeNull();
    expect(await verifySessionCookieEdge(legacy)).toBe(false);
  });

  it('会话 cookie 为 HttpOnly，展示用 cookie 不含凭据', () => {
    const [session, info] = buildSessionCookies('alice', 'admin', 1, true);
    expect(session.options.httpOnly).toBe(true);
    expect(session.options.secure).toBe(true);
    expect(info.options.httpOnly).toBe(false);
    expect(JSON.parse(decodeURIComponent(info.value))).toEqual({ username: 'alice', role: 'admin' });
  });
});
