import { NextRequest, NextResponse } from 'next/server';

import { getConfig, updateConfig } from '@/lib/config';
import { deleteCachedLiveChannels, deleteHostedPlaylist, refreshLiveChannels } from '@/lib/live';
import { logger } from '@/lib/logger';
import { rejectLocalStorage, requireAuth } from '@/lib/require-auth';

export const runtime = 'nodejs';

const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

function validUrl(url: unknown): url is string {
  return (
    typeof url === 'string' &&
    (/^https?:\/\//i.test(url) || url.startsWith('data:') || url.startsWith('hosted:'))
  );
}

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function POST(request: NextRequest) {
  const local = rejectLocalStorage();
  if (local) return local;
  const auth = await requireAuth(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const { action, key, name, url, ua, epg } = body;

    switch (action) {
      case 'add':
      case 'edit': {
        if (typeof key !== 'string' || !KEY_RE.test(key)) {
          return bad('key 只能包含字母、数字、下划线和短横线');
        }
        if (typeof name !== 'string' || !name.trim()) return bad('名称不能为空');
        if (!validUrl(url)) return bad('地址必须是 http(s) 链接');

        const current = (await getConfig()).LiveConfig?.find((l) => l.key === key);
        if (action === 'add' && current) return bad('直播源 key 已存在');
        if (action === 'edit') {
          if (!current) return bad('直播源不存在', 404);
          if (current.from === 'config') return bad('不能编辑配置文件中的直播源');
        }

        const info = {
          key,
          name: name.trim(),
          url,
          ua: typeof ua === 'string' ? ua : '',
          epg: typeof epg === 'string' ? epg : '',
          from: 'custom' as const,
          channelNumber: 0,
          disabled: current?.disabled ?? false,
        };
        // 网络请求放在配置事务之外
        try {
          info.channelNumber = await refreshLiveChannels(info);
        } catch (error) {
          logger.error('刷新直播源失败:', (error as Error).message);
        }

        return await updateConfig((cfg) => {
          const idx = cfg.LiveConfig.findIndex((l) => l.key === key);
          if (action === 'add') {
            if (idx !== -1) return bad('直播源 key 已存在');
            cfg.LiveConfig.push(info);
          } else {
            if (idx === -1) return bad('直播源不存在', 404);
            cfg.LiveConfig[idx] = { ...cfg.LiveConfig[idx], ...info };
          }
          return NextResponse.json({ success: true, channelNumber: info.channelNumber });
        });
      }

      case 'delete': {
        const res = await updateConfig((cfg) => {
          const idx = cfg.LiveConfig.findIndex((l) => l.key === key);
          if (idx === -1) return bad('直播源不存在', 404);
          if (cfg.LiveConfig[idx].from === 'config') return bad('不能删除配置文件中的直播源');
          cfg.LiveConfig.splice(idx, 1);
          return NextResponse.json({ success: true });
        });
        if (res.ok) {
          deleteCachedLiveChannels(key);
          await deleteHostedPlaylist(key);
        }
        return res;
      }

      case 'enable':
      case 'disable':
        return await updateConfig((cfg) => {
          const source = cfg.LiveConfig.find((l) => l.key === key);
          if (!source) return bad('直播源不存在', 404);
          source.disabled = action === 'disable';
          return NextResponse.json({ success: true });
        });

      case 'sort': {
        const { order } = body;
        if (!Array.isArray(order)) return bad('排序数据格式错误');
        return await updateConfig((cfg) => {
          const byKey = new Map(cfg.LiveConfig.map((l) => [l.key, l]));
          const sorted = order.map((k: string) => byKey.get(k)).filter(Boolean) as typeof cfg.LiveConfig;
          cfg.LiveConfig.forEach((l) => {
            if (!order.includes(l.key)) sorted.push(l);
          });
          cfg.LiveConfig = sorted;
          return NextResponse.json({ success: true });
        });
      }

      default:
        return bad('未知操作');
    }
  } catch (error) {
    logger.error('直播源操作失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '操作失败' },
      { status: 500 }
    );
  }
}
