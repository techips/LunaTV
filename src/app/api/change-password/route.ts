/* eslint-disable no-console*/

import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { rejectLocalStorage, requireAuth, revokeSessions } from '@/lib/require-auth';
import { buildSessionCookies, isHttpsRequest } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const local = rejectLocalStorage();
  if (local) return local;

  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const { newPassword, oldPassword } = await request.json();
    if (!oldPassword || typeof oldPassword !== 'string') {
      return NextResponse.json({ error: '旧密码不得为空' }, { status: 400 });
    }
    if (!newPassword || typeof newPassword !== 'string' || newPassword.trim().length < 6) {
      return NextResponse.json({ error: '新密码长度至少为6位' }, { status: 400 });
    }
    if (oldPassword === newPassword) {
      return NextResponse.json({ error: '新密码不能与旧密码相同' }, { status: 400 });
    }
    if (auth.role === 'owner') {
      return NextResponse.json({ error: '站长不能通过此接口修改密码' }, { status: 403 });
    }

    const valid = await db.verifyUser(auth.username, oldPassword);
    if (!valid) {
      return NextResponse.json({ error: '旧密码错误' }, { status: 401 });
    }
    await db.changePassword(auth.username, newPassword);
    // 其他设备上的旧会话全部失效，当前设备换发新 cookie
    await revokeSessions(auth.username);
    const version = await db.getSessionVersion(auth.username);

    const response = NextResponse.json({ ok: true });
    for (const c of buildSessionCookies(auth.username, auth.role, version, isHttpsRequest(request))) {
      response.cookies.set(c.name, c.value, c.options);
    }
    return response;
  } catch (error) {
    logger.error('修改密码失败:', error);
    return NextResponse.json({ error: '修改密码失败' }, { status: 500 });
  }
}
