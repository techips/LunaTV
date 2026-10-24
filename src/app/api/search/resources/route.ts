/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAvailableApiSites } from '@/lib/config';
import { requireAuth } from '@/lib/require-auth';

export const runtime = 'nodejs';

// OrionTV 兼容接口
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const authInfo = { username: auth.username };
  try {
    const apiSites = await getAvailableApiSites(authInfo.username);

    return NextResponse.json(apiSites);
  } catch (error) {
    return NextResponse.json({ error: '获取资源失败' }, { status: 500 });
  }
}
