import { NextRequest, NextResponse } from 'next/server';

import { fetchSubscriptionConfig } from '@/lib/config-subscription';
import { requireAuth } from '@/lib/require-auth';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  // 仅站长可以拉取配置订阅
  const auth = await requireAuth(request, 'owner');
  if (auth instanceof NextResponse) return auth;

  try {
    const { url } = await request.json();
    const configContent = await fetchSubscriptionConfig(url);
    return NextResponse.json({
      success: true,
      configContent,
      message: '配置拉取成功',
    });
  } catch (error) {
    return NextResponse.json(
      { error: `拉取配置失败：${(error as Error).message}` },
      { status: 400 }
    );
  }
}
