import { NextRequest, NextResponse } from 'next/server';

import { resetConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { rejectLocalStorage, requireAuth } from '@/lib/require-auth';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const local = rejectLocalStorage();
  if (local) return local;
  const auth = await requireAuth(request, 'owner');
  if (auth instanceof NextResponse) return auth;

  try {
    await resetConfig();
    return NextResponse.json(
      { ok: true },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    logger.error('重置管理员配置失败:', error);
    return NextResponse.json(
      { error: '重置管理员配置失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}
