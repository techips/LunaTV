/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig, refineConfig, updateConfig } from '@/lib/config';
import { fetchSubscriptionConfig } from '@/lib/config-subscription';
import { db } from '@/lib/db';
import { fetchVideoDetail } from '@/lib/fetchVideoDetail';
import { refreshAllLiveSources } from '@/lib/live';
import { safeEqualHex } from '@/lib/server-secret';
import { SearchResult } from '@/lib/types';

export const runtime = 'nodejs';

// 最小执行间隔：该任务会遍历所有用户的播放记录/收藏并请求上游，
// 频繁触发会造成资源浪费，这里做一层节流与互斥，避免任务堆叠
const MIN_INTERVAL_MS = 5 * 60 * 1000;
let runningJob: Promise<void> | null = null;
let lastRunAt = 0;

function safeEqualText(a: string, b: string): boolean {
  return safeEqualHex(Buffer.from(a).toString('hex'), Buffer.from(b).toString('hex'));
}

/**
 * 仅允许两类调用方：
 *  - start.js 在本进程内发起的定时调用（x-cron-token 为启动时生成的随机令牌）
 *  - 携带 CRON_SECRET 的外部调度（Vercel Cron 使用 Authorization: Bearer <CRON_SECRET>）
 */
function isAuthorizedCron(request: NextRequest): boolean {
  const internal = process.env.INTERNAL_CRON_TOKEN;
  const token = request.headers.get('x-cron-token');
  if (internal && token && safeEqualText(token, internal)) return true;

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    const provided = bearer || request.headers.get('x-cron-secret') || '';
    if (provided && safeEqualText(provided, secret)) return true;
  }
  return false;
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (runningJob) {
    return NextResponse.json({
      success: true,
      message: 'Cron job already running, skipped',
      timestamp: new Date().toISOString(),
    });
  }

  const now = Date.now();
  if (now - lastRunAt < MIN_INTERVAL_MS) {
    return NextResponse.json({
      success: true,
      message: 'Cron job skipped, triggered too frequently',
      timestamp: new Date().toISOString(),
    });
  }

  lastRunAt = now;
  runningJob = cronJob()
    .catch((err) => {
      console.error('Cron job failed:', err);
    })
    .finally(() => {
      runningJob = null;
    });

  return NextResponse.json({
    success: true,
    message: 'Cron job started',
    timestamp: new Date().toISOString(),
  });
}

async function cronJob() {
  console.log('Cron job started:', new Date().toISOString());
  await refreshConfig();
  await refreshAllLiveSources();
  await refreshRecordAndFavorites();
}

async function refreshConfig() {
  const config = await getConfig();
  const sub = config.ConfigSubscription;
  if (!sub?.URL || !sub.AutoUpdate) {
    console.log('跳过刷新：未配置订阅地址或自动更新');
    return;
  }
  try {
    // 网络请求在配置事务外完成
    const content = await fetchSubscriptionConfig(sub.URL);
    await updateConfig((cfg) => {
      cfg.ConfigFile = content;
      cfg.ConfigSubscription.LastCheck = new Date().toISOString();
      refineConfig(cfg);
    });
  } catch (e) {
    console.error('刷新配置失败:', (e as Error).message);
  }
}

// key 形如 source+id，id 本身可能含有 +
function splitRecordKey(key: string): [string, string] | null {
  const idx = key.indexOf('+');
  if (idx <= 0 || idx === key.length - 1) return null;
  return [key.slice(0, idx), key.slice(idx + 1)];
}

async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = [];
  let index = 0;
  const worker = async () => {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

async function refreshRecordAndFavorites() {
  try {
    const users = await db.getAllUsers();
    if (process.env.USERNAME && !users.includes(process.env.USERNAME)) {
      users.push(process.env.USERNAME);
    }

    // 同一视频的详情只请求一次
    const detailCache = new Map<string, Promise<SearchResult | null>>();
    const getDetail = (source: string, id: string, fallbackTitle: string) => {
      const key = `${source}+${id}`;
      let promise = detailCache.get(key);
      if (!promise) {
        promise = fetchVideoDetail({ source, id, fallbackTitle: fallbackTitle.trim() }).catch((err) => {
          console.warn(`获取视频详情失败 (${key}):`, err.message);
          return null;
        });
        detailCache.set(key, promise);
      }
      return promise;
    };

    const processUser = async (user: string) => {
      // 播放记录
      try {
        const records = await db.getAllPlayRecords(user);
        let updated = 0;
        await runWithConcurrency(
          Object.entries(records).map(([key, record]) => async () => {
            const parts = splitRecordKey(key);
            if (!parts) return;
            const detail = await getDetail(parts[0], parts[1], record.title);
            const count = detail?.episodes?.length || 0;
            if (detail && count > 0 && count !== record.total_episodes) {
              await db.savePlayRecord(user, parts[0], parts[1], {
                ...record,
                title: detail.title || record.title,
                cover: detail.poster || record.cover,
                year: detail.year || record.year,
                total_episodes: count,
              });
              updated++;
            }
          }),
          5
        );
        if (updated) console.log(`用户 ${user}：更新了 ${updated} 条播放记录`);
      } catch (err) {
        console.error(`处理播放记录失败 (${user}):`, err);
      }

      // 收藏（直播收藏不需要刷新集数）
      try {
        const favorites = await db.getAllFavorites(user);
        let updated = 0;
        await runWithConcurrency(
          Object.entries(favorites)
            .filter(([, fav]) => fav.origin !== 'live')
            .map(([key, fav]) => async () => {
              const parts = splitRecordKey(key);
              if (!parts) return;
              const detail = await getDetail(parts[0], parts[1], fav.title);
              const count = detail?.episodes?.length || 0;
              if (detail && count > 0 && count !== fav.total_episodes) {
                await db.saveFavorite(user, parts[0], parts[1], {
                  ...fav,
                  title: detail.title || fav.title,
                  cover: detail.poster || fav.cover,
                  year: detail.year || fav.year,
                  total_episodes: count,
                });
                updated++;
              }
            }),
          5
        );
        if (updated) console.log(`用户 ${user}：更新了 ${updated} 条收藏`);
      } catch (err) {
        console.error(`处理收藏失败 (${user}):`, err);
      }
    };

    await runWithConcurrency(users.map((u) => () => processUser(u)), 3);
    console.log('刷新播放记录/收藏任务完成');
  } catch (err) {
    console.error('刷新播放记录/收藏任务启动失败', err);
  }
}
