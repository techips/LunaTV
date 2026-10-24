import { NextResponse } from 'next/server';

import { fetchWithTimeout } from '@/lib/fetch-timeout';
import {
  isPlaylistContentType,
  looksLikePlaylist,
  rewritePlaylist,
} from '@/lib/hls-rewrite';
import { CORS_HEADERS, resolveProxyTarget } from '@/lib/live-proxy';
import { logger } from '@/lib/logger';
import { signProxyUrl } from '@/lib/server-secret';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  // 入口地址是频道地址本身；子播放列表 / 音轨等由改写时签名
  const target = await resolveProxyTarget(request, 'channel');
  if (target instanceof NextResponse) return target;

  const direct =
    new URL(request.url).searchParams.get('allowCORS') === 'true';

  // 放弃响应时用 abort 强制断开连接（只取消响应流可能留下仍在下载的上游连接）
  const controller = new AbortController();
  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(
      target.url,
      { redirect: 'follow', headers: { 'User-Agent': target.ua }, signal: controller.signal },
      15000
    );
  } catch (error) {
    logger.warn('m3u8 代理请求失败:', target.url, (error as Error).message);
    return NextResponse.json({ error: 'Failed to fetch m3u8' }, { status: 502 });
  }

  if (!upstream.ok) {
    controller.abort();
    return NextResponse.json(
      { error: `Upstream ${upstream.status}` },
      { status: 502 }
    );
  }

  const contentType = upstream.headers.get('Content-Type') || '';
  const notHls = () =>
    NextResponse.json({ error: '该线路不是 HLS 播放列表，暂不支持播放' }, { status: 415 });

  // 视频流（TS / FLV 等）不转发：播放器只支持 HLS，且这类流不会结束
  if (!isPlaylistContentType(contentType)) {
    controller.abort();
    return notHls();
  }

  const text = await readPlaylistText(upstream);
  if (text === null) {
    controller.abort();
    return notHls();
  }

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

const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;

/**
 * 有上限地读取播放列表。octet-stream 等类型可能其实是视频流：
 * 第一块内容不是 #EXTM3U 或超过大小上限时立即停止，返回 null。
 */
async function readPlaylistText(res: Response): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (size > MAX_PLAYLIST_BYTES || (text.length >= 16 && !looksLikePlaylist(text))) {
        return null;
      }
    }
    text += decoder.decode();
    return looksLikePlaylist(text) ? text : null;
  } finally {
    reader.releaseLock();
  }
}
