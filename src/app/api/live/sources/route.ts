/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { requireAuth } from '@/lib/require-auth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const config = await getConfig();
    // 只返回前端需要的字段：直播源地址可能很长（托管/内联列表），也可能含有私有地址
    const liveSources = config.LiveConfig.filter((source) => !source.disabled).map((s) => ({
      key: s.key,
      name: s.name,
      channelNumber: s.channelNumber || 0,
      from: s.from,
      disabled: !!s.disabled,
    }));
    return NextResponse.json({ success: true, data: liveSources });
  } catch (error) {
    console.error('获取直播源失败:', error);
    return NextResponse.json({ error: '获取直播源失败' }, { status: 500 });
  }
}
