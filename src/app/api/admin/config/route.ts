/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { AdminConfigResult } from '@/lib/admin.types';
import { getConfig } from '@/lib/config';
import { rejectLocalStorage, requireAuth } from '@/lib/require-auth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const local = rejectLocalStorage();
  if (local) return local;
  const auth = await requireAuth(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  try {
    const config = await getConfig();
    const result: AdminConfigResult = {
      Role: auth.role === 'owner' ? 'owner' : 'admin',
      Config: config,
    };
    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store', // 管理员配置不缓存
      },
    });
  } catch (error) {
    console.error('获取管理员配置失败:', error);
    return NextResponse.json(
      {
        error: '获取管理员配置失败',
        details: (error as Error).message,
      },
      { status: 500 }
    );
  }
}
