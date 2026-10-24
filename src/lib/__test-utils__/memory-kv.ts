import { KvClient } from '@/lib/kv-storage';

/** 测试用的内存 KvClient，语义与 Redis 一致（只实现用到的命令） */
export class MemoryKv implements KvClient {
  strings = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  sets = new Map<string, Set<string>>();
  lists = new Map<string, string[]>();

  async get(key: string) {
    return this.strings.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.strings.set(key, value);
  }
  async del(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      this.strings.delete(k);
      this.hashes.delete(k);
      this.sets.delete(k);
      this.lists.delete(k);
    }
  }
  async exists(key: string) {
    return this.strings.has(key) || this.hashes.has(key) || this.sets.has(key) || this.lists.has(key);
  }
  async incr(key: string) {
    const v = (Number(this.strings.get(key)) || 0) + 1;
    this.strings.set(key, String(v));
    return v;
  }
  async hGet(key: string, field: string) {
    return this.hashes.get(key)?.get(field) ?? null;
  }
  async hSet(key: string, field: string, value: string) {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    this.hashes.get(key)?.set(field, value);
  }
  async hGetAll(key: string) {
    return Object.fromEntries(this.hashes.get(key) || []);
  }
  async hDel(key: string, field: string) {
    this.hashes.get(key)?.delete(field);
  }
  async sAdd(key: string, members: string | string[]) {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    for (const m of Array.isArray(members) ? members : [members]) this.sets.get(key)?.add(m);
  }
  async sRem(key: string, member: string) {
    this.sets.get(key)?.delete(member);
  }
  async sMembers(key: string) {
    return Array.from(this.sets.get(key) || []);
  }
  async lRange(key: string, start: number, stop: number) {
    const l = this.lists.get(key) || [];
    return l.slice(start, stop === -1 ? undefined : stop + 1);
  }
  async lRem(key: string, _count: number, value: string) {
    this.lists.set(key, (this.lists.get(key) || []).filter((v) => v !== value));
  }
  async lPush(key: string, value: string) {
    this.lists.set(key, [value, ...(this.lists.get(key) || [])]);
  }
  async lTrim(key: string, start: number, stop: number) {
    this.lists.set(key, (this.lists.get(key) || []).slice(start, stop + 1));
  }
  async scanKeys(pattern: string) {
    const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    const all = [
      ...Array.from(this.strings.keys()),
      ...Array.from(this.hashes.keys()),
      ...Array.from(this.sets.keys()),
      ...Array.from(this.lists.keys()),
    ];
    return all.filter((k) => re.test(k));
  }
  /** 只实现配置乐观锁脚本的语义 */
  async eval(_script: string, keys: string[], args: string[]) {
    const cur = this.strings.get(keys[1]);
    if ((cur === undefined && args[0] === '0') || cur === args[0]) {
      this.strings.set(keys[0], args[1]);
      return this.incr(keys[1]);
    }
    return -1;
  }
}
