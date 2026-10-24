/* eslint-disable no-console, @typescript-eslint/no-explicit-any */

import { AdminConfig } from './admin.types';
import { hashPassword, isHashed, verifyPassword } from './password';
import { Favorite, IStorage, PlayRecord, SkipConfig } from './types';

// 搜索历史最大条数
const SEARCH_HISTORY_LIMIT = 20;

/**
 * 最小 KV 客户端接口。Redis / Kvrocks（node-redis）与 Upstash 各实现一个适配器，
 * 所有业务逻辑只写一份（KvStorage）。所有值都以字符串读写，结构化数据统一 JSON 序列化，
 * 与旧版两套实现写入的格式完全一致。
 */
export interface KvClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(keys: string | string[]): Promise<void>;
  exists(key: string): Promise<boolean>;
  incr(key: string): Promise<number>;
  hGet(key: string, field: string): Promise<string | null>;
  hSet(key: string, field: string, value: string): Promise<void>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hDel(key: string, field: string): Promise<void>;
  sAdd(key: string, members: string | string[]): Promise<void>;
  sRem(key: string, member: string): Promise<void>;
  sMembers(key: string): Promise<string[]>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  lRem(key: string, count: number, value: string): Promise<void>;
  lPush(key: string, value: string): Promise<void>;
  lTrim(key: string, start: number, stop: number): Promise<void>;
  /** 用 SCAN 遍历匹配的 key，避免 KEYS 阻塞服务端 */
  scanKeys(pattern: string): Promise<string[]>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

/** 通用重试包装：只对连接类错误重试 */
export function withRetry(clientName: string, onRetry?: () => Promise<void>) {
  return async function retry<T>(operation: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await operation();
      } catch (err: any) {
        const isLastAttempt = i === maxRetries - 1;
        const isConnectionError =
          err?.message?.includes('Connection') ||
          err?.message?.includes('ECONNREFUSED') ||
          err?.message?.includes('ENOTFOUND') ||
          err?.code === 'ECONNRESET' ||
          err?.code === 'EPIPE' ||
          err?.name === 'UpstashError';
        if (!isConnectionError || isLastAttempt) throw err;
        console.warn(`${clientName} 操作失败，重试 (${i + 1}/${maxRetries}):`, err.message);
        await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
        if (onRetry) {
          await onRetry().catch((e) => console.error(`${clientName} 重连失败:`, e));
        }
      }
    }
    throw new Error('Max retries exceeded');
  };
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseJsonMap<T>(all: Record<string, string>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [field, raw] of Object.entries(all || {})) {
    const v = parseJson<T>(raw);
    if (v) out[field] = v;
  }
  return out;
}

// 配置的乐观锁：只有版本号未变时才写入，返回新版本号；否则返回 -1
const CAS_CONFIG_SCRIPT = `
local cur = redis.call('GET', KEYS[2])
if (cur == false and ARGV[1] == '0') or cur == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return redis.call('INCR', KEYS[2])
end
return -1
`;

export class KvStorage implements IStorage {
  constructor(protected kv: KvClient) {}

  // ---------- key 规则（与历史版本保持一致） ----------
  private prHashKey(user: string) {
    return `u:${user}:pr`;
  }
  private favHashKey(user: string) {
    return `u:${user}:fav`;
  }
  private skipHashKey(user: string) {
    return `u:${user}:skip`;
  }
  private skipField(source: string, id: string) {
    return `${source}+${id}`;
  }
  private userPwdKey(user: string) {
    return `u:${user}:pwd`;
  }
  private sessionVersionKey(user: string) {
    return `u:${user}:sv`;
  }
  private shKey(user: string) {
    return `u:${user}:sh`;
  }
  private usersSetKey() {
    return 'sys:users';
  }
  private adminConfigKey() {
    return 'admin:config';
  }
  private adminConfigVersionKey() {
    return 'admin:config:ver';
  }

  // ---------- 播放记录 ----------
  async getPlayRecord(userName: string, key: string): Promise<PlayRecord | null> {
    return parseJson<PlayRecord>(await this.kv.hGet(this.prHashKey(userName), key));
  }

  async setPlayRecord(userName: string, key: string, record: PlayRecord): Promise<void> {
    await this.kv.hSet(this.prHashKey(userName), key, JSON.stringify(record));
  }

  async getAllPlayRecords(userName: string): Promise<Record<string, PlayRecord>> {
    return parseJsonMap<PlayRecord>(await this.kv.hGetAll(this.prHashKey(userName)));
  }

  async deletePlayRecord(userName: string, key: string): Promise<void> {
    await this.kv.hDel(this.prHashKey(userName), key);
  }

  async deleteAllPlayRecords(userName: string): Promise<void> {
    await this.kv.del(this.prHashKey(userName));
  }

