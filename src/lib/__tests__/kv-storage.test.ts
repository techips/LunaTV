/**
 * @jest-environment node
 */
import { KvStorage } from '@/lib/kv-storage';
import { isHashed } from '@/lib/password';

import { MemoryKv } from '../__test-utils__/memory-kv';

describe('KvStorage', () => {
  let kv: MemoryKv;
  let store: KvStorage;
  beforeEach(() => {
    kv = new MemoryKv();
    store = new KvStorage(kv);
  });

  it('注册用户后可用原密码登录，存储的是加盐哈希', async () => {
    await store.registerUser('alice', 'secret-123');
    expect(await store.verifyUser('alice', 'secret-123')).toBe(true);
    expect(await store.verifyUser('alice', 'wrong')).toBe(false);
    expect(isHashed((await store.getPasswordHash('alice')) as string)).toBe(true);
    expect(await store.getAllUsers()).toEqual(['alice']);
  });

  it('备份导出 → 导入：原样写回哈希后仍能用原密码登录（修复二次哈希）', async () => {
    await store.registerUser('bob', 'bob-pass');
    const exported = (await store.getPasswordHash('bob')) as string;

    const restored = new KvStorage(new MemoryKv());
    await restored.setPasswordHash('bob', exported);
    expect(await restored.verifyUser('bob', 'bob-pass')).toBe(true);
    expect(await restored.getAllUsers()).toEqual(['bob']);
  });

  it('明文旧密码验证通过后自动升级为哈希', async () => {
    await kv.set('u:old:pwd', 'plain-pass');
    expect(await store.verifyUser('old', 'plain-pass')).toBe(true);
    expect(isHashed((await kv.get('u:old:pwd')) as string)).toBe(true);
  });

  it('删除用户会清空数据并递增会话版本号', async () => {
    await store.registerUser('carol', 'pw123456');
    await store.setPlayRecord('carol', 'src+1', { title: 't' } as never);
    const v0 = await store.getSessionVersion('carol');
    await store.deleteUser('carol');
    expect(await store.getAllPlayRecords('carol')).toEqual({});
    expect(await store.checkUserExist('carol')).toBe(false);
    expect(await store.getSessionVersion('carol')).toBe(v0 + 1);
  });

  it('配置乐观锁：版本号过期的写入被拒绝', async () => {
    const { version } = await store.getAdminConfigWithVersion();
    expect(version).toBe(0);
    const v1 = await store.casAdminConfig({ a: 1 } as never, 0);
    expect(v1).toBe(1);
    // 另一个写入者仍持有旧版本号 0
    expect(await store.casAdminConfig({ a: 2 } as never, 0)).toBeNull();
    expect(((await store.getAdminConfig()) as never as { a: number }).a).toBe(1);
  });

  it('搜索历史去重、最新在前、限制条数', async () => {
    for (let i = 0; i < 25; i++) await store.addSearchHistory('u', `k${i}`);
    await store.addSearchHistory('u', 'k10');
    const h = await store.getSearchHistory('u');
    expect(h.length).toBe(20);
    expect(h[0]).toBe('k10');
    expect(h.filter((x) => x === 'k10').length).toBe(1);
  });

  it('旧扁平 key 迁移到 Hash 结构', async () => {
    await kv.set('u:dave:pr:src+1', JSON.stringify({ title: 'x' }));
    await kv.set('u:dave:pwd', 'plain');
    await store.migrateData();
    expect(await store.getPlayRecord('dave', 'src+1')).toEqual({ title: 'x' });
    expect(await kv.get('u:dave:pr:src+1')).toBeNull();
    expect(await store.getAllUsers()).toEqual(['dave']);
  });

  it('托管播放列表读写', async () => {
    await store.setHostedPlaylist('hd', '#EXTM3U');
    expect(await store.getHostedPlaylist('hd')).toBe('#EXTM3U');
    await store.deleteHostedPlaylist('hd');
    expect(await store.getHostedPlaylist('hd')).toBeNull();
  });
});
