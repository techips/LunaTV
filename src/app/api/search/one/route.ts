import { NextRequest, NextResponse } from 'next/server';

import { getAvailableApiSites, getCacheTime, getConfig } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { requireAuth } from '@/lib/require-auth';
import { yellowWords } from '@/lib/yellow';

export const runtime = 'nodejs';

// OrionTV 兼容接口
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const authInfo = { username: auth.username };

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const resourceId = searchParams.get('resourceId');

  if (!query || !resourceId) {
    const cacheTime = await getCacheTime();
    return NextResponse.json(
      { result: null, error: '缺少必要参数: q 或 resourceId' },
      {
        headers: {
          // 结果按用户可用的视频源过滤，只能由浏览器缓存，不能进入共享缓存
          'Cache-Control': `private, max-age=${cacheTime}`,
        },
      }
    );
  }

  const config = await getConfig();
  const apiSites = await getAvailableApiSites(authInfo.username);

  try {
    // 根据 resourceId 查找对应的 API 站点
    const targetSite = apiSites.find((site) => site.key === resourceId);
    if (!targetSite) {
      return NextResponse.json(
        {
          error: `未找到指定的视频源: ${resourceId}`,
          result: null,
        },
        { status: 404 }
      );
    }

    const results = await searchFromApi(targetSite, query);
    let result = results.filter((r) => r.title === query);
    if (!config.SiteConfig.DisableYellowFilter) {
      result = result.filter((result) => {
        const typeName = result.type_name || '';
        return !yellowWords.some((word: string) => typeName.includes(word));
      });
    }
    const cacheTime = await getCacheTime();

    if (result.length === 0) {
      return NextResponse.json(
        {
          error: '未找到结果',
          result: null,
        },
        { status: 404 }
      );
    } else {
      return NextResponse.json(
        { results: result },
        {
          headers: {
            // 结果按用户可用的视频源过滤，只能由浏览器缓存，不能进入共享缓存
            'Cache-Control': `private, max-age=${cacheTime}`,
          },
        }
      );
    }
  } catch (error) {
    return NextResponse.json(
      {
        error: '搜索失败',
        result: null,
      },
      { status: 500 }
    );
  }
}
