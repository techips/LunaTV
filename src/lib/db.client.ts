/* eslint-disable no-console, @typescript-eslint/no-empty-function */
'use client';

/**
 * 浏览器端数据工具（播放记录、收藏、搜索历史、跳过配置及混合缓存）。
 * 具体实现按领域拆分在 ./db-client/ 目录下，这里统一导出，保持原有导入路径不变。
 */
export * from './db-client/cache';
export type { Favorite, PlayRecord } from './db-client/core';
export { generateStorageKey } from './db-client/core';
export * from './db-client/favorites';
export * from './db-client/playRecords';
export * from './db-client/searchHistory';
export * from './db-client/skipConfigs';
