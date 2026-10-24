/**
 * @jest-environment node
 */
import { ReadableStream } from 'stream/web';

import { filterAdsFromM3U8 } from '@/lib/hls-loaders';
import { _segmentCacheStats, getCachedSegment, getPendingSegment, teeIntoCache } from '@/lib/segment-cache';

function bytes(n: number, fill = 1) {
  return new Uint8Array(n).fill(fill);
}

function sourceStream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      chunks.forEach((x) => c.enqueue(x));
      c.close();
    },
  }) as unknown as globalThis.ReadableStream<Uint8Array>;
}

async function drain(s: globalThis.ReadableStream<Uint8Array>): Promise<number> {
  const r = s.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) return n;
    n += value.byteLength;
  }
}

describe('分片共享缓存', () => {
  it('首个请求边转发边缓存，之后的请求命中缓存', async () => {
    const url = 'https://cdn.example/seg-a.ts';
    const toClient = teeIntoCache(url, sourceStream([bytes(1000), bytes(500, 2)]), 'video/mp2t', 1500);
    // 下载进行中：其他请求可以等待同一份数据
    const pending = getPendingSegment(url);
    expect(pending).not.toBeNull();
    expect(await drain(toClient)).toBe(1500);
    const shared = await pending;
    expect(shared?.body.byteLength).toBe(1500);
    const hit = getCachedSegment(url);
    expect(hit?.contentType).toBe('video/mp2t');
    expect(hit?.body[1200]).toBe(2);
    expect(_segmentCacheStats().pending).toBe(0);
  });

  it('超过单条上限的分片不缓存', async () => {
    const url = 'https://cdn.example/huge.ts';
    const out = teeIntoCache(url, sourceStream([bytes(10)]), 'video/mp2t', 64 * 1024 * 1024);
    expect(getPendingSegment(url)).toBeNull();
    expect(await drain(out)).toBe(10);
    expect(getCachedSegment(url)).toBeNull();
  });
});

describe('去广告过滤', () => {
  it('移除 DISCONTINUITY 标记，保留其他内容', () => {
    const out = filterAdsFromM3U8('#EXTM3U\n#EXTINF:5,\na.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:5,\nad.ts');
    expect(out).toBe('#EXTM3U\n#EXTINF:5,\na.ts\n#EXTINF:5,\nad.ts');
    expect(filterAdsFromM3U8('')).toBe('');
  });
});
