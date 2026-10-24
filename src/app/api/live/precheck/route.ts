import { NextRequest, NextResponse } from 'next/server';

import { fetchWithHeaderTimeout } from '@/lib/fetch-timeout';
import { resolveProxyTarget } from '@/lib/live-proxy';

export const runtime = 'nodejs';

// 读取响应开头的少量字节，用于识别流类型
async function readHead(res: Response, max = 512): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const { value } = await reader.read();
  reader.cancel().catch(() => undefined);
  return (value || new Uint8Array()).slice(0, max);
}

export async function GET(request: NextRequest) {
  const target = await resolveProxyTarget(request, 'channel');
  if (target instanceof NextResponse) return target;

  try {
    const response = await fetchWithHeaderTimeout(
      target.url,
      { redirect: 'follow', headers: { 'User-Agent': target.ua } },
      10000
    );

    if (!response.ok) {
      response.body?.cancel().catch(() => undefined);
      return NextResponse.json(
        { error: 'Failed to fetch', message: `上游返回 ${response.status}` },
        { status: 502 }
      );
    }

    const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
    const head = await readHead(response);
    const ascii = new TextDecoder().decode(head.slice(0, 16));

    if (contentType.includes('video/x-flv') || ascii.startsWith('FLV')) {
      return NextResponse.json({ success: true, type: 'flv' });
    }
    if (contentType.includes('video/mp4') || ascii.slice(4, 8) === 'ftyp') {
      return NextResponse.json({ success: true, type: 'mp4' });
    }
    return NextResponse.json({ success: true, type: 'm3u8' });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch', message: (error as Error).message },
      { status: 502 }
    );
  }
}
