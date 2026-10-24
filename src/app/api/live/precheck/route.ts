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
 * HEAD 不可用或类型不明时按地址后缀判断，默认当作 HLS。
 */
export async function GET(request: NextRequest) {
  const target = await resolveProxyTarget(request, 'channel');
  if (target instanceof NextResponse) return target;

  try {
    const head = await fetchWithHeaderTimeout(
      target.url,
      { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': target.ua } },
      10000
    );

    if (!head.ok && head.status !== 405 && head.status !== 501) {
      return NextResponse.json(
        { error: 'Failed to fetch', message: `上游返回 ${head.status}` },
        { status: 502 }
      );
    }

    const type =
      (head.ok && typeFromContentType(head.headers.get('content-type') || '')) ||
      typeFromUrl(head.url || target.url);
    return NextResponse.json({ success: true, type });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch', message: (error as Error).message },
      { status: 502 }
    );
  }
}
