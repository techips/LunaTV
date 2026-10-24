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
  /** 服务器不接受 HEAD 的线路，没有判断 */
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

function isPlaylistType(ct: string): boolean {
  return /mpegurl|text\/plain/i.test(ct);
}


/**
 * 检查一条线路是否可用。
 *
 * 只信任 HEAD：直播的 TS / FLV 是不会结束的流，一旦对它发出 GET，即使马上断开，
 * 经过 Docker Desktop 的网络层时上游连接也可能不会关闭，持续消耗流量（实测出现过数千条泄漏连接）。
 * 很多服务器还会忽略 Range，所以 Range GET 也不安全。
 * - HEAD 返回视频类型或类型不明：服务器在线，判定可用，不下载。
 * - HEAD 明确返回播放列表类型：播放列表是小文件，GET 读取内容确认。
 * - HEAD 失败（很多动态地址不接受 HEAD）：不判断（返回 null），既不误判失效，也不去下载。
 * 网络层错误（连不上、超时）判定为失效。
 */
export async function checkLine(url: string, ua: string): Promise<LineHealth | null> {
  const t0 = Date.now();
  const done = (state: HealthState, reason?: string): LineHealth => ({
    state,
    ms: Date.now() - t0,
    checkedAt: Date.now(),
    reason,
  });
  const failed = (error: unknown) =>
    done('down', (error as Error).name === 'TimeoutError' ? '超时' : (error as Error).message);
  const headers = { 'User-Agent': ua };

  let head: Response;
  try {
    head = await fetchWithHeaderTimeout(url, { method: 'HEAD', redirect: 'follow', headers }, 8000);
  } catch (error) {
    return failed(error);
  }
  if (!head.ok) return null;

  const headType = head.headers.get('content-type') || '';
  if (!isPlaylistType(headType)) return done('ok');

  // 只有 HEAD 明确说是播放列表时才 GET；读取时设上限，内容不对立即强制断开连接
  const controller = new AbortController();
  try {
    const res = await fetchWithHeaderTimeout(
      head.url || url,
      { redirect: 'follow', headers, signal: controller.signal },
      8000
    );
    if (!res.ok) {
      controller.abort();
      return done('down', `HTTP ${res.status}`);
    }
    if (!isPlaylistType(res.headers.get('content-type') || '')) {
      controller.abort();
      return done('ok');
    }
    const verdict = classifyHead(await readHead(res));
    controller.abort();
    return done(verdict.ok ? 'ok' : 'down', verdict.reason);
  } catch (error) {
    controller.abort();
    return failed(error);
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
