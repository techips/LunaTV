/**
 * 前端读取当前登录信息。
 *
 * 会话令牌 `auth` 是 HttpOnly 的，前端读不到；登录时额外下发的 `auth_info`
 * 只包含用户名和角色，用于界面展示（例如用户菜单、按用户隔离的本地缓存）。
 * 服务端鉴权见 src/lib/require-auth.ts。
 */
export function getAuthInfoFromBrowserCookie(): {
  username?: string;
  role?: 'owner' | 'admin' | 'user';
} | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const cookies = document.cookie.split(';').reduce((acc, cookie) => {
      const trimmed = cookie.trim();
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        acc[trimmed.substring(0, idx)] = trimmed.substring(idx + 1);
      }
      return acc;
    }, {} as Record<string, string>);

    const raw = cookies['auth_info'];
    if (!raw) {
      return null;
    }

    let decoded = decodeURIComponent(raw);
    // 兼容可能的双重编码
    if (decoded.includes('%')) {
      decoded = decodeURIComponent(decoded);
    }
    const info = JSON.parse(decoded);
    return {
      username: typeof info.username === 'string' ? info.username : undefined,
      role: info.role,
    };
  } catch (error) {
    return null;
  }
}
