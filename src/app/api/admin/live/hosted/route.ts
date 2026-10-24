import { NextRequest, NextResponse } from 'next/server';

import { getConfig, updateConfig } from '@/lib/config';
import { db } from '@/lib/db';
import {
  HOSTED_PLAYLIST_MAX_BYTES,
  hostedUrl,
  parseM3U,
  refreshLiveChannels,
  saveHostedPlaylist,
} from '@/lib/live';
import { logger } from '@/lib/logger';
import { rejectLocalStorage, requireAuth } from '@/lib/require-auth';

export const runtime = 'nodejs';

const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** 读取托管播放列表内容（用于后台编辑） */
export async function GET(request: NextRequest) {
  const local = rejectLocalStorage();
  if (local) return local;
  const auth = await requireAuth(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  const key = new URL(request.url).searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return bad('key 不合法');
  const content = await db.getHostedPlaylist(key);
  if (content === null) return bad('托管播放列表不存在', 404);
  return NextResponse.json({ key, content }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * 新建或更新托管播放列表：直接在后台粘贴 / 上传 m3u 内容，存入数据库，
 * 不再需要把列表放到外部地址或塞进超长的 data: 地址。
 */
export async function POST(request: NextRequest) {
  const local = rejectLocalStorage();
  if (local) return local;
  const auth = await requireAuth(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  try {
    const { key, name, content, epg, ua } = await request.json();
    if (typeof key !== 'string' || !KEY_RE.test(key)) {
      return bad('key 只能包含字母、数字、下划线和短横线');
    }
    if (typeof name !== 'string' || !name.trim()) return bad('名称不能为空');
    if (typeof content !== 'string' || !content.trim()) return bad('播放列表内容不能为空');
    if (Buffer.byteLength(content) > HOSTED_PLAYLIST_MAX_BYTES) {
      return bad(`播放列表不能超过 ${HOSTED_PLAYLIST_MAX_BYTES / 1024 / 1024}MB`);
    }
    const parsed = parseM3U(key, content);
    if (parsed.channels.length === 0) {
      return bad('没有解析到任何频道，请确认是 M3U 格式（#EXTINF + 地址）');
    }

    const existing = (await getConfig()).LiveConfig.find((l) => l.key === key);
    if (existing && existing.url !== hostedUrl(key)) {
      return bad('该 key 已被非托管的直播源使用');
    }

    await saveHostedPlaylist(key, content);
    const info = {
      key,
      name: name.trim(),
      url: hostedUrl(key),
      ua: typeof ua === 'string' ? ua : '',
      epg: typeof epg === 'string' ? epg : '',
      from: 'custom' as const,
      channelNumber: 0,
      disabled: existing?.disabled ?? false,
    };
    try {
      info.channelNumber = await refreshLiveChannels(info);
    } catch (error) {
      logger.warn('刷新托管直播源失败:', (error as Error).message);
    }

    await updateConfig((cfg) => {
      const idx = cfg.LiveConfig.findIndex((l) => l.key === key);
      if (idx === -1) cfg.LiveConfig.push(info);
      else cfg.LiveConfig[idx] = { ...cfg.LiveConfig[idx], ...info };
    });

    return NextResponse.json({ success: true, channelNumber: info.channelNumber });
  } catch (error) {
    logger.error('保存托管播放列表失败:', error);
    return NextResponse.json({ error: (error as Error).message || '保存失败' }, { status: 500 });
  }
}
