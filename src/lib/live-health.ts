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
  /** HEAD 不受支持、又不像播放列表的线路，没有判断 */
  unknown: number;
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

// 播放列表一定是小文件，可以放心 GET；其余（视频流）只看响应头，不读响应体
const PLAYLIST_PATH_RE = /\.(m3u8?|txt)(\?|$)/i;

function isPlaylistType(ct: string): boolean {
  return /mpegurl|text\/plain/i.test(ct);
}

function isStreamType(ct: string): boolean {
  return /^(video|audio)\//i.test(ct) || /x-flv|mp2t/i.test(ct);
}

/**
 * 检查一条线路是否可用。
 *
 * 只发 HEAD 判断：直播的 TS / FLV 是不会结束的流，GET 之后即使立刻断开，
 * 经过 Docker Desktop 代理等中间层时上游连接也可能不会关闭，导致持续下载。
 * 因此只有确认是播放列表（小文件）时才会 GET；视频流根据响应头判定可用；
 * HEAD 不被支持且地址也不像播放列表时，不做判断（返回 null，不标记失效）。
 */
export async function checkLine(url: string, ua: string): Promise<LineHealth | null> {
  const t0 = Date.now();
  const done = (state: HealthState, reason?: string): LineHealth => ({
    state,
    ms: Date.now() - t0,
    checkedAt: Date.now(),
    reason,
  });
  const headers = { 'User-Agent': ua };

  let head: Response;
  try {
    head = await fetchWithHeaderTimeout(url, { method: 'HEAD', redirect: 'follow', headers }, 8000);
  } catch (error) {
    return done('down', (error as Error).name === 'TimeoutError' ? '超时' : (error as Error).message);
  }

  const ct = head.headers.get('content-type') || '';
  const finalUrl = head.url || url;
  const headUnsupported = head.status === 405 || head.status === 501;

  if (!head.ok && !headUnsupported) return done('down', `HTTP ${head.status}`);
  if (head.ok && isStreamType(ct)) return done('ok');

  const looksLikePlaylist = (head.ok && isPlaylistType(ct)) || PLAYLIST_PATH_RE.test(new URL(finalUrl).pathname);
  if (!looksLikePlaylist) {
    // HEAD 正常但类型不明（例如 octet-stream）：服务器在线，按可用处理，不去下载
    return head.ok ? done('ok') : null;
  }

  try {
    const res = await fetchWithHeaderTimeout(finalUrl, { headers }, 8000);
    if (!res.ok) {
      res.body?.cancel().catch(() => undefined);
      return done('down', `HTTP ${res.status}`);
    }
    // 防御：GET 拿到的其实是视频流时不读内容
    const getType = res.headers.get('content-type') || '';
    if (isStreamType(getType)) {
      res.body?.cancel().catch(() => undefined);
      return done('ok');
    }
    const verdict = classifyHead(await readHead(res));
    return done(verdict.ok ? 'ok' : 'down', verdict.reason);
  } catch (error) {
    return done('down', (error as Error).name === 'TimeoutError' ? '超时' : (error as Error).message);
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
    let down = 0;
    await runPool(urls, 16, async (url) => {
      const h = await checkLine(url, ua || 'AptvPlayer/1.4.10');
      if (!h) return;
      health.set(url, h);
      if (h.state === 'ok') ok++;
      else down++;
    });
    const summary = { key, total: urls.length, ok, down, unknown: urls.length - ok - down, durationMs: Date.now() - t0 };
    logger.info(
      `直播源 ${key} 线路检查完成: 可用 ${ok}，失效 ${down}，未判断 ${summary.unknown}，共 ${urls.length}，用时 ${summary.durationMs}ms`
    );
    return summary;
  })().finally(() => running.delete(key));
  running.set(key, job);
  return job;
}
