/**
 * API 路由统一鉴权（Node 运行时）。
 *
 * middleware 只能校验签名和过期时间；这里额外检查：
 *  - 用户是否仍然存在、是否被封禁
 *  - 会话版本号是否最新（改密 / 封禁 / 删除后旧 cookie 失效）
 *  - 角色是否满足要求
 */

import { NextResponse } from 'next/server';

import { getConfig } from './config';
import { db } from './db';
import {
  parseSessionToken,
  Role,
  SESSION_COOKIE,
  verifySessionToken,
} from './session';

export interface AuthedUser {
  /** localstorage 模式下为空字符串 */
  username: string;
  role: Role;
}

export function storageType(): string {
  return process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
}

// 会话版本号进程内短缓存：视频分片等高频请求不必每次查库
const VERSION_TTL_MS = 15 * 1000;
const versionCache = new Map<string, { v: number; at: number }>();

async function currentSessionVersion(username: string): Promise<number> {
  const hit = versionCache.get(username);
  if (hit && Date.now() - hit.at < VERSION_TTL_MS) return hit.v;
  const v = await db.getSessionVersion(username);
  versionCache.set(username, { v, at: Date.now() });
  return v;
}

/** 使某用户已签发的所有会话失效 */
export async function revokeSessions(username: string): Promise<void> {
  const v = await db.bumpSessionVersion(username);
  versionCache.set(username, { v, at: Date.now() });
}

export async function sessionVersionFor(username: string): Promise<number> {
  if (storageType() === 'localstorage' || username === process.env.USERNAME) return 0;
  return currentSessionVersion(username);
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) {
      return part.slice(idx + 1).trim();
    }
  }
  return undefined;
}

const RANK: Record<Role, number> = { user: 0, admin: 1, owner: 2 };

/**
 * 校验当前请求的登录状态；失败时返回可直接 return 的 NextResponse。
 * @param minRole 需要的最低角色，默认任意登录用户
 */
export async function requireAuth(
  request: Request,
  minRole: Role = 'user'
): Promise<AuthedUser | NextResponse> {
  const token = parseSessionToken(readCookie(request, SESSION_COOKIE));
  if (!verifySessionToken(token) || !token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let user: AuthedUser;
  if (storageType() === 'localstorage') {
    // 单密码模式只有一种身份，没有管理后台
    user = { username: '', role: 'user' };
  } else if (token.u && token.u === process.env.USERNAME) {
    // 站长：会话密钥由站长密码派生，改密后自动全部失效
    user = { username: token.u, role: 'owner' };
  } else {
    const config = await getConfig();
    const entry = config.UserConfig.Users.find((u) => u.username === token.u);
    if (!entry || !token.u) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (entry.banned) {
      return NextResponse.json({ error: '用户已被封禁' }, { status: 403 });
    }
    if (token.v !== (await currentSessionVersion(token.u))) {
      return NextResponse.json({ error: '登录已失效，请重新登录' }, { status: 401 });
    }
    user = { username: token.u, role: entry.role === 'admin' ? 'admin' : 'user' };
  }

  if (RANK[user.role] < RANK[minRole]) {
    return NextResponse.json({ error: '权限不足' }, { status: 403 });
  }
  return user;
}

/** 管理接口在 localstorage 模式下不可用 */
export function rejectLocalStorage(): NextResponse | null {
  if (storageType() === 'localstorage') {
    return NextResponse.json({ error: '不支持本地存储模式进行此操作' }, { status: 400 });
  }
  return null;
}
