import { NextRequest, NextResponse } from 'next/server';

import { collectBackup, packBackup } from '@/lib/backup';
import { logger } from '@/lib/logger';
import { rejectLocalStorage, requireAuth } from '@/lib/require-auth';
import { CURRENT_VERSION } from '@/lib/version';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const local = rejectLocalStorage();
  if (local) return local;
  // 只有站长可以导出数据
  const auth = await requireAuth(req, 'owner');
  if (auth instanceof NextResponse) return auth;

  try {
    const { password } = await req.json();
    if (!password || typeof password !== 'string' || password.length < 6) {
      return NextResponse.json({ error: '请提供至少 6 位的加密密码' }, { status: 400 });
    }

    const data = await collectBackup(CURRENT_VERSION);
    const encrypted = await packBackup(data, password);

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    return new NextResponse(encrypted, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="moontv-backup-${stamp}.dat"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    logger.error('数据导出失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '导出失败' },
      { status: 500 }
    );
  }
}
