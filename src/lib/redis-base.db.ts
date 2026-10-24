/* eslint-disable no-console, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion */

import { createClient, RedisClientType } from 'redis';

import { KvClient, KvStorage, withRetry } from './kv-storage';

// 连接配置接口
export interface RedisConnectionConfig {
  url: string;
  clientName: string; // 用于日志显示，如 "Redis" 或 "Kvrocks"
}

// 创建客户端的工厂函数（进程内单例）
export function createRedisClient(config: RedisConnectionConfig, globalSymbol: symbol): RedisClientType {
  let client: RedisClientType | undefined = (global as any)[globalSymbol];

  if (!client) {
    if (!config.url) {
      throw new Error(`${config.clientName}_URL env variable not set`);
    }

    client = createClient({
      url: config.url,
      socket: {
        // 重连策略：指数退避，最大30秒
        reconnectStrategy: (retries: number) => {
          console.log(`${config.clientName} reconnection attempt ${retries + 1}`);
          if (retries > 10) {
            console.error(`${config.clientName} max reconnection attempts exceeded`);
            return false;
          }
          return Math.min(1000 * Math.pow(2, retries), 30000);
        },
        connectTimeout: 10000,
        noDelay: true,
      },
      pingInterval: 30000,
    }) as RedisClientType;

    client.on('error', (err) => {
      console.error(`${config.clientName} client error:`, err);
    });
    client.on('ready', () => {
      console.log(`${config.clientName} ready`);
    });

    const connectWithRetry = async () => {
      try {
        await client!.connect();
        console.log(`${config.clientName} connected successfully`);
      } catch (err) {
        console.error(`${config.clientName} initial connection failed:`, err);
        console.log('Will retry in 5 seconds...');
        setTimeout(connectWithRetry, 5000);
      }
    };
    connectWithRetry();

    (global as any)[globalSymbol] = client;
  }

  return client;
}

/** node-redis 适配器（Redis / Kvrocks 共用） */
export class NodeRedisKv implements KvClient {
  private retry: ReturnType<typeof withRetry>;

  constructor(private client: RedisClientType, clientName: string) {
    this.retry = withRetry(clientName, async () => {
      if (!this.client.isOpen) await this.client.connect();
    });
  }

  async get(key: string) {
    const v = await this.retry(() => this.client.get(key));
    return v === null || v === undefined ? null : String(v);
  }
  async set(key: string, value: string) {
    await this.retry(() => this.client.set(key, value));
  }
  async del(keys: string | string[]) {
    if (Array.isArray(keys) && keys.length === 0) return;
    await this.retry(() => this.client.del(keys));
  }
  async exists(key: string) {
    return (await this.retry(() => this.client.exists(key))) === 1;
  }
  async incr(key: string) {
    return this.retry(() => this.client.incr(key));
  }
  async hGet(key: string, field: string) {
    const v = await this.retry(() => this.client.hGet(key, field));
    return v === null || v === undefined ? null : String(v);
  }
  async hSet(key: string, field: string, value: string) {
    await this.retry(() => this.client.hSet(key, field, value));
  }
  async hGetAll(key: string) {
    return this.retry(() => this.client.hGetAll(key)) as Promise<Record<string, string>>;
  }
  async hDel(key: string, field: string) {
    await this.retry(() => this.client.hDel(key, field));
  }
  async sAdd(key: string, members: string | string[]) {
    await this.retry(() => this.client.sAdd(key, members));
  }
  async sRem(key: string, member: string) {
    await this.retry(() => this.client.sRem(key, member));
  }
  async sMembers(key: string) {
    return (await this.retry(() => this.client.sMembers(key))).map(String);
  }
  async lRange(key: string, start: number, stop: number) {
    return (await this.retry(() => this.client.lRange(key, start, stop))).map(String);
  }
  async lRem(key: string, count: number, value: string) {
    await this.retry(() => this.client.lRem(key, count, value));
  }
  async lPush(key: string, value: string) {
    await this.retry(() => this.client.lPush(key, value));
  }
  async lTrim(key: string, start: number, stop: number) {
    await this.retry(() => this.client.lTrim(key, start, stop));
  }
  async scanKeys(pattern: string) {
    return this.retry(async () => {
      const keys: string[] = [];
      for await (const key of this.client.scanIterator({ MATCH: pattern, COUNT: 500 })) {
        keys.push(String(key));
      }
      return keys;
    });
  }
  async eval(script: string, keys: string[], args: string[]) {
    return this.retry(() => this.client.eval(script, { keys, arguments: args }));
  }
}

/** Redis / Kvrocks 存储：业务逻辑在 KvStorage，这里只负责建立连接 */
export abstract class BaseRedisStorage extends KvStorage {
  constructor(config: RedisConnectionConfig, globalSymbol: symbol) {
    super(new NodeRedisKv(createRedisClient(config, globalSymbol), config.clientName));
  }
}
