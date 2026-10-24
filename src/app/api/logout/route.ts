import { NextRequest, NextResponse } from 'next/server';

import { buildClearCookies, isHttpsRequest } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const response = NextResponse.json({ ok: true });
  // Secure 属性需与登录时一致，否则 HTTPS 下浏览器可能拒绝覆盖
  for (const c of buildClearCookies(isHttpsRequest(request))) {
    response.cookies.set(c.name, c.value, c.options);
  }
  return response;
}
