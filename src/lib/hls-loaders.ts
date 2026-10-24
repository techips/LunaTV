/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 播放页 / 直播页使用的 hls.js 自定义加载器。
 * 从页面组件中拆出，便于单独测试和复用。
 */

import type Hls from 'hls.js';

type HlsClass = typeof Hls;
type LoaderClass = HlsClass['DefaultConfig']['loader'];

/** 去广告：移除 #EXT-X-DISCONTINUITY 标记（点播源常用它拼接广告片段） */
export function filterAdsFromM3U8(m3u8Content: string): string {
  if (!m3u8Content) return '';
  return m3u8Content
    .split('\n')
    .filter((line) => !line.includes('#EXT-X-DISCONTINUITY'))
    .join('\n');
}

/** 点播加载器：对 manifest / level 播放列表应用去广告过滤 */
export function createAdFilterLoader(HlsImpl: HlsClass): LoaderClass {
  const AdFilterLoader = class extends (HlsImpl.DefaultConfig.loader as any) {
    constructor(config: any) {
      super(config);
      const load = this.load.bind(this);
      this.load = function (context: any, cfg: any, callbacks: any) {
        if (context.type === 'manifest' || context.type === 'level') {
          const onSuccess = callbacks.onSuccess;
          callbacks.onSuccess = function (response: any, stats: any, ctx: any) {
            if (response.data && typeof response.data === 'string') {
              response.data = filterAdsFromM3U8(response.data);
            }
            return onSuccess(response, stats, ctx, null);
          };
        }
        load(context, cfg, callbacks);
      };
    }
  };
  return AdFilterLoader as unknown as LoaderClass;
}

/**
 * 直播加载器：所有请求附带当前直播源 key；开启「浏览器直连」时让播放列表接口保留原始分片地址。
 * @param getSourceKey 返回当前直播源 key（通常读取 ref，保证切换频道后取到最新值）
 */
export function createLiveLoader(HlsImpl: HlsClass, getSourceKey: () => string): LoaderClass {
  const LiveLoader = class extends (HlsImpl.DefaultConfig.loader as any) {
    constructor(config: any) {
      super(config);
      const load = this.load.bind(this);
      this.load = function (context: any, cfg: any, callbacks: any) {
        try {
          // 代理返回的播放列表使用站内相对地址，这里补上 origin 再解析
          const url = new URL(context.url, window.location.origin);
          url.searchParams.set('moontv-source', getSourceKey());
          if (
            (context.type === 'manifest' || context.type === 'level') &&
            readLocalFlag('liveDirectConnect')
          ) {
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
  return LiveLoader as unknown as LoaderClass;
}

function readLocalFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}
