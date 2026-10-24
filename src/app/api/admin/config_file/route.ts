import { NextRequest, NextResponse } from 'next/server';

import { refineConfig, updateConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { rejectLocalStorage, requireAuth } from '@/lib/require-auth';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const local = rejectLocalStorage();
  if (local) return local;
  // 仅站长可以修改配置文件
  const auth = await requireAuth(request, 'owner');
  if (auth instanceof NextResponse) return auth;

  try {
    const { configFile, subscriptionUrl, autoUpdate, lastCheckTime } = await request.json();

    if (!configFile || typeof configFile !== 'string') {
      return NextResponse.json({ error: '配置文件内容不能为空' }, { status: 400 });
    }
    try {
      JSON.parse(configFile);
    } catch (e) {
      return NextResponse.json({ error: '配置文件格式错误，请检查 JSON 语法' }, { status: 400 });
    }
    if (
      subscriptionUrl !== undefined &&
      subscriptionUrl !== '' &&
      (typeof subscriptionUrl !== 'string' || !/^https?:\/\//i.test(subscriptionUrl.trim()))
    ) {
      return NextResponse.json({ error: '订阅地址必须是 http(s) 链接' }, { status: 400 });
    }

    await updateConfig((adminConfig) => {
      adminConfig.ConfigFile = configFile;
      if (subscriptionUrl !== undefined) {
        adminConfig.ConfigSubscription.URL = String(subscriptionUrl).trim();
      }
      if (autoUpdate !== undefined) {
        adminConfig.ConfigSubscription.AutoUpdate = !!autoUpdate;
      }
      adminConfig.ConfigSubscription.LastCheck = lastCheckTime || '';
      refineConfig(adminConfig);
    });

    return NextResponse.json({ success: true, message: '配置文件更新成功' });
  } catch (error) {
    logger.error('更新配置文件失败:', error);
    return NextResponse.json(
      { error: '更新配置文件失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}
