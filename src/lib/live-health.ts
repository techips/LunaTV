/**
 * 直播线路健康检查：轻量请求每条线路的地址，判断是否返回播放列表或视频流。
 * 结果只保存在进程内，用于前端把失效线路排到后面并标记。
 */

import { fetchWithHeaderTimeout } from './fetch-timeout';
import { looksLikePlaylist } from './hls-rewrite';
import { getCachedLiveChannels, LiveChannel } from './live';
import { logger } from './logger';

export type HealthState = 'ok' | 'down';

export interface LineHealth {
  state: HealthState;
  ms: number;
  checkedAt: number;
  reason?: string;
}

const health = new Map<string, LineHealth>();
const running = new Map<string, Promise<HealthSummary>>();

export interface HealthSummary {
  key: string;
  total: number;
  ok: number;
  down: number;
  durationMs: number;
}

export function getLineHealth(url: string): LineHealth | undefined {
  return health.get(url);
}

/** 读取开头少量字节判断内容类型 */
async function readHead(res: Response, max = 64 * 1024): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function classifyHead(head: Uint8Array): { ok: boolean; reason?: string } {
  if (head.length === 0) return { ok: false, reason: '空响应' };
  const text = new TextDecoder().decode(head.slice(0, 4096));
  if (looksLikePlaylist(text)) {
    return /#EXTINF|#EXT-X-STREAM-INF/.test(text)
      ? { ok: true }
      : { ok: false, reason: '播放列表为空' };
  }
  if (head[0] === 0x47 && (head.length < 189 || head[188] === 0x47)) return { ok: true }; // MPEG-TS
  if (text.startsWith('FLV')) return { ok: true };
  if (text.slice(4, 8) === 'ftyp') return { ok: true };
  if (/^\s*</.test(text)) return { ok: false, reason: '返回的是网页' };
  return { ok: false, reason: '无法识别的内容' };
}

export async function checkLine(url: string, ua: string): Promise<LineHealth> {
  const t0 = Date.now();
  try {
    const res = await fetchWithHeaderTimeout(url, { headers: { 'User-Agent': ua } }, 8000);
    if (!res.ok) {
      res.body?.cancel().catch(() => undefined);
      return { state: 'down', ms: Date.now() - t0, checkedAt: Date.now(), reason: `HTTP ${res.status}` };
    }
    const verdict = classifyHead(await readHead(res));
    return {
      state: verdict.ok ? 'ok' : 'down',
      ms: Date.now() - t0,
      checkedAt: Date.now(),
      reason: verdict.reason,
    };
  } catch (error) {
    return {
      state: 'down',
      ms: Date.now() - t0,
      checkedAt: Date.now(),
      reason: (error as Error).name === 'TimeoutError' ? '超时' : (error as Error).message,
    };
  }
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        await fn(items[i++]);
      }
    })
  );
}

/** 检查某个直播源的全部线路（同一直播源的并发检查会合并） */
export function checkSourceHealth(key: string, ua?: string): Promise<HealthSummary> {
  const existing = running.get(key);
  if (existing) return existing;
  const job = (async (): Promise<HealthSummary> => {
    const t0 = Date.now();
    const data = await getCachedLiveChannels(key);
    const channels: LiveChannel[] = data?.channels || [];
    const urls = Array.from(new Set(channels.map((c) => c.url)));
    let ok = 0;
    await runPool(urls, 16, async (url) => {
      const h = await checkLine(url, ua || 'AptvPlayer/1.4.10');
      health.set(url, h);
      if (h.state === 'ok') ok++;
    });
    const summary = { key, total: urls.length, ok, down: urls.length - ok, durationMs: Date.now() - t0 };
    logger.info(`直播源 ${key} 线路检查完成: ${ok}/${urls.length} 可用，用时 ${summary.durationMs}ms`);
    return summary;
  })().finally(() => running.delete(key));
  running.set(key, job);
  return job;
}
