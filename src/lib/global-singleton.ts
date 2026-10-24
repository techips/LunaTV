/**
 * 进程级单例：开发模式热更新会重复执行模块，用 globalThis 保存连接等昂贵对象。
 */
export function globalSingleton<T>(key: symbol, create: () => T): T {
  const store = globalThis as unknown as Record<symbol, T | undefined>;
  let value = store[key];
  if (value === undefined) {
    value = create();
    store[key] = value;
  }
  return value;
}
