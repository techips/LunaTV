/**
 * @jest-environment node
 */
import { checkLine } from '@/lib/live-health';

// 只用到 checkLine，不需要真实的配置 / 数据库
jest.mock('@/lib/live', () => ({ getCachedLiveChannels: jest.fn() }));

type Reply = { status: number; type?: string; body?: string; url?: string } | 'network-error';

// 记录每次请求的方法，按 (方法, 地址) 返回预设响应
function mockFetch(routes: Record<string, Reply>) {
  const calls: string[] = [];
  global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    calls.push(`${method} ${url}`);
    const r = routes[`${method} ${url}`];
    if (!r) throw new Error(`unexpected ${method} ${url}`);
    if (r === 'network-error') throw new TypeError('fetch failed');
    const res = new Response(method === 'HEAD' ? null : r.body ?? '', {
      status: r.status,
      headers: r.type ? { 'content-type': r.type } : {},
    });
    Object.defineProperty(res, 'url', { value: r.url || url });
    return res;
  }) as typeof fetch;
  return calls;
}

const UA = 'test';

describe('线路检查只信任 HEAD，不会打开视频流', () => {
  const realFetch = global.fetch;
  afterAll(() => {
    global.fetch = realFetch;
  });

  it('TS / FLV 直播流只发 HEAD', async () => {
    for (const [url, type] of [
      ['http://a.example/live/cctv1', 'video/mp2t'],
      ['http://a.example/live/x.flv', 'video/x-flv'],
    ]) {
      const calls = mockFetch({ [`HEAD ${url}`]: { status: 200, type } });
      expect((await checkLine(url, UA))?.state).toBe('ok');
      expect(calls).toEqual([`HEAD ${url}`]);
    }
  });

  it('HEAD 类型不明（octet-stream）时按在线处理，不下载', async () => {
    const url = 'http://a.example/stream.m3u8';
    const calls = mockFetch({ [`HEAD ${url}`]: { status: 200, type: 'application/octet-stream' } });
    expect((await checkLine(url, UA))?.state).toBe('ok');
    expect(calls).toEqual([`HEAD ${url}`]);
  });

  it('HEAD 明确是播放列表时才 GET 检查内容', async () => {
    const url = 'http://a.example/live/index.m3u8';
    const calls = mockFetch({
      [`HEAD ${url}`]: { status: 200, type: 'application/vnd.apple.mpegurl' },
      [`GET ${url}`]: { status: 200, type: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXTINF:5,\na.ts\n' },
    });
    expect((await checkLine(url, UA))?.state).toBe('ok');
    expect(calls).toEqual([`HEAD ${url}`, `GET ${url}`]);
  });

  it('空播放列表判定为失效', async () => {
    const url = 'http://a.example/empty.m3u8';
    mockFetch({
      [`HEAD ${url}`]: { status: 200, type: 'text/plain' },
      [`GET ${url}`]: { status: 200, type: 'text/plain', body: '#EXTM3U\n' },
    });
    const h = await checkLine(url, UA);
    expect(h?.state).toBe('down');
    expect(h?.reason).toBe('播放列表为空');
  });

  it('GET 播放列表返回 404 判定为失效', async () => {
    const url = 'http://a.example/gone.m3u8';
    mockFetch({
      [`HEAD ${url}`]: { status: 200, type: 'application/vnd.apple.mpegurl' },
      [`GET ${url}`]: { status: 404 },
    });
    const h = await checkLine(url, UA);
    expect(h?.state).toBe('down');
    expect(h?.reason).toBe('HTTP 404');
  });

  it('GET 实际返回视频流时不读内容', async () => {
    const url = 'http://a.example/live/fake.m3u8';
    const calls = mockFetch({
      [`HEAD ${url}`]: { status: 200, type: 'application/vnd.apple.mpegurl' },
      [`GET ${url}`]: { status: 200, type: 'video/mp2t', body: 'G' },
    });
    expect((await checkLine(url, UA))?.state).toBe('ok');
    expect(calls).toHaveLength(2);
  });

  it('服务器不接受 HEAD（403 / 404 / 405）：不判断，也绝不发 GET', async () => {
    for (const status of [403, 404, 405, 502]) {
      const url = `http://a.example/douyu/${status}`;
      const calls = mockFetch({ [`HEAD ${url}`]: { status } });
      expect(await checkLine(url, UA)).toBeNull();
      expect(calls).toEqual([`HEAD ${url}`]);
    }
  });

  it('连不上判定为失效', async () => {
    const url = 'http://a.example/down';
    const calls = mockFetch({ [`HEAD ${url}`]: 'network-error' });
    const h = await checkLine(url, UA);
    expect(h?.state).toBe('down');
    expect(calls).toEqual([`HEAD ${url}`]);
  });
});
