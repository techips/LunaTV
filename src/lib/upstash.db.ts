import { Redis } from '@upstash/redis';

import { globalSingleton } from './global-singleton';
import { KvClient, KvStorage, withRetry } from './kv-storage';
import { logger } from './logger';

/**
 * Upstash 适配器。
 * 关闭 SDK 的自动反序列化，统一以字符串读写；SDK 写入字符串时本来就原样存储，
 * 写入对象时存的是 JSON 字符串，因此与旧版数据格式完全兼容。
 */
export class UpstashKv implements KvClient {
  private retry = withRetry('Upstash Redis');

  constructor(private client: Redis) {}

  private str(v: unknown): string | null {
    return v === null || v === undefined ? null : String(v);
  }

  async get(key: string) {
    return this.str(await this.retry(() => this.client.get(key)));
  }
  async set(key: string, value: string) {
    await this.retry(() => this.client.set(key, value));
  }
  async del(keys: string | string[]) {
    const list = Array.isArray(keys) ? keys : [keys];
    if (list.length === 0) return;
    await this.retry(() => this.client.del(...list));
  }
  async exists(key: string) {
    return (await this.retry(() => this.client.exists(key))) === 1;
  }
  async incr(key: string) {
    return this.retry(() => this.client.incr(key));
  }
  async hGet(key: string, field: string) {
    return this.str(await this.retry(() => this.client.hget(key, field)));
  }
  async hSet(key: string, field: string, value: string) {
    await this.retry(() => this.client.hset(key, { [field]: value }));
  }
  async hGetAll(key: string) {
    const raw: unknown = await this.retry(() => this.client.hgetall(key));
    const out: Record<string, string> = {};
    if (!raw) return out;
    // 关闭自动反序列化后返回扁平数组 [field, value, ...]
    if (Array.isArray(raw)) {
      for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i])] = String(raw[i + 1]);
      return out;
    }
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return out;
  }
  async hDel(key: string, field: string) {
    await this.retry(() => this.client.hdel(key, field));
  }
  async sAdd(key: string, members: string | string[]) {
    const list = Array.isArray(members) ? members : [members];
    if (list.length === 0) return;
    await this.retry(() => this.client.sadd(key, list[0], ...list.slice(1)));
  }
  async sRem(key: string, member: string) {
    await this.retry(() => this.client.srem(key, member));
  }
  async sMembers(key: string) {
    return ((await this.retry(() => this.client.smembers(key))) || []).map(String);
  }
  async lRange(key: string, start: number, stop: number) {
    return ((await this.retry(() => this.client.lrange(key, start, stop))) || []).map(String);
  }
  async lRem(key: string, count: number, value: string) {
    await this.retry(() => this.client.lrem(key, count, value));
  }
  async lPush(key: string, value: string) {
    await this.retry(() => this.client.lpush(key, value));
  }
  async lTrim(key: string, start: number, stop: number) {
    await this.retry(() => this.client.ltrim(key, start, stop));
  }
  async scanKeys(pattern: string) {
    const keys: string[] = [];
    let cursor: string | number = 0;
    do {
      const [next, batch]: [string | number, string[]] = await this.retry(() =>
        this.client.scan(cursor, { match: pattern, count: 500 })
      );
      keys.push(...batch.map(String));
      cursor = next;
    } while (String(cursor) !== '0');
    return keys;
  }
  async eval(script: string, keys: string[], args: string[]) {
    return this.retry(() => this.client.eval(script, keys, args));
  }
}

export class UpstashRedisStorage extends KvStorage {
  constructor() {
    super(new UpstashKv(getUpstashRedisClient()));
  }
}

// 单例 Upstash Redis 客户端
function getUpstashRedisClient(): Redis {
  return globalSingleton(Symbol.for('__MOONTV_UPSTASH_REDIS_CLIENT__'), () => {
    const upstashUrl = process.env.UPSTASH_URL;
    const upstashToken = process.env.UPSTASH_TOKEN;
    if (!upstashUrl || !upstashToken) {
      throw new Error('UPSTASH_URL and UPSTASH_TOKEN env variables must be set');
    }
    logger.info('Upstash Redis client created');
    return new Redis({
      url: upstashUrl,
      token: upstashToken,
      automaticDeserialization: false,
      retry: {
        retries: 3,
        backoff: (retryCount: number) => Math.min(1000 * Math.pow(2, retryCount), 30000),
      },
    });
  });
}
