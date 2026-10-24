/**
 * HLS 播放列表改写：把播放列表里的地址替换成站内代理地址。
 *
 * 地址解析遵循 RFC 3986 / HLS 规范：相对地址相对于「播放列表自身的最终 URL」解析，
 * 不对扩展名做假设（index.php、无扩展名的地址都按文件处理）。
 */

export type ProxyKind = 'm3u8' | 'segment' | 'key';

export interface RewriteOptions {
  /** 站内代理前缀，例如 /api/proxy */
  proxyBase: string;
  /** 直播源 key，附加在代理地址上 */
  sourceKey: string;
  /** 为原始地址生成签名 */
  sign: (url: string) => string;
  /** 浏览器直连模式：媒体分片保留原始地址，由浏览器直接请求 */
  direct?: boolean;
}

// 播放列表常见的 Content-Type；部分源会错误地标成 text/plain 或 octet-stream
export function isPlaylistContentType(contentType: string | null): boolean {
  const ct = (contentType || '').toLowerCase();
  return (
    ct.includes('mpegurl') ||
    ct.includes('octet-stream') ||
    ct.includes('text/plain')
  );
}

export function looksLikePlaylist(body: string): boolean {
  return body.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U');
}

export function resolveAgainst(playlistUrl: string, ref: string): string {
  try {
    return new URL(ref, playlistUrl).href;
  } catch {
    return ref;
  }
}

export function buildProxyUrl(
  kind: ProxyKind,
  url: string,
  opts: Pick<RewriteOptions, 'proxyBase' | 'sourceKey' | 'sign'>
): string {
  const params = new URLSearchParams({
    url,
    'moontv-source': opts.sourceKey,
    sig: opts.sign(url),
  });
  return `${opts.proxyBase}/${kind}?${params.toString()}`;
}

// 标签里 URI 指向的资源类型；未列出的标签保持原样
const URI_TAGS: Record<string, ProxyKind> = {
  '#EXT-X-MAP:': 'segment',
  '#EXT-X-KEY:': 'key',
  '#EXT-X-SESSION-KEY:': 'key',
  '#EXT-X-MEDIA:': 'm3u8',
  '#EXT-X-I-FRAME-STREAM-INF:': 'm3u8',
  '#EXT-X-PART:': 'segment',
  '#EXT-X-PRELOAD-HINT:': 'segment',
};

function rewriteUriAttr(
  line: string,
  kind: ProxyKind,
  playlistUrl: string,
  opts: RewriteOptions
): string {
  return line.replace(/URI="([^"]+)"/, (whole, uri: string) => {
    // 内联密钥 / DRM 方案不是网络地址，不做处理
    if (/^(data|skd):/i.test(uri)) return whole;
    if (kind === 'key' && /METHOD=NONE/i.test(line)) return whole;
    const abs = resolveAgainst(playlistUrl, uri);
    return `URI="${buildProxyUrl(kind, abs, opts)}"`;
  });
}

export function rewritePlaylist(
  content: string,
  playlistUrl: string,
  opts: RewriteOptions
): string {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  const variantCount = lines.filter((l) =>
    l.trim().startsWith('#EXT-X-STREAM-INF:')
  ).length;

  const out: string[] = [];
  let nextIsVariant = false;

  for (const raw of lines) {
    let line = raw.trim();
    if (!line) {
      out.push(line);
      continue;
    }

    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        nextIsVariant = true;
        // 只有一个码率时 CODECS 只用于筛选；部分源会写出非法值导致播放器直接放弃，
        // 去掉后由播放器从媒体数据中识别编码
        if (variantCount === 1) {
          line = line
            .replace(/,CODECS="[^"]*"/, '')
            .replace(/CODECS="[^"]*",?/, '');
        }
        out.push(line);
        continue;
      }
      const tag = Object.keys(URI_TAGS).find((t) => line.startsWith(t));
      if (tag) {
        line = rewriteUriAttr(line, URI_TAGS[tag], playlistUrl, opts);
      }
      out.push(line);
      continue;
    }

    // URI 行
    const abs = resolveAgainst(playlistUrl, line);
    if (nextIsVariant) {
      out.push(buildProxyUrl('m3u8', abs, opts));
      nextIsVariant = false;
    } else if (opts.direct) {
      out.push(abs);
    } else {
      out.push(buildProxyUrl('segment', abs, opts));
    }
  }

  return out.join('\n');
}
