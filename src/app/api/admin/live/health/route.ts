import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { checkSourceHealth } from '@/lib/live-health';
import { logger } from '@/lib/logger';
import { rejectLocalStorage, requireAuth } from '@/lib/require-auth';

export const runtime = 'nodejs';

/**
 * 手动触发线路检查。检查在后台进行，接口立即返回；
 * 结果体现在 /api/live/channels 返回的 health 字段中。
 */
export async function POST(request: NextRequest) {
  const local = rejectLocalStorage();
  if (local) return local;
  const auth = await requireAuth(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  const { key } = await request.json().catch(() => ({ key: undefined }));
  const config = await getConfig();
  const targets = config.LiveConfig.filter((l) => !l.disabled && (!key || l.key === key));
  if (targets.length === 0) {
    return NextResponse.json({ error: '直播源不存在' }, { status: 404 });
  }

  for (const t of targets) {
    checkSourceHealth(t.key, t.ua).catch((e) => logger.error(`线路检查失败 [${t.key}]:`, e));
  }
  return NextResponse.json({ success: true, started: targets.map((t) => t.key) });
}
