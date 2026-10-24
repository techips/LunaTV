/* eslint-disable no-console */

import { NextResponse } from 'next/server';

import { fetchWithTimeout } from '@/lib/fetch-timeout';
import {
  isPlaylistContentType,
  looksLikePlaylist,
  rewritePlaylist,
} from '@/lib/hls-rewrite';
import { CORS_HEADERS, resolveProxyTarget } from '@/lib/live-proxy';
import { signProxyUrl } from '@/lib/server-secret';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  // 入口地址是频道地址本身；子播放列表 / 音轨等由改写时签名
  const target = await resolveProxyTarget(request, 'channel');
  if (target instanceof NextResponse) return target;

  const direct =
    new URL(request.url).searchParams.get('allowCORS') === 'true';

  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(
      target.url,
      { redirect: 'follow', headers: { 'User-Agent': target.ua } },
      15000
    );
  } catch (error) {
    console.warn('m3u8 代理请求失败:', target.url, (error as Error).message);
    return NextResponse.json({ error: 'Failed to fetch m3u8' }, { status: 502 });
  }

  if (!upstream.ok) {
    upstream.body?.cancel().catch(() => undefined);
    return NextResponse.json(
      { error: `Upstream ${upstream.status}` },
      { status: 502 }
    );
  }

  const contentType = upstream.headers.get('Content-Type') || '';

  if (isPlaylistContentType(contentType)) {
    const text = await upstream.text();
    // octet-stream 也可能是直接的视频流，只有内容确实是播放列表才改写
    if (looksLikePlaylist(text)) {
      const body = rewritePlaylist(text, upstream.url || target.url, {
        proxyBase: '/api/proxy',
        sourceKey: target.sourceKey,
        sign: signProxyUrl,
        direct,
      });
      return new Response(body, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-cache',
        },
      });
    }
    return new Response(text, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': contentType || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      },
    });
  }

  // 非播放列表（例如直接的 TS / FLV 流）原样透传
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': contentType || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    },
  });
}
