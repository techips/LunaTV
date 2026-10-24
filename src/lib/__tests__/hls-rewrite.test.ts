/**
 * @jest-environment node
 */
import {
  isPlaylistContentType,
  looksLikePlaylist,
  resolveAgainst,
  rewritePlaylist,
} from '@/lib/hls-rewrite';

const opts = {
  proxyBase: '/api/proxy',
  sourceKey: 'hd',
  sign: (u: string) => `sig(${u.length})`,
};

// 取出标签里的 URI 属性
function uriOf(line: string): string {
  const m = line.match(/URI="([^"]+)"/);
  if (!m) throw new Error(`no URI in ${line}`);
  return m[1];
}

// 从改写后的代理地址中取回原始地址
function targetOf(line: string): { kind: string; url: string; source: string } {
  const u = new URL(line, 'http://local');
  return {
    kind: u.pathname.split('/').pop() as string,
    url: u.searchParams.get('url') as string,
    source: u.searchParams.get('moontv-source') as string,
  };
}

describe('resolveAgainst', () => {
  it('把 index.php 当作文件而不是目录', () => {
    expect(
      resolveAgainst('https://h.example/163189/fct/video/index.php', '322709.jpg')
    ).toBe('https://h.example/163189/fct/video/322709.jpg');
  });

  it('无扩展名的播放列表地址同样按文件解析', () => {
    expect(resolveAgainst('https://cdn.example/163189/fct2', 'stream_0.m3u8')).toBe(
      'https://cdn.example/163189/stream_0.m3u8'
    );
  });

  it('保留相对地址自带的查询参数', () => {
    expect(
      resolveAgainst(
        'https://a.example/tvb/fct/stream_0.php?u=admin&p=1',
        'stream_0_00085.jpg?u=admin&p=1'
      )
    ).toBe('https://a.example/tvb/fct/stream_0_00085.jpg?u=admin&p=1');
  });

  it('处理站点根路径与协议相对地址', () => {
    expect(resolveAgainst('https://cdn6.example/163189/jade', '/api/jade/2325285')).toBe(
      'https://cdn6.example/api/jade/2325285'
    );
    expect(resolveAgainst('https://a.example/x/y.m3u8', '//b.example/z.ts')).toBe(
      'https://b.example/z.ts'
    );
  });
});

describe('isPlaylistContentType / looksLikePlaylist', () => {
  it('识别被标成 text/plain 的播放列表', () => {
    expect(isPlaylistContentType('text/plain; charset=utf-8')).toBe(true);
    expect(isPlaylistContentType('application/vnd.apple.mpegurl')).toBe(true);
    expect(isPlaylistContentType('video/mp2t')).toBe(false);
  });

  it('容忍 BOM 与前导空白', () => {
    expect(looksLikePlaylist('\uFEFF  #EXTM3U\n')).toBe(true);
    expect(looksLikePlaylist('<html>')).toBe(false);
  });
});

describe('rewritePlaylist', () => {
  it('媒体分片改写为带签名的 segment 代理地址', () => {
    const out = rewritePlaylist(
      '#EXTM3U\n#EXTINF:8,\nseg1.ts\n#EXTINF:8,\n/abs/seg2.ts',
      'https://cdn.example/live/index.php?token=1',
      opts
    ).split('\n');
    const segs = out.filter((l) => l.startsWith('/api/proxy/'));
    expect(segs.map(targetOf)).toEqual([
      { kind: 'segment', url: 'https://cdn.example/live/seg1.ts', source: 'hd' },
      { kind: 'segment', url: 'https://cdn.example/abs/seg2.ts', source: 'hd' },
    ]);
    expect(segs[0]).toContain('sig=');
  });

  it('子播放列表走 m3u8 代理', () => {
    const out = rewritePlaylist(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.64001f,mp4a.40.2"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2,CODECS="avc1.640028,mp4a.40.2"\nhigh.m3u8',
      'https://a.example/live/master.m3u8',
      opts
    ).split('\n');
    expect(targetOf(out[2])).toMatchObject({ kind: 'm3u8', url: 'https://a.example/live/low.m3u8' });
    // 多码率时保留 CODECS，供播放器筛选
    expect(out[1]).toContain('CODECS=');
  });

  it('单码率时去掉可能非法的 CODECS', () => {
    const out = rewritePlaylist(
      '#EXTM3U\n#EXT-X-STREAM-INF:PROGRAM-ID=0,BANDWIDTH=15256000,RESOLUTION=3840x2160,CODECS="hvc1.1.6.L153.B0.2.4.L153.b0,mp4a.40.2"\nstream_0.php',
      'https://a.example/fct4k',
      opts
    ).split('\n');
    expect(out[1]).not.toContain('CODECS');
    expect(out[1]).toContain('RESOLUTION=3840x2160');
  });

  it('改写 EXT-X-MEDIA 的独立音轨/字幕地址', () => {
    const out = rewritePlaylist(
      '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="au1",URI="/163189/fct/audio/index.php"\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="audio"\n/163189/fct/video/index.php',
      'https://h.example/163189/fct/',
      opts
    ).split('\n');
    const uri = uriOf(out[1]);
    expect(targetOf(uri)).toMatchObject({
      kind: 'm3u8',
      url: 'https://h.example/163189/fct/audio/index.php',
    });
  });

  it('EXT-X-MAP 走分片代理，EXT-X-KEY 走密钥代理，内联/空密钥保持原样', () => {
    const out = rewritePlaylist(
      [
        '#EXTM3U',
        '#EXT-X-MAP:URI="init.txt"',
        '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1',
        '#EXT-X-KEY:METHOD=NONE',
        '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://drm"',
        '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"',
      ].join('\n'),
      'https://h.example/v/index.php',
      opts
    ).split('\n');
    expect(targetOf(uriOf(out[1])).kind).toBe('segment');
    expect(targetOf(uriOf(out[2]))).toMatchObject({
      kind: 'key',
      url: 'https://h.example/v/key.bin',
    });
    expect(out[3]).toBe('#EXT-X-KEY:METHOD=NONE');
    expect(out[4]).toContain('URI="skd://drm"');
    expect(out[5]).toContain('URI="data:text/plain;base64,AAAA"');
  });

  it('浏览器直连模式下分片保留原地址，子播放列表仍走代理', () => {
    const out = rewritePlaylist(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n#EXTINF:8,\nseg.ts',
      'https://a.example/live/m.m3u8',
      { ...opts, direct: true }
    ).split('\n');
    expect(targetOf(out[2]).kind).toBe('m3u8');
    expect(out[4]).toBe('https://a.example/live/seg.ts');
  });

  it('处理 CRLF 换行与 BOM', () => {
    const out = rewritePlaylist(
      '\uFEFF#EXTM3U\r\n#EXTINF:8,\r\nseg.ts\r\n',
      'https://a.example/l/m.m3u8',
      opts
    );
    expect(out.startsWith('#EXTM3U')).toBe(true);
    expect(out).not.toContain('\r');
    expect(out).toContain(encodeURIComponent('https://a.example/l/seg.ts'));
  });
});
