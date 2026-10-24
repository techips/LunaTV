import { getConfig, updateConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { fetchWithTimeout } from '@/lib/fetch-timeout';

import { logger } from './logger';

const defaultUA = 'AptvPlayer/1.4.10';

// 频道列表缓存有效期；过期后先返回旧数据，后台刷新
const CHANNEL_TTL_MS = 60 * 60 * 1000;
// 节目单只保留当前时间前后这段范围，避免把多天数据常驻内存
const EPG_KEEP_BEFORE_MS = 6 * 60 * 60 * 1000;
const EPG_KEEP_AFTER_MS = 30 * 60 * 60 * 1000;
// 托管播放列表大小上限
export const HOSTED_PLAYLIST_MAX_BYTES = 5 * 1024 * 1024;

export interface LiveSourceInfo {
  key: string;
  name: string;
  url: string;
  ua?: string;
  epg?: string;
  from: 'config' | 'custom';
  channelNumber?: number;
  disabled?: boolean;
}

export interface LiveChannel {
  id: string;
  tvgId: string;
  tvgName: string;
  name: string;
  logo: string;
  group: string;
  url: string;
}

export interface EpgProgram {
  start: string;
  end: string;
  title: string;
}

export interface LiveChannels {
  channelNumber: number;
  channels: LiveChannel[];
  epgUrl: string;
  /** key 为前端使用的频道标识（tvgId，缺省时为频道名） */
  epgs: { [key: string]: EpgProgram[] };
  fetchedAt: number;
  urlSet: Set<string>;
  logoSet: Set<string>;
}

const cache = new Map<string, LiveChannels>();
const inflight = new Map<string, Promise<number>>();

export function deleteCachedLiveChannels(key: string) {
  cache.delete(key);
}

// ---------------- 托管播放列表（后台直接上传 / 编辑的 m3u） ----------------

export function hostedUrl(key: string) {
  return `hosted:${key}`;
}

export async function saveHostedPlaylist(key: string, content: string) {
  await db.setHostedPlaylist(key, content);
}

export async function deleteHostedPlaylist(key: string) {
  try {
    await db.deleteHostedPlaylist(key);
  } catch {
    // 非托管源没有对应数据
  }
}

// ---------------- 获取播放列表文本 ----------------

async function loadPlaylistText(info: LiveSourceInfo): Promise<string> {
  if (info.url.startsWith('hosted:')) {
    const text = await db.getHostedPlaylist(info.url.slice('hosted:'.length));
    if (text === null) throw new Error('托管播放列表不存在');
    return text;
  }
  if (info.url.startsWith('data:')) {
    const comma = info.url.indexOf(',');
    const meta = info.url.slice(5, comma);
    const payload = info.url.slice(comma + 1);
    return meta.endsWith(';base64')
      ? Buffer.from(payload, 'base64').toString('utf8')
      : decodeURIComponent(payload);
  }
  const res = await fetchWithTimeout(
    info.url,
    { headers: { 'User-Agent': info.ua || defaultUA } },
    20000
  );
  if (!res.ok) {
    res.body?.cancel().catch(() => undefined);
    throw new Error(`播放列表请求失败: HTTP ${res.status}`);
  }
  return res.text();
}

// ---------------- 刷新 ----------------

/** 拉取并解析直播源，更新缓存，返回频道数。同一直播源的并发刷新会合并。 */
export async function refreshLiveChannels(info: LiveSourceInfo): Promise<number> {
  const running = inflight.get(info.key);
  if (running) return running;
  const job = (async () => {
    const text = await loadPlaylistText(info);
    const parsed = parseM3U(info.key, text);
    const epgUrls = splitEpgUrls(info.epg || '').concat(parsed.tvgUrls);
    const uniqueEpgUrls = Array.from(new Set(epgUrls)).slice(0, 3);
    const epgs = await buildEpgIndex(uniqueEpgUrls, info.ua || defaultUA, parsed.channels);
    cache.set(info.key, {
      channelNumber: parsed.channels.length,
      channels: parsed.channels,
      epgUrl: uniqueEpgUrls.join(','),
      epgs,
      fetchedAt: Date.now(),
      urlSet: new Set(parsed.channels.map((c) => c.url)),
      logoSet: new Set(parsed.channels.map((c) => c.logo).filter(Boolean)),
    });
    return parsed.channels.length;
  })().finally(() => inflight.delete(info.key));
  inflight.set(info.key, job);
  return job;
}

/** 把各直播源的频道数写回配置（单独事务，不在网络请求期间持有配置） */
async function saveChannelCounts(counts: Record<string, number>) {
  if (Object.keys(counts).length === 0) return;
  await updateConfig((cfg) => {
    for (const live of cfg.LiveConfig) {
      if (live.key in counts) live.channelNumber = counts[live.key];
    }
  });
}

/** 刷新全部启用的直播源（后台刷新、定时任务使用） */
export async function refreshAllLiveSources(): Promise<Record<string, number>> {
  const config = await getConfig();
  const counts: Record<string, number> = {};
  await Promise.all(
    config.LiveConfig.filter((l) => !l.disabled).map(async (l) => {
      try {
        counts[l.key] = await refreshLiveChannels(l);
      } catch (error) {
        logger.error(`刷新直播源失败 [${l.name || l.key}]:`, (error as Error).message);
        counts[l.key] = 0;
      }
    })
  );
  await saveChannelCounts(counts);
  return counts;
}

/**
 * 获取直播源频道（带缓存）。
 * 缓存过期时先返回旧数据并在后台刷新；只有完全没有缓存时才在请求内等待拉取。
 */
export async function getCachedLiveChannels(key: string): Promise<LiveChannels | null> {
  const hit = cache.get(key);
  const config = await getConfig();
  const info = config.LiveConfig.find((l) => l.key === key);
  if (!info || info.disabled) return null;

  if (hit) {
    if (Date.now() - hit.fetchedAt > CHANNEL_TTL_MS) {
      refreshLiveChannels(info)
        .then((n) => (n !== info.channelNumber ? saveChannelCounts({ [key]: n }) : undefined))
        .catch((e) => logger.error(`后台刷新直播源失败 [${key}]:`, e.message));
    }
    return hit;
  }

  try {
    const n = await refreshLiveChannels(info);
    if (n !== info.channelNumber) await saveChannelCounts({ [key]: n });
  } catch (error) {
    logger.error(`加载直播源失败 [${key}]:`, (error as Error).message);
    return null;
  }
  return cache.get(key) || null;
}

// 判断地址是否属于某直播源的频道列表（频道地址 / 台标），用于限制代理只能访问已配置的内容
export async function isKnownChannelUrl(sourceKey: string, url: string): Promise<boolean> {
  return !!(await getCachedLiveChannels(sourceKey))?.urlSet.has(url);
}

export async function isKnownChannelLogo(sourceKey: string, url: string): Promise<boolean> {
  return !!(await getCachedLiveChannels(sourceKey))?.logoSet.has(url);
}

// ---------------- M3U 解析 ----------------

function attr(line: string, name: string): string {
  const m = line.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : '';
}

export function parseM3U(
  sourceKey: string,
  m3uContent: string
): { tvgUrls: string[]; channels: LiveChannel[] } {
  const channels: LiveChannel[] = [];
  const tvgUrls: string[] = [];
  const text = m3uContent.charCodeAt(0) === 0xfeff ? m3uContent.slice(1) : m3uContent;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXTM3U')) {
      // 支持 x-tvg-url / url-tvg，值可能是逗号分隔的多个地址
      const v = attr(line, 'x-tvg-url') || attr(line, 'url-tvg');
      tvgUrls.push(...splitEpgUrls(v));
      continue;
    }

    if (!line.startsWith('#EXTINF:')) continue;

    // 下一行（跳过 #EXTVLCOPT 等附加行）是地址
    let j = i + 1;
    while (j < lines.length && lines[j].startsWith('#') && !lines[j].startsWith('#EXTINF:')) j++;
    if (j >= lines.length || lines[j].startsWith('#')) continue;
    const url = lines[j];
    i = j;

    const title = extinfTitle(line);
    const tvgName = attr(line, 'tvg-name');
    const name = title || tvgName;
    if (!name || !url) continue;

    channels.push({
      id: `${sourceKey}-${channels.length}`,
      tvgId: attr(line, 'tvg-id'),
      tvgName,
      name,
      logo: attr(line, 'tvg-logo'),
      group: attr(line, 'group-title') || '无分组',
      url,
    });
  }

  return { tvgUrls, channels };
}

