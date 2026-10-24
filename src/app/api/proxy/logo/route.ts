import { NextResponse } from 'next/server';

import { fetchWithTimeout } from '@/lib/fetch-timeout';
import { resolveProxyTarget } from '@/lib/live-proxy';
import { isImageContentType } from '@/lib/proxy-guard';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  // 只代理频道列表里出现过的台标地址
  const target = await resolveProxyTarget(request, 'logo');
  if (target instanceof NextResponse) return target;

  try {
    const imageResponse = await fetchWithTimeout(
      target.url,
      { redirect: 'follow', headers: { 'User-Agent': target.ua } },
      10000
    );

    if (!imageResponse.ok) {
      imageResponse.body?.cancel().catch(() => undefined);
      return NextResponse.json(
        { error: imageResponse.statusText },
        { status: imageResponse.status }
      );
    }

    const contentType = imageResponse.headers.get('content-type');

    // 只转发真正的图片，避免上游返回 HTML 时在本站域名下被当作页面执行
    if (!isImageContentType(contentType) || !imageResponse.body) {
      imageResponse.body?.cancel().catch(() => undefined);
      return NextResponse.json(
        { error: 'Upstream response is not an image' },
        { status: 415 }
      );
    }

    return new Response(imageResponse.body, {
      status: 200,
      headers: {
        'Content-Type': contentType as string,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=86400',
      },
    });
  } catch (error) {
    return NextResponse.json({ error: 'Error fetching image' }, { status: 502 });
  }
}
