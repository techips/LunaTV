/**
 * @jest-environment node
 */
import { decryptBackup, encryptBackup, validateBackup } from '@/lib/backup';
import { SimpleCrypto } from '@/lib/crypto';

describe('备份加密', () => {
  it('新格式（AES-256-GCM）可正确往返', () => {
    const plain = Buffer.from('hello backup');
    const enc = encryptBackup(plain, 'pw-123456');
    expect(enc.startsWith('LTVB2:')).toBe(true);
    expect(decryptBackup(enc, 'pw-123456').toString()).toBe('hello backup');
  });

  it('密码错误或密文被篡改时报错', () => {
    const enc = encryptBackup(Buffer.from('data'), 'pw-123456');
    expect(() => decryptBackup(enc, 'wrong')).toThrow('解密失败');
    const raw = Buffer.from(enc.slice(6), 'base64');
    raw[raw.length - 1] ^= 1;
    expect(() => decryptBackup('LTVB2:' + raw.toString('base64'), 'pw-123456')).toThrow('解密失败');
  });

  it('兼容旧版 crypto-js 格式的备份文件', () => {
    const gz = Buffer.from('legacy gzip bytes');
    const legacy = SimpleCrypto.encrypt(gz.toString('base64'), 'old-pass');
    expect(decryptBackup(legacy, 'old-pass').toString()).toBe('legacy gzip bytes');
  });
});

describe('备份校验', () => {
  const base = { data: { adminConfig: {}, userData: {} } };

  it('接受结构正确的备份', () => {
    expect(() =>
      validateBackup({
        data: {
          adminConfig: {},
          userData: { alice: { playRecords: {}, favorites: {}, searchHistory: [], skipConfigs: {} } },
        },
      })
    ).not.toThrow();
  });

  it('拒绝缺字段或用户名非法的备份', () => {
    expect(() => validateBackup({})).toThrow();
    expect(() => validateBackup({ data: { adminConfig: {} } })).toThrow();
    expect(() =>
      validateBackup({ ...base, data: { ...base.data, userData: { 'a:b': {} } } })
    ).toThrow('用户名无效');
    expect(() =>
      validateBackup({ ...base, data: { ...base.data, userData: { a: { searchHistory: 'x' } } } })
    ).toThrow('搜索历史');
  });
});
