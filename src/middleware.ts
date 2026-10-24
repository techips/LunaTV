import { NextRequest, NextResponse } from 'next/server';

import { verifySessionCookieEdge } from '@/lib/session-edge';

/**
 * 第一道关：校验会话签名与过期时间。
 * 用户是否被封禁、会话版本号、角色等需要查库的检查在各 API 路由的 requireAuth 中完成。
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (shouldSkipAuth(pathname)) {
    return NextResponse.next();
  }

  // CSRF 防护：跨站发起的写操作一律拒绝（SameSite=Lax 之外的第二道防线）
  if (pathname.startsWith('/api') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const origin = request.headers.get('origin');
    if (origin && origin !== request.nextUrl.origin && !isSameHost(origin, request)) {
      return new NextResponse('Cross-origin request blocked', { status: 403 });
    }
  }

  if (!process.env.PASSWORD) {
    // 未设置密码时重定向到警告页面
    return NextResponse.redirect(new URL('/warning', request.url));
  }

  if (await verifySessionCookieEdge(request.cookies.get('auth')?.value)) {
    return NextResponse.next();
  }

  return handleAuthFailure(request, pathname);
}

// 反向代理后 nextUrl.origin 可能是内部地址，再按 Host / X-Forwarded-Host 比较一次
function isSameHost(origin: string, request: NextRequest): boolean {
  try {
    const host = new URL(origin).host;
    const forwarded = request.headers.get('x-forwarded-host')?.split(',')[0].trim();
    return host === (forwarded || request.headers.get('host'));
  } catch {
    return false;
  }
}

function handleAuthFailure(request: NextRequest, pathname: string): NextResponse {
  if (pathname.startsWith('/api')) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('redirect', `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

function shouldSkipAuth(pathname: string): boolean {
  const skipPaths = [
    '/_next',
    '/favicon.ico',
    '/robots.txt',
    '/manifest.json',
    '/icons/',
    '/logo.png',
    '/screenshot.png',
    '/sw.js',
    '/workbox-',
  ];
  return skipPaths.some((path) => pathname.startsWith(path));
}

export const config = {
  matcher: [
    // api/cron 不走会话校验，由路由自身校验 CRON_SECRET / 本机来源
    '/((?!_next/static|_next/image|favicon.ico|login|warning|api/login|api/logout|api/cron|api/server-config).*)',
  ],
};
