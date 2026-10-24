import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * 服务端签名密钥（Node 运行时）。
 *
 * 优先使用 SESSION_SECRET；未配置时由站长密码派生，保证老部署无需新增环境变量也能工作。
 * 派生时加上固定前缀，避免与登录密码本身直接复用。
 * 与 middleware（Edge 运行时）中的 deriveSecretEdge 必须保持同一算法。
 */
export function getServerSecret(): string {
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }
  return createHash('sha256')
    .update(`lunatv:session:${process.env.PASSWORD || ''}`)
    .digest('hex');
}

export function hmacHex(purpose: string, data: string): string {
  return createHmac('sha256', getServerSecret())
    .update(`${purpose}:${data}`)
    .digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

// 代理地址签名：只有服务端改写/下发过的地址才能被代理，防止接口被当作任意 URL 抓取器
export function signProxyUrl(url: string): string {
  return hmacHex('proxy', url).slice(0, 32);
}

export function verifyProxyUrl(url: string, sig: string | null): boolean {
  if (!sig) return false;
  return safeEqualHex(signProxyUrl(url), sig);
}