  // ---------- 收藏 ----------
  async getFavorite(userName: string, key: string): Promise<Favorite | null> {
    return parseJson<Favorite>(await this.kv.hGet(this.favHashKey(userName), key));
  }

  async setFavorite(userName: string, key: string, favorite: Favorite): Promise<void> {
    await this.kv.hSet(this.favHashKey(userName), key, JSON.stringify(favorite));
  }

  async getAllFavorites(userName: string): Promise<Record<string, Favorite>> {
    return parseJsonMap<Favorite>(await this.kv.hGetAll(this.favHashKey(userName)));
  }

  async deleteFavorite(userName: string, key: string): Promise<void> {
    await this.kv.hDel(this.favHashKey(userName), key);
  }

  async deleteAllFavorites(userName: string): Promise<void> {
    await this.kv.del(this.favHashKey(userName));
  }

  // ---------- 用户 ----------
  async registerUser(userName: string, password: string): Promise<void> {
    await this.setPasswordHash(userName, hashPassword(password));
  }

  async verifyUser(userName: string, password: string): Promise<boolean> {
    const stored = await this.kv.get(this.userPwdKey(userName));
    if (stored === null) return false;
    const ok = verifyPassword(password, stored);
    // 平滑迁移：明文密码验证通过后自动升级为加盐哈希
    if (ok && !isHashed(stored)) {
      await this.kv.set(this.userPwdKey(userName), hashPassword(password));
    }
    return ok;
  }

  async checkUserExist(userName: string): Promise<boolean> {
    return this.kv.exists(this.userPwdKey(userName));
  }

  async changePassword(userName: string, newPassword: string): Promise<void> {
    await this.kv.set(this.userPwdKey(userName), hashPassword(newPassword));
  }

  /** 读取存储中的密码值（加盐哈希，旧数据可能是明文），仅用于备份导出 */
  async getPasswordHash(userName: string): Promise<string | null> {
    return this.kv.get(this.userPwdKey(userName));
  }

  /** 原样写入密码值（不再哈希），用于备份导入 */
  async setPasswordHash(userName: string, stored: string): Promise<void> {
    await this.kv.set(this.userPwdKey(userName), stored);
    await this.kv.sAdd(this.usersSetKey(), userName);
  }

  async getSessionVersion(userName: string): Promise<number> {
    return Number(await this.kv.get(this.sessionVersionKey(userName))) || 0;
  }

  async bumpSessionVersion(userName: string): Promise<number> {
    return this.kv.incr(this.sessionVersionKey(userName));
  }

  async deleteUser(userName: string): Promise<void> {
    await this.kv.del([
      this.userPwdKey(userName),
      this.shKey(userName),
      this.prHashKey(userName),
      this.favHashKey(userName),
      this.skipHashKey(userName),
    ]);
    await this.kv.sRem(this.usersSetKey(), userName);
    // 不删除会话版本号，而是递增：已签发的 cookie 立即失效，即使同名用户被重新创建
    await this.bumpSessionVersion(userName);
  }

  // ---------- 搜索历史 ----------
  async getSearchHistory(userName: string): Promise<string[]> {
    return this.kv.lRange(this.shKey(userName), 0, -1);
  }

  async addSearchHistory(userName: string, keyword: string): Promise<void> {
    const key = this.shKey(userName);
    await this.kv.lRem(key, 0, keyword);
    await this.kv.lPush(key, keyword);
    await this.kv.lTrim(key, 0, SEARCH_HISTORY_LIMIT - 1);
  }

  async deleteSearchHistory(userName: string, keyword?: string): Promise<void> {
    const key = this.shKey(userName);
    if (keyword) {
      await this.kv.lRem(key, 0, keyword);
    } else {
      await this.kv.del(key);
    }
  }

  async getAllUsers(): Promise<string[]> {
    return this.kv.sMembers(this.usersSetKey());
  }

  // ---------- 管理员配置 ----------
  async getAdminConfig(): Promise<AdminConfig | null> {
    return parseJson<AdminConfig>(await this.kv.get(this.adminConfigKey()));
  }

  async setAdminConfig(config: AdminConfig): Promise<void> {
    await this.kv.set(this.adminConfigKey(), JSON.stringify(config));
    await this.kv.incr(this.adminConfigVersionKey());
  }

  /** 读取配置及其版本号，配合 casAdminConfig 实现乐观锁 */
  async getAdminConfigWithVersion(): Promise<{ config: AdminConfig | null; version: number }> {
    const [raw, ver] = await Promise.all([
      this.kv.get(this.adminConfigKey()),
      this.kv.get(this.adminConfigVersionKey()),
    ]);
    return { config: parseJson<AdminConfig>(raw), version: Number(ver) || 0 };
  }

