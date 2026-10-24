import { NextRequest, NextResponse } from 'next/server';

import { getCachedLiveChannels, normalizeChannelName } from '@/lib/live';
import { getLineHealth } from '@/lib/live-health';
import { requireAuth } from '@/lib/require-auth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const { searchParams } = new URL(request.url);
    const sourceKey = searchParams.get('source');

    if (!sourceKey) {
      return NextResponse.json({ error: '缺少直播源参数' }, { status: 400 });
    }

    const channelData = await getCachedLiveChannels(sourceKey);

    if (!channelData) {
      return NextResponse.json({ error: '频道信息未找到' }, { status: 404 });
    }

    // 附带线路健康状态与合并分组键：同一分组内同名（归一化后）的频道视为同一频道的不同线路
    const data = channelData.channels.map((c) => {
      const h = getLineHealth(c.url);
      return {
        ...c,
        mergeKey: `${c.group}|${normalizeChannelName(c.tvgName || c.name) || c.name}`,
        health: h?.state,
        healthReason: h?.state === 'down' ? h.reason : undefined,
      };
    });

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      { error: '获取频道信息失败' },
      { status: 500 }
    );
  }
}
