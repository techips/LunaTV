/* eslint-disable no-console */

/**
 * 服务端日志：按 LOG_LEVEL（debug / info / warn / error，默认 info）过滤，
 * 每行带时间与级别，方便在 docker logs 中检索。
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel(): number {
  const v = (process.env.LOG_LEVEL || 'info').toLowerCase() as Level;
  return ORDER[v] ?? ORDER.info;
}

function emit(level: Level, args: unknown[]) {
  if (ORDER[level] < minLevel()) return;
  const prefix = `${new Date().toISOString()} [${level.toUpperCase()}]`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(prefix, ...args);
}

export const logger = {
  debug: (...args: unknown[]) => emit('debug', args),
  info: (...args: unknown[]) => emit('info', args),
  warn: (...args: unknown[]) => emit('warn', args),
  error: (...args: unknown[]) => emit('error', args),
};
