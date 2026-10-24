/* eslint-disable no-console */

import { NextResponse } from 'next/server';

import { fetchWithHeaderTimeout } from '@/lib/fetch-timeout';
import { CORS_HEADERS, resolveProxyTarget } from '@/lib/live-proxy';
import { CachedSegment, getCachedSegment, getPendingSegment, teeIntoCache } from '@/lib/segment-cache';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const target = await resolveProxyTarget(request, 'signed-only');
  if (target instanceof NextResponse) return target;

  const headers: Record<string, string> = { 'User-Agent': target.ua };
  const range = request.headers.get('range');
  if (range) headers.Range = range;

  // 多人观看同一频道时复用已下载 / 正在下载的分片（Range 请求不走缓存）
  if (!range) {
    const hit = getCachedSegment(target.url) || (await getPendingSegment(target.url));
    if (hit) return fromCache(hit);
  }

  let upstream: Response;
  try {
    // 客户端断开时（request.signal）一并中止上游下载
    upstream = await fetchWithHeaderTimeout(
      target.url,
      { headers, signal: request.signal },
      15000
    );
  } catch (error) {
    console.warn('分片代理请求失败:', target.url, (error as Error).message);
    return NextResponse.json({ error: 'Failed to fetch segment' }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    upstream.body?.cancel().catch(() => undefined);
    return NextResponse.json(
      { error: `Upstream ${upstream.status}` },
      { status: 502 }
    );
  }

  // 部分源把分片伪装成图片（.jpg/.png），统一按媒体类型返回，避免浏览器当图片处理
  const upstreamType = upstream.headers.get('content-type') || '';
  const contentType = /^(video|audio)\//i.test(upstreamType)
    ? upstreamType
    : 'video/mp2t';

  const outHeaders: Record<string, string> = {
    ...CORS_HEADERS,
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  };
  for (const h of ['content-length', 'content-range']) {
    const v = upstream.headers.get(h);
    if (v) outHeaders[h] = v;
  }

  const body =
    !range && upstream.status === 200
      ? teeIntoCache(target.url, upstream.body, contentType, Number(outHeaders['content-length'] || 0))
      : upstream.body;

  return new Response(body, {
    status: upstream.status === 206 ? 206 : 200,
    headers: outHeaders,
  });
}

function fromCache(hit: CachedSegment): Response {
  return new Response(hit.body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': hit.contentType,
      'Content-Length': String(hit.body.byteLength),
      'X-Content-Type-Options': 'nosniff',
      'X-Segment-Cache': 'hit',
    },
  });
}
