/**
 * @jest-environment node
 */
import { KvStorage } from '@/lib/kv-storage';

import { MemoryKv } from '../__test-utils__/memory-kv';

// 用内存存储替换真实数据库
const store = new KvStorage(new MemoryKv());
jest.mock('@/lib/db', () => ({
  db: {
    getAdminConfigWithVersion: () => store.getAdminConfigWithVersion(),
    casAdminConfig: (c: never, v: number) => store.casAdminConfig(c, v),
    getAdminConfig: () => store.getAdminConfig(),
    saveAdminConfig: (c: never) => store.setAdminConfig(c),
    getAllUsers: () => store.getAllUsers(),
  },
}));

// eslint-disable-next-line simple-import-sort/imports
import { getConfig, updateConfig } from '@/lib/config';

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const bad = () => new Response(JSON.stringify({ error: 'x' }), { status: 400 });

describe('updateConfig', () => {
  beforeAll(() => {
    process.env.USERNAME = 'owner';
  });

  it('mutator 返回成功响应时写库并返回该响应', async () => {
    const res = await updateConfig((cfg) => {
      cfg.CustomCategories.push({ name: 'a', type: 'movie', query: 'qa', from: 'custom', disabled: false });
      return ok();
    });
    expect(res.status).toBe(200);
    const saved = await store.getAdminConfig();
    expect(saved?.CustomCategories.map((c) => c.query)).toContain('qa');
  });

  it('mutator 返回错误响应时不写库', async () => {
    const res = await updateConfig((cfg) => {
      cfg.CustomCategories.push({ name: 'b', type: 'movie', query: 'qb', from: 'custom', disabled: false });
      return bad();
    });
    expect(res.status).toBe(400);
    const saved = await store.getAdminConfig();
    expect(saved?.CustomCategories.map((c) => c.query)).not.toContain('qb');
  });

  it('并发修改全部生效，不会互相覆盖', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        updateConfig(async (cfg) => {
          // 模拟读改写之间的耗时，制造冲突
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          cfg.CustomCategories.push({ name: `c${i}`, type: 'tv', query: `c${i}`, from: 'custom', disabled: false });
        })
      )
    );
    const saved = await store.getAdminConfig();
    const got = saved?.CustomCategories.filter((c) => /^c\d$/.test(c.query)).length;
    expect(got).toBe(10);
    // 内存缓存与数据库一致
    const cached = await getConfig();
    expect(cached.CustomCategories.filter((c) => /^c\d$/.test(c.query)).length).toBe(10);
  });
});