  /** 版本号未变化时写入并返回新版本号；被其他写入抢先时返回 null */
  async casAdminConfig(config: AdminConfig, expectedVersion: number): Promise<number | null> {
    const res = Number(
      await this.kv.eval(
        CAS_CONFIG_SCRIPT,
        [this.adminConfigKey(), this.adminConfigVersionKey()],
        [String(expectedVersion), JSON.stringify(config)]
      )
    );
    return res > 0 ? res : null;
  }

  // ---------- 托管直播播放列表 ----------
  private hostedPlaylistKey(key: string) {
    return `live:hosted:${key}`;
  }

  async getHostedPlaylist(key: string): Promise<string | null> {
    return this.kv.get(this.hostedPlaylistKey(key));
  }

  async setHostedPlaylist(key: string, content: string): Promise<void> {
    await this.kv.set(this.hostedPlaylistKey(key), content);
  }

  async deleteHostedPlaylist(key: string): Promise<void> {
    await this.kv.del(this.hostedPlaylistKey(key));
  }

  // ---------- 跳过片头片尾 ----------
  async getSkipConfig(userName: string, source: string, id: string): Promise<SkipConfig | null> {
    return parseJson<SkipConfig>(
      await this.kv.hGet(this.skipHashKey(userName), this.skipField(source, id))
    );
  }

  async setSkipConfig(
    userName: string,
    source: string,
    id: string,
    config: SkipConfig
  ): Promise<void> {
    await this.kv.hSet(
      this.skipHashKey(userName),
      this.skipField(source, id),
      JSON.stringify(config)
    );
  }

  async deleteSkipConfig(userName: string, source: string, id: string): Promise<void> {
    await this.kv.hDel(this.skipHashKey(userName), this.skipField(source, id));
  }

  async getAllSkipConfigs(userName: string): Promise<{ [key: string]: SkipConfig }> {
    return parseJsonMap<SkipConfig>(await this.kv.hGetAll(this.skipHashKey(userName)));
  }

  // ---------- 数据迁移：旧扁平 key → Hash 结构 ----------
  async migrateData(): Promise<void> {
    const migrationKey = 'sys:migration:hash_v2';
    if ((await this.kv.get(migrationKey)) === 'done') return;
    console.log('开始数据迁移：扁平 key → Hash 结构...');
    try {
      const kinds: [string, (u: string) => string][] = [
        ['pr', (u) => this.prHashKey(u)],
        ['fav', (u) => this.favHashKey(u)],
        ['skip', (u) => this.skipHashKey(u)],
      ];
      for (const [kind, hashKey] of kinds) {
        const keys = (await this.kv.scanKeys(`u:*:${kind}:*`)).filter((k) => {
          const parts = k.split(':');
          return parts.length >= 4 && parts[2] === kind && parts[3] !== '';
        });
        for (const oldKey of keys) {
          const match = oldKey.match(new RegExp(`^u:(.+?):${kind}:(.+)$`));
          if (!match) continue;
          const raw = await this.kv.get(oldKey);
          if (raw) await this.kv.hSet(hashKey(match[1]), match[2], raw);
          await this.kv.del(oldKey);
        }
        if (keys.length > 0) console.log(`迁移了 ${keys.length} 条 ${kind} 数据`);
      }

      // 从 u:*:pwd 构建 sys:users 集合
      if (!(await this.kv.exists(this.usersSetKey()))) {
        const userNames = (await this.kv.scanKeys('u:*:pwd'))
          .map((k) => k.match(/^u:(.+?):pwd$/)?.[1])
          .filter((u): u is string => typeof u === 'string');
        if (userNames.length > 0) {
          await this.kv.sAdd(this.usersSetKey(), userNames);
          console.log(`迁移了 ${userNames.length} 个用户到 Set`);
        }
      }

      await this.kv.set(migrationKey, 'done');
      console.log('数据迁移完成');
    } catch (error) {
      console.error('数据迁移失败:', error);
    }
  }

  // ---------- 密码迁移：明文 → 加盐哈希 ----------
  async migratePasswords(): Promise<void> {
    const migrationKey = 'sys:migration:pwd_hash_v1';
    if ((await this.kv.get(migrationKey)) === 'done') return;
    console.log('开始密码迁移：明文 → 加盐哈希...');
    try {
      let count = 0;
      for (const key of await this.kv.scanKeys('u:*:pwd')) {
        const stored = await this.kv.get(key);
        if (stored === null || isHashed(stored)) continue;
        await this.kv.set(key, hashPassword(stored));
        count++;
      }
      await this.kv.set(migrationKey, 'done');
      console.log(`密码迁移完成，共迁移 ${count} 个用户`);
    } catch (error) {
      console.error('密码迁移失败:', error);
    }
  }

  async clearAllData(): Promise<void> {
    try {
      for (const username of await this.getAllUsers()) {
        await this.deleteUser(username);
      }
      await this.kv.del(this.adminConfigKey());
      console.log('所有数据已清空');
    } catch (error) {
      console.error('清空数据失败:', error);
      throw new Error('清空数据失败');
    }
  }
}
