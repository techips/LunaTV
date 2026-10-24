/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { updateConfig } from '@/lib/config';
import { rejectLocalStorage, requireAuth } from '@/lib/require-auth';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const local = rejectLocalStorage();
  if (local) return local;
  const auth = await requireAuth(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();

    const {
      SiteName,
      Announcement,
      SearchDownstreamMaxPage,
      SiteInterfaceCacheTime,
      DoubanProxyType,
      DoubanProxy,
      DoubanImageProxyType,
      DoubanImageProxy,
      DisableYellowFilter,
      FluidSearch,
      EnableWebLive,
    } = body as {
      SiteName: string;
      Announcement: string;
      SearchDownstreamMaxPage: number;
      SiteInterfaceCacheTime: number;
      DoubanProxyType: string;
      DoubanProxy: string;
      DoubanImageProxyType: string;
      DoubanImageProxy: string;
      DisableYellowFilter: boolean;
      FluidSearch: boolean;
      EnableWebLive: boolean;
    };

    // 参数校验
    if (
      typeof SiteName !== 'string' ||
      typeof Announcement !== 'string' ||
      typeof SearchDownstreamMaxPage !== 'number' ||
      typeof SiteInterfaceCacheTime !== 'number' ||
      typeof DoubanProxyType !== 'string' ||
      typeof DoubanProxy !== 'string' ||
      typeof DoubanImageProxyType !== 'string' ||
      typeof DoubanImageProxy !== 'string' ||
      typeof DisableYellowFilter !== 'boolean' ||
      typeof FluidSearch !== 'boolean'
    ) {
      return NextResponse.json({ error: '参数格式错误' }, { status: 400 });
    }
    if (
      SearchDownstreamMaxPage < 1 || SearchDownstreamMaxPage > 50 ||
      SiteInterfaceCacheTime < 0 || SiteInterfaceCacheTime > 7 * 24 * 3600
    ) {
      return NextResponse.json({ error: '数值超出允许范围' }, { status: 400 });
    }

    await updateConfig((adminConfig) => {
      adminConfig.SiteConfig = {
        SiteName,
        Announcement,
        SearchDownstreamMaxPage,
        SiteInterfaceCacheTime,
        DoubanProxyType,
        DoubanProxy,
        DoubanImageProxyType,
        DoubanImageProxy,
        DisableYellowFilter,
        FluidSearch,
        EnableWebLive: EnableWebLive ?? false,
      };
    });

    return NextResponse.json(
      { ok: true },
      {
        headers: {
          'Cache-Control': 'no-store', // 不缓存结果
        },
      }
    );
  } catch (error) {
    console.error('更新站点配置失败:', error);
    return NextResponse.json(
      {
        error: '更新站点配置失败',
        details: (error as Error).message,
      },
      { status: 500 }
    );
  }
}
