import { NextRequest, NextResponse } from 'next/server';

import { refreshAllLiveSources } from '@/lib/live';
import { logger } from '@/lib/logger';
import { rejectLocalStorage, requireAuth } from '@/lib/require-auth';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const local = rejectLocalStorage();
  if (local) return local;
  const auth = await requireAuth(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  try {
    const counts = await refreshAllLiveSources();
    return NextResponse.json({ success: true, message: '直播源刷新成功', counts });
  } catch (error) {
    logger.error('直播源刷新失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '刷新失败' },
      { status: 500 }
    );
  }
}
