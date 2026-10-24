import { NextRequest, NextResponse } from 'next/server';

import { restoreBackup, unpackBackup } from '@/lib/backup';
import { invalidateConfigCache } from '@/lib/config';
import { logger } from '@/lib/logger';
import { rejectLocalStorage, requireAuth } from '@/lib/require-auth';
import { CURRENT_VERSION } from '@/lib/version';

export const runtime = 'nodejs';

const MAX_BACKUP_BYTES = 200 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const local = rejectLocalStorage();
  if (local) return local;
  // 只有站长可以导入数据
  const auth = await requireAuth(req, 'owner');
  if (auth instanceof NextResponse) return auth;

  try {
    const formData = await req.formData();
    const file = formData.get('file');
    const password = formData.get('password');

    if (!(file instanceof File)) {
      return NextResponse.json({ error: '请选择备份文件' }, { status: 400 });
    }
    if (typeof password !== 'string' || !password) {
      return NextResponse.json({ error: '请提供解密密码' }, { status: 400 });
    }
    if (file.size > MAX_BACKUP_BYTES) {
      return NextResponse.json({ error: '备份文件过大' }, { status: 400 });
    }

    let data;
    try {
      data = await unpackBackup(await file.text(), password);
    } catch (error) {
      return NextResponse.json({ error: (error as Error).message }, { status: 400 });
    }

    const importedUsers = await restoreBackup(data, CURRENT_VERSION);
    invalidateConfigCache();

    return NextResponse.json({
      message: '数据导入成功',
      importedUsers,
      timestamp: data.timestamp,
      serverVersion: typeof data.serverVersion === 'string' ? data.serverVersion : '未知版本',
    });
  } catch (error) {
    logger.error('数据导入失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '导入失败' },
      { status: 500 }
    );
  }
}
