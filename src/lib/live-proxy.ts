import { NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { isKnownChannelLogo, isKnownChannelUrl } from '@/lib/live';
import { requireAuth } from '@/lib/require-auth';
import { verifyProxyUrl } from '@/lib/server-secret';

export const DEFAULT_LIVE_UA = 'AptvPlayer/1.4.10';

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range, Origin, Accept',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
};

export interface ProxyTarget {
  url: string;
  sourceKey: string;
  ua: string;
}

/**
 * 解析并校验代理请求。
 *
 * 允许代理的地址只有两类：
 *  1. 服务端改写播放列表时签发过签名的地址（分片、子播放列表、密钥等）；
 *  2. 该直播源频道列表里的频道地址 / 台标（播放器直接请求的入口地址）。
 * 其余任意地址一律拒绝，避免代理接口被用来抓取内网或任意网站。
 */
export async function resolveProxyTarget(
  request: Request,
  entry: 'channel' | 'logo' | 'signed-only'
): Promise<ProxyTarget | NextResponse> {
  // 被封禁 / 已删除 / 会话失效的用户不能继续使用代理
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  const sourceKey =
    searchParams.get('moontv-source') || searchParams.get('source') || '';
  if (!url) {
    return NextResponse.json({ error: 'Missing url' }, { status: 400 });
  }
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: 'Unsupported protocol' }, { status: 400 });
  }

  const config = await getConfig();
  const liveSource = config.LiveConfig.find((s) => s.key === sourceKey);
  if (!liveSource || liveSource.disabled) {
    return NextResponse.json({ error: 'Source not found' }, { status: 404 });
  }

  let allowed = verifyProxyUrl(url, searchParams.get('sig'));
  if (!allowed && entry === 'channel') {
    allowed = await isKnownChannelUrl(sourceKey, url);
  }
  if (!allowed && entry === 'logo') {
    allowed = await isKnownChannelLogo(sourceKey, url);
  }
  if (!allowed) {
    return NextResponse.json({ error: 'URL not allowed' }, { status: 403 });
  }

  return { url, sourceKey, ua: liveSource.ua || DEFAULT_LIVE_UA };
}
