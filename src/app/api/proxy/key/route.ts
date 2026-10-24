import { NextResponse } from 'next/server';

import { fetchWithTimeout } from '@/lib/fetch-timeout';
import { CORS_HEADERS, resolveProxyTarget } from '@/lib/live-proxy';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const target = await resolveProxyTarget(request, 'signed-only');
  if (target instanceof NextResponse) return target;

  try {
    const response = await fetchWithTimeout(
      target.url,
      { headers: { 'User-Agent': target.ua } },
      10000
    );
    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to fetch key' }, { status: 502 });
    }
    const keyData = await response.arrayBuffer();
    return new Response(keyData, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/octet-stream',
        // 密钥只给当前会话用，不进入共享缓存
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch key' }, { status: 502 });
  }
}
