/**
 * @jest-environment node
 */
import { signProxyUrl, verifyProxyUrl } from '@/lib/server-secret';

describe('代理地址签名', () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env, PASSWORD: 'owner-pass', SESSION_SECRET: '' };
  });
  afterAll(() => {
    process.env = env;
  });

  it('签名可验证，篡改地址或签名后失败', () => {
    const url = 'https://cdn.example/seg1.ts';
    const sig = signProxyUrl(url);
    expect(verifyProxyUrl(url, sig)).toBe(true);
    expect(verifyProxyUrl('http://127.0.0.1:6666/', sig)).toBe(false);
    expect(verifyProxyUrl(url, sig.replace(/.$/, (c) => (c === '0' ? '1' : '0')))).toBe(false);
    expect(verifyProxyUrl(url, null)).toBe(false);
    expect(verifyProxyUrl(url, 'zz')).toBe(false);
  });

  it('更换密钥后旧签名失效', () => {
    const url = 'https://cdn.example/seg1.ts';
    const sig = signProxyUrl(url);
    process.env.SESSION_SECRET = 'a-new-secret';
    expect(verifyProxyUrl(url, sig)).toBe(false);
  });
});
