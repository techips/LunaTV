// 服务端注入到 window.RUNTIME_CONFIG 的运行时配置（见 src/app/layout.tsx）
interface RuntimeConfig {
  STORAGE_TYPE?: string;
  DOUBAN_PROXY_TYPE?: string;
  DOUBAN_PROXY?: string;
  DOUBAN_IMAGE_PROXY_TYPE?: string;
  DOUBAN_IMAGE_PROXY?: string;
  DISABLE_YELLOW_FILTER?: boolean;
  CUSTOM_CATEGORIES?: { name: string; type: 'movie' | 'tv'; query: string }[];
  FLUID_SEARCH?: boolean;
  ENABLE_WEB_LIVE?: boolean;
}

interface Window {
  RUNTIME_CONFIG?: RuntimeConfig;
}
