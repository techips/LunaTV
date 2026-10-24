import { NextRequest, NextResponse } from 'next/server';

import { fetchWithHeaderTimeout } from '@/lib/fetch-timeout';
import { resolveProxyTarget } from '@/lib/live-proxy';

export const runtime = 'nodejs';

type StreamType = 'm3u8' | 'flv' | 'mp4' | 'ts';

function typeFromContentType(ct: string): StreamType | null {
  if (/x-flv/i.test(ct)) return 'flv';
  if (/video\/mp4/i.test(ct)) return 'mp4';
  if (/mpegurl/i.test(ct)) return 'm3u8';
  // 其他视频类型（如 video/mp2t）是不经过播放列表的裸流，播放器不支持
  if (/^video\//i.test(ct)) return 'ts';
  return null;
}

function typeFromUrl(url: string): StreamType {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith('.flv')) return 'flv';
  if (path.endsWith('.mp4')) return 'mp4';
  if (path.endsWith('.ts')) return 'ts';
  return 'm3u8';
}

/**
 * 判断直播流类型。只发 HEAD、不读响应体：FLV / TS 直播流不会结束，
 * GET 后即使立即断开，经过代理时上游下载也可能不会停止。
 * HEAD 失败或类型不明时按地址后缀判断，默认当作 HLS；能不能播由后续的播放列表请求决定。
 */
export async function GET(request: NextRequest) {
  const target = await resolveProxyTarget(request, 'channel');
  if (target instanceof NextResponse) return target;

  // 很多服务器不接受 HEAD（403/404/405），这时按地址后缀猜测类型，交给 m3u8 代理的 GET 去判断，
  // 不能因为 HEAD 失败就阻止播放
  let headType: StreamType | null = null;
  let finalUrl = target.url;
  try {
    const head = await fetchWithHeaderTimeout(
      target.url,
      { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': target.ua } },
      10000
    );
    finalUrl = head.url || target.url;
    if (head.ok) headType = typeFromContentType(head.headers.get('content-type') || '');
  } catch {
    // 网络错误同样交给后续播放请求处理并提示
  }
  return NextResponse.json({ success: true, type: headType || typeFromUrl(finalUrl) });
}

