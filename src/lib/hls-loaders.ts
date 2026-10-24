/**
 * 播放页 / 直播页使用的 hls.js 自定义加载器。
 * 从页面组件中拆出，便于单独测试和复用。
 */

import type Hls from 'hls.js';
import type {
  HlsConfig,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderResponse,
  LoaderStats,
} from 'hls.js';

type HlsClass = typeof Hls;
type LoaderClass = HlsClass['DefaultConfig']['loader'];
// manifest / level 请求的上下文带有 type 字段（PlaylistLoaderContext）
type TypedContext = LoaderContext & { type?: string };

/** 去广告：移除 #EXT-X-DISCONTINUITY 标记（点播源常用它拼接广告片段） */
export function filterAdsFromM3U8(m3u8Content: string): string {
  if (!m3u8Content) return '';
  return m3u8Content
    .split('\n')
    .filter((line) => !line.includes('#EXT-X-DISCONTINUITY'))
    .join('\n');
}

function isPlaylistRequest(context: TypedContext): boolean {
  return context.type === 'manifest' || context.type === 'level';
}

/** 点播加载器：对 manifest / level 播放列表应用去广告过滤 */
export function createAdFilterLoader(HlsImpl: HlsClass): LoaderClass {
  const Base = HlsImpl.DefaultConfig.loader;
  return class AdFilterLoader extends Base {
    constructor(config: HlsConfig) {
      super(config);
      const load = this.load.bind(this);
      this.load = (
        context: TypedContext,
        cfg: LoaderConfiguration,
        callbacks: LoaderCallbacks<LoaderContext>
      ) => {
        if (isPlaylistRequest(context)) {
          const onSuccess = callbacks.onSuccess;
          callbacks.onSuccess = (
            response: LoaderResponse,
            stats: LoaderStats,
            ctx: LoaderContext,
            networkDetails: unknown
          ) => {
            if (typeof response.data === 'string') {
              response.data = filterAdsFromM3U8(response.data);
            }
            return onSuccess(response, stats, ctx, networkDetails);
          };
        }
        load(context, cfg, callbacks);
      };
    }
  };
}

/**
 * 直播加载器：所有请求附带当前直播源 key；开启「浏览器直连」时让播放列表接口保留原始分片地址。
 * @param getSourceKey 返回当前直播源 key（通常读取 ref，保证切换频道后取到最新值）
 */
export function createLiveLoader(HlsImpl: HlsClass, getSourceKey: () => string): LoaderClass {
  const Base = HlsImpl.DefaultConfig.loader;
  return class LiveLoader extends Base {
    constructor(config: HlsConfig) {
      super(config);
      const load = this.load.bind(this);
      this.load = (
        context: TypedContext,
        cfg: LoaderConfiguration,
        callbacks: LoaderCallbacks<LoaderContext>
      ) => {
        try {
          // 代理返回的播放列表使用站内相对地址，这里补上 origin 再解析
          const url = new URL(context.url, window.location.origin);
          url.searchParams.set('moontv-source', getSourceKey());
          if (isPlaylistRequest(context) && readLocalFlag('liveDirectConnect')) {
            url.searchParams.set('allowCORS', 'true');
          }
          context.url = url.toString();
        } catch {
          // 非法地址交给 hls.js 自己报错
        }
        load(context, cfg, callbacks);
      };
    }
  };
}

function readLocalFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}
