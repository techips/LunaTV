/**
 * @jest-environment node
 */
import { DecompressionStream, ReadableStream, TextDecoderStream } from 'stream/web';
import { gzipSync } from 'zlib';

import {
  decodeXmlEntities,
  EpgProgram,
  normalizeChannelName,
  parseM3U,
  parseXmltvStream,
  parseXmltvTime,
} from '@/lib/live';

// jest 27 的 node 环境没有暴露 Web Streams 全局对象（Node 22 运行时本身有）
Object.assign(globalThis, { ReadableStream, TextDecoderStream, DecompressionStream });

function streamOf(...chunks: (string | Uint8Array)[]): globalThis.ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      chunks.forEach((x) => c.enqueue(typeof x === 'string' ? enc.encode(x) : x));
      c.close();
    },
  }) as unknown as globalThis.ReadableStream<Uint8Array>;
}

describe('parseM3U', () => {
  it('解析属性、多 EPG 地址、标题中的逗号与附加行', () => {
    const { channels, tvgUrls } = parseM3U(
      'hd',
      [
        '﻿#EXTM3U x-tvg-url="https://a.example/e.xml,https://b.example/e.xml.gz"',
        '#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV-1" tvg-logo="https://l/1.png" group-title="央视,频道",CCTV-1 综合, 1080P',
        '#EXTVLCOPT:http-user-agent=Foo',
        'http://s.example/cctv1.m3u8',
        '#EXTINF:-1,无属性频道',
        'http://s.example/x.m3u8',
        '#EXTINF:-1,没有地址的条目',
      ].join('\r\n')
    );
    expect(tvgUrls).toEqual(['https://a.example/e.xml', 'https://b.example/e.xml.gz']);
    expect(channels).toHaveLength(2);
    expect(channels[0]).toMatchObject({
      id: 'hd-0',
      tvgId: 'CCTV1',
      tvgName: 'CCTV-1',
      name: 'CCTV-1 综合, 1080P',
      group: '央视,频道',
      url: 'http://s.example/cctv1.m3u8',
    });
    expect(channels[1]).toMatchObject({ name: '无属性频道', group: '无分组' });
  });
});

describe('XMLTV 解析', () => {
  const now = Date.UTC(2026, 9, 24, 8, 0, 0); // 2026-10-24 16:00 +0800

  it('解析压缩成一行、带实体与 CDATA 的节目单', async () => {
    const xml =
      '<?xml version="1.0"?><tv><channel id="jade"><display-name lang="zh">翡翠台</display-name><display-name>TVB Jade</display-name></channel>' +
      '<programme start="20261024160000 +0800" stop="20261024170000 +0800" channel="jade"><title lang="zh">新闻 &amp; 天气</title></programme>' +
      '<programme start="20261024170000 +0800" stop="20261024180000 +0800" channel="jade"><title><![CDATA[东张西望]]></title></programme>' +
      '<programme start="20261020170000 +0800" stop="20261020180000 +0800" channel="jade"><title>太旧的节目</title></programme></tv>';
    const channels: Record<string, string[]> = {};
    const progs: [string, EpgProgram][] = [];
    // 故意从元素中间切断，验证跨块拼接
    await parseXmltvStream(
      streamOf(xml.slice(0, 137), xml.slice(137, 300), xml.slice(300)),
      null,
      (id, names) => (channels[id] = names),
      (c, p) => progs.push([c, p]),
      now
    );
    expect(channels).toEqual({ jade: ['翡翠台', 'TVB Jade'] });
    expect(progs.map(([, p]) => p.title)).toEqual(['新闻 & 天气', '东张西望']);
  });

  it('支持 gzip 压缩的节目单', async () => {
    const xml =
      '<tv><programme start="20261024160000 +0800" stop="20261024170000 +0800" channel="c"><title>A</title></programme></tv>';
    const stream = streamOf(gzipSync(Buffer.from(xml))).pipeThrough(
      new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>
    );
    const titles: string[] = [];
    await parseXmltvStream(stream, null, () => undefined, (_c, p) => titles.push(p.title), now);
    expect(titles).toEqual(['A']);
  });

  it('时间带时区解析为 UTC 毫秒', () => {
    expect(parseXmltvTime('20261024160000 +0800')).toBe(now);
    expect(parseXmltvTime('20261024080000')).toBe(now);
    expect(Number.isNaN(parseXmltvTime('bad'))).toBe(true);
  });

  it('实体解码', () => {
    expect(decodeXmlEntities('A &lt;B&gt; &#39;C&#x27; &quot;D&quot; &unknown;')).toBe(`A <B> 'C' "D" &unknown;`);
  });
});

describe('频道名归一化（节目单按名称匹配）', () => {
  it('去掉清晰度、线路、标记等后缀', () => {
    expect(normalizeChannelName('浙江卫视 1080P 线路2 [直连]')).toBe(normalizeChannelName('浙江卫视'));
    expect(normalizeChannelName('翡翠台 4K HDR10 线路1 [代理]')).toBe(normalizeChannelName('翡翠台'));
    expect(normalizeChannelName('CCTV-1 HD')).toBe('CCTV1');
  });
});