// 标题是第一个不在引号内的逗号之后的全部内容（标题本身可以含逗号）
function extinfTitle(line: string): string {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ',' && !inQuote) return line.slice(i + 1).trim();
  }
  return '';
}

function splitEpgUrls(v: string): string[] {
  return v
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

// ---------------- 节目单 ----------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** 频道名归一化，用于节目单按名称匹配 */
export function normalizeChannelName(name: string): string {
  return name
    .normalize('NFKC')
    .toUpperCase()
    .replace(/\[[^\]]*\]|\([^)]*\)|（[^）]*）|【[^】]*】/g, '')
    .replace(/线路\s*\d+/g, '')
    // 长的写在前面，避免 HD 先匹配掉 HDR10 的前半段
    .replace(/(HDR10|HDR|HLG|超高清|高清|超清|标清|蓝光|FHD|UHD|HD|4K|8K|1080[PI]?|720P)/g, '')
    .replace(/[\s\-_·|]+/g, '');
}

/** XMLTV 时间 "20261024163000 +0800" → 毫秒 */
export function parseXmltvTime(t: string): number {
  const m = t.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s = '00', tz = '+0000'] = m;
  const sign = tz[0] === '-' ? -1 : 1;
  const offset = sign * (parseInt(tz.slice(1, 3), 10) * 60 + parseInt(tz.slice(3), 10));
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - offset * 60 * 1000;
}

