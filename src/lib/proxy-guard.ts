import { lookup } from 'dns/promises';

import { fetchWithTimeout } from './fetch-timeout';

/**
 * 代理接口的通用安全校验。
 *
 * 说明：直播源（m3u8/segment/key/logo）常常部署在局域网内（如 IPTV 组播网关），
 * 因此内网地址限制只用于豆瓣图片代理，不施加到直播相关代理上。
 */

// 仅允许通过代理转发的图片 Content-Type
export function isImageContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  return contentType.trim().toLowerCase().startsWith('image/');
}

// 判断是否为内网/环回/链路本地地址，避免代理被用于探测内网服务
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }

  // IPv6 环回、唯一本地地址与链路本地地址
  if (host === '::1' || host === '::' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
    return true;
  }
  // IPv4-mapped IPv6，如 ::ffff:127.0.0.1
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const target = mapped ? mapped[1] : host;

  const ipv4 = target.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;

  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 0 || a === 10 || a === 127) return true; // 本机 / A 类私有
  if (a === 169 && b === 254) return true; // 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // B 类私有
  if (a === 192 && b === 168) return true; // C 类私有
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * 校验图片代理的目标地址：只允许 http/https，且不得指向内网地址。
 * 返回 null 表示校验通过，否则返回不通过的原因。
 */
export function checkImageProxyTarget(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return '无效的图片地址';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '不支持的协议';
  }

  if (isPrivateHostname(parsed.hostname)) {
    return '不允许代理内网地址';
  }

  return null;
}

/**
 * 请求公网地址：每一跳都先检查主机名并解析 DNS，任一地址落在内网 / 环回 / 链路本地即拒绝；
 * 手动跟随最多 maxRedirects 次跳转，防止通过 30x 跳到内网。
 */
export async function fetchPublicUrl(
  rawUrl: string,
  init: RequestInit = {},
  { maxRedirects = 3, timeoutMs = 10000 } = {}
): Promise<Response> {
  let url = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const reason = checkImageProxyTarget(url);
    if (reason) throw new ProxyTargetError(reason);
    const { hostname } = new URL(url);
    let addrs: { address: string }[];
    try {
      addrs = await lookup(hostname.replace(/^\[|\]$/g, ''), { all: true });
    } catch {
      throw new ProxyTargetError('无法解析目标地址');
    }
    if (addrs.some((a) => isPrivateHostname(a.address))) {
      throw new ProxyTargetError('不允许代理内网地址');
    }

    const res = await fetchWithTimeout(url, { ...init, redirect: 'manual' }, timeoutMs);
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      res.body?.cancel().catch(() => undefined);
      url = new URL(location, url).href;
      continue;
    }
    return res;
  }
  throw new ProxyTargetError('跳转次数过多');
}

export class ProxyTargetError extends Error {}
