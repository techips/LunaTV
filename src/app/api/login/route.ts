import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  clientIp,
  loginRetryAfter,
  recordLoginFailure,
  recordLoginSuccess,
} from '@/lib/rate-limit';
import { sessionVersionFor, storageType } from '@/lib/require-auth';
import { buildSessionCookies, isHttpsRequest, Role } from '@/lib/session';

export const runtime = 'nodejs';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function issueSession(req: NextRequest, username: string, role: Role) {
  const version = await sessionVersionFor(username);
  const response = NextResponse.json({ ok: true });
  for (const c of buildSessionCookies(username, role, version, isHttpsRequest(req))) {
    response.cookies.set(c.name, c.value, c.options);
  }
  return response;
}

function tooManyAttempts(waitMs: number) {
  const seconds = Math.ceil(waitMs / 1000);
  return NextResponse.json(
    { error: `尝试次数过多，请 ${seconds} 秒后再试` },
    { status: 429, headers: { 'Retry-After': String(seconds) } }
  );
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  try {
    const body = await req.json().catch(() => ({}));
    const password = body?.password;
    const username = body?.username;

    if (typeof password !== 'string' || !password) {
      return NextResponse.json({ error: '密码不能为空' }, { status: 400 });
    }

    // 未配置 PASSWORD 时站点处于未保护状态，middleware 会引导到警告页
    const envPassword = process.env.PASSWORD;
    if (!envPassword) {
      return NextResponse.json({ error: '站点未配置密码' }, { status: 500 });
    }

    // 本地 / localStorage 模式——仅校验固定密码
    if (storageType() === 'localstorage') {
      const keys = [`ip:${ip}`];
      const wait = loginRetryAfter(keys);
      if (wait > 0) return tooManyAttempts(wait);
      if (!safeEqual(password, envPassword)) {
        recordLoginFailure(keys);
        return NextResponse.json({ ok: false, error: '密码错误' }, { status: 401 });
      }
      recordLoginSuccess(keys);
      return issueSession(req, '', 'user');
    }

    // 数据库模式——用户名 + 密码
    if (!username || typeof username !== 'string') {
      return NextResponse.json({ error: '用户名不能为空' }, { status: 400 });
    }

    const keys = [`ip:${ip}`, `user:${username}`];
    const wait = loginRetryAfter(keys);
    if (wait > 0) return tooManyAttempts(wait);

    const fail = () => {
      recordLoginFailure(keys);
      return NextResponse.json({ error: '用户名或密码错误' }, { status: 401 });
    };

    // 站长账号直接比对环境变量
    if (username === process.env.USERNAME) {
      if (!safeEqual(password, envPassword)) return fail();
      recordLoginSuccess(keys);
      return issueSession(req, username, 'owner');
    }

    const config = await getConfig();
    const user = config.UserConfig.Users.find((u) => u.username === username);

    let pass = false;
    try {
      pass = await db.verifyUser(username, password);
    } catch (err) {
      logger.error('数据库验证失败', err);
      return NextResponse.json({ error: '数据库错误' }, { status: 500 });
    }
    if (!pass) return fail();

    // 先校验密码再提示封禁，避免通过不同提示探测用户是否存在
    if (user?.banned) {
      return NextResponse.json({ error: '用户被封禁' }, { status: 403 });
    }

    recordLoginSuccess(keys);
    return issueSession(req, username, user?.role === 'admin' ? 'admin' : 'user');
  } catch (error) {
    logger.error('登录接口异常', error);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