/**
 * 流式解析 XMLTV：按完整的 <channel>/<programme> 元素切分，
 * 不依赖换行（压缩成一行的 XML 也能解析），支持 gzip。
 */
export async function parseXmltvStream(
  stream: ReadableStream<Uint8Array>,
  wantedIds: Set<string> | null,
  onChannel: (id: string, names: string[]) => void,
  onProgramme: (channelId: string, p: EpgProgram) => void,
  now = Date.now()
): Promise<void> {
  // TS 的 DOM 类型把 TextDecoderStream 的写入端声明得过窄，运行时接受 Uint8Array
  const reader = stream
    .pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>)
    .getReader();
  let buf = '';
  const minEnd = now - EPG_KEEP_BEFORE_MS;
  const maxStart = now + EPG_KEEP_AFTER_MS;

  const drain = (final: boolean) => {
    for (;;) {
      const cIdx = buf.indexOf('<channel');
      const pIdx = buf.indexOf('<programme');
      const idx = cIdx === -1 ? pIdx : pIdx === -1 ? cIdx : Math.min(cIdx, pIdx);
      if (idx === -1) {
        // 保留末尾可能被截断的标签开头
        if (!final) buf = buf.slice(Math.max(0, buf.length - 16));
        return;
      }
      const isChannel = idx === cIdx;
      const closeTag = isChannel ? '</channel>' : '</programme>';
      const end = buf.indexOf(closeTag, idx);
      const selfClose = buf.indexOf('/>', idx);
      const openEnd = buf.indexOf('>', idx);
      let elementEnd: number;
      if (openEnd !== -1 && selfClose !== -1 && selfClose + 1 === openEnd) {
        elementEnd = openEnd + 1; // <programme ... />
      } else if (end !== -1) {
        elementEnd = end + closeTag.length;
      } else {
        buf = buf.slice(idx);
        return;
      }
      const el = buf.slice(idx, elementEnd);
      buf = buf.slice(elementEnd);

      if (isChannel) {
        const id = decodeXmlEntities(attr(el, 'id'));
        const names = Array.from(el.matchAll(/<display-name[^>]*>([\s\S]*?)<\/display-name>/g)).map((m) =>
          decodeXmlEntities(m[1].trim())
        );
        if (id) onChannel(id, names);
      } else {
        const channel = decodeXmlEntities(attr(el, 'channel'));
        if (wantedIds && !wantedIds.has(channel)) continue;
        const start = attr(el, 'start');
        const stop = attr(el, 'stop');
        const s = parseXmltvTime(start);
        const e = parseXmltvTime(stop);
        if (!Number.isFinite(s) || !Number.isFinite(e) || e < minEnd || s > maxStart) continue;
        const title = el.match(/<title[^>]*>([\s\S]*?)<\/title>/);
        onProgramme(channel, {
          start,
          end: stop,
          title: title ? decodeXmlEntities(title[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim()) : '',
        });
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    drain(false);
  }
  drain(true);
}

async function fetchEpgStream(url: string, ua: string): Promise<ReadableStream<Uint8Array> | null> {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': ua } }, 60000);
  if (!res.ok || !res.body) {
    res.body?.cancel().catch(() => undefined);
    return null;
  }
  const gz =
    /\.gz($|\?)/i.test(url) ||
    /gzip/i.test(res.headers.get('content-type') || '');
  // fetch 已自动处理 Content-Encoding；这里只处理「文件本身是 .gz」的情况
  return gz && !res.headers.get('content-encoding')
    ? res.body.pipeThrough(new DecompressionStream('gzip'))
    : res.body;
}

/**
 * 读取一个或多个 XMLTV 节目单，按频道建立索引。
 * 匹配顺序：tvg-id → tvg-name → 频道名（均先精确匹配节目单的 channel id，再按 display-name 归一化匹配）。
 */
async function buildEpgIndex(
  urls: string[],
  ua: string,
  channels: LiveChannel[]
): Promise<{ [key: string]: EpgProgram[] }> {
  const programs = new Map<string, EpgProgram[]>();
  const nameToId = new Map<string, string>();
  const knownIds = new Set<string>();

  for (const url of urls) {
    try {
      const stream = await fetchEpgStream(url, ua);
      if (!stream) continue;
      await parseXmltvStream(
        stream,
        null,
        (id, names) => {
          knownIds.add(id);
          for (const n of [id, ...names]) {
            const k = normalizeChannelName(n);
            if (k && !nameToId.has(k)) nameToId.set(k, id);
          }
        },
        (channelId, p) => {
          // 多个节目单都有同一频道时，以先出现的节目单为准
          const list = programs.get(channelId) || [];
          list.push(p);
          programs.set(channelId, list);
        }
      );
    } catch (error) {
      logger.warn(`节目单解析失败 ${url}:`, (error as Error).message);
    }
  }

  const result: { [key: string]: EpgProgram[] } = {};
  for (const c of channels) {
    const key = c.tvgId || c.name;
    if (result[key]) continue;
    const candidates = [c.tvgId, c.tvgName, c.name].filter(Boolean);
    let id = candidates.find((x) => knownIds.has(x) || programs.has(x));
    if (!id) {
      for (const x of candidates) {
        id = nameToId.get(normalizeChannelName(x));
        if (id) break;
      }
    }
    const list = id ? programs.get(id) : undefined;
    if (list && list.length) {
      result[key] = list.sort((a, b) => a.start.localeCompare(b.start));
    }
  }
  return result;
}
