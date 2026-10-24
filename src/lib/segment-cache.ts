/**
 * 直播分片共享缓存。
 *
 * 同一频道有多人同时观看时，播放器会在几秒内请求同一个分片地址。
 * 第一个请求边转发边保存一份完整副本，之后的请求直接用内存里的副本（或等待正在进行的下载），
 * 上游只被拉取一次。分片只缓存很短时间，总大小有上限，按最近最少使用淘汰。
 */

const TTL_MS = 60 * 1000;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = Number(process.env.SEGMENT_CACHE_MB || 256) * 1024 * 1024;

export interface CachedSegment {
  body: Uint8Array;
  contentType: string;
  at: number;
}

// Map 保持插入顺序，重新插入即可实现 LRU
const done = new Map<string, CachedSegment>();
const pending = new Map<string, Promise<CachedSegment | null>>();
let totalBytes = 0;

function evict(now: number) {
  done.forEach((v, k) => {
    if (now - v.at > TTL_MS) {
      done.delete(k);
      totalBytes -= v.body.byteLength;
    }
  });
  const it = done.keys();
  while (totalBytes > MAX_TOTAL_BYTES) {
    const k = it.next();
    if (k.done) break;
    const v = done.get(k.value);
    done.delete(k.value);
    if (v) totalBytes -= v.body.byteLength;
  }
}

export function getCachedSegment(url: string): CachedSegment | null {
  const hit = done.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    done.delete(url);
    totalBytes -= hit.body.byteLength;
    return null;
  }
  // 刷新 LRU 位置
  done.delete(url);
  done.set(url, hit);
  return hit;
}

/** 正在下载中的同一分片：等待其完成后复用 */
export function getPendingSegment(url: string): Promise<CachedSegment | null> | null {
  return pending.get(url) || null;
}

/**
 * 把上游响应体一分为二：一份流式返回给当前请求，一份收集起来放入缓存。
 * 返回给当前请求使用的流。
 */
export function teeIntoCache(
  url: string,
  body: ReadableStream<Uint8Array>,
  contentType: string,
  declaredLength: number
): ReadableStream<Uint8Array> {
  if (declaredLength > MAX_ENTRY_BYTES) return body;

  const [toClient, toCache] = body.tee();
  const job = (async (): Promise<CachedSegment | null> => {
    const reader = toCache.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        size += value.byteLength;
        if (size > MAX_ENTRY_BYTES) {
          reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(value);
      }
    } catch {
      return null;
    }
    const merged = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    const entry = { body: merged, contentType, at: Date.now() };
    done.set(url, entry);
    totalBytes += size;
    evict(entry.at);
    return entry;
  })().finally(() => pending.delete(url));

  pending.set(url, job);
  return toClient;
}

export function _segmentCacheStats() {
  return { entries: done.size, totalBytes, pending: pending.size };
}
