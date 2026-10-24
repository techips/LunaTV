/**
 * @jest-environment node
 */
import {
  _resetRateLimitForTests,
  loginRetryAfter,
  recordLoginFailure,
  recordLoginSuccess,
} from '@/lib/rate-limit';

describe('登录限流', () => {
  beforeEach(() => _resetRateLimitForTests());

  it('前 4 次失败不锁定，第 5 次开始锁定且时长递增', () => {
    const keys = ['user:alice'];
    const t = 1_000_000;
    for (let i = 0; i < 4; i++) recordLoginFailure(keys, t);
    expect(loginRetryAfter(keys, t)).toBe(0);
    recordLoginFailure(keys, t);
    const first = loginRetryAfter(keys, t);
    expect(first).toBeGreaterThan(0);
    recordLoginFailure(keys, t);
    expect(loginRetryAfter(keys, t)).toBeGreaterThan(first);
  });

  it('锁定到期后可以再次尝试，成功后清零', () => {
    const keys = ['ip:1.2.3.4'];
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) recordLoginFailure(keys, t);
    expect(loginRetryAfter(keys, t + 10 * 60 * 1000)).toBe(0);
    recordLoginSuccess(keys);
    recordLoginFailure(keys, t);
    expect(loginRetryAfter(keys, t)).toBe(0);
  });
});
