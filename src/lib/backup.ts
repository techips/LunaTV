/* eslint-disable no-console, @typescript-eslint/no-explicit-any */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { promisify } from 'util';
import { gunzip, gzip } from 'zlib';

import { AdminConfig } from './admin.types';
import { configSelfCheck } from './config';
import { SimpleCrypto } from './crypto';
import { db } from './db';
import { isHashed } from './password';
import { Favorite, PlayRecord, SkipConfig } from './types';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// ---------------- 加密 ----------------
// 新格式：LTVB2:base64(salt(16) | iv(12) | tag(16) | ciphertext)，scrypt 派生密钥 + AES-256-GCM
const MAGIC = 'LTVB2:';
const SCRYPT = { N: 16384, r: 8, p: 1 };

export function encryptBackup(plain: Buffer, password: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32, SCRYPT);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return MAGIC + Buffer.concat([salt, iv, cipher.getAuthTag(), enc]).toString('base64');
}

/** 解密备份文件，返回 gzip 压缩的 JSON；兼容旧版 crypto-js 格式 */
export function decryptBackup(data: string, password: string): Buffer {
  const text = data.trim();
  if (text.startsWith(MAGIC)) {
    const raw = Buffer.from(text.slice(MAGIC.length), 'base64');
    const salt = raw.subarray(0, 16);
    const iv = raw.subarray(16, 28);
    const tag = raw.subarray(28, 44);
    const enc = raw.subarray(44);
    try {
      const key = scryptSync(password, salt, 32, SCRYPT);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]);
    } catch {
      throw new Error('解密失败，请检查密码是否正确');
    }
  }
  // 旧格式：crypto-js 口令加密的 base64(gzip)
  return Buffer.from(SimpleCrypto.decrypt(text, password), 'base64');
}

// ---------------- 数据结构 ----------------

export interface UserBackup {
  playRecords: Record<string, PlayRecord>;
  favorites: Record<string, Favorite>;
  searchHistory: string[];
  skipConfigs: Record<string, SkipConfig>;
  /** 存储中的密码值（加盐哈希；很旧的数据可能是明文） */
  password: string | null;
}

export interface BackupData {
  timestamp: string;
  serverVersion: string;
  data: {
    adminConfig: AdminConfig;
    userData: Record<string, UserBackup>;
    hostedPlaylists?: Record<string, string>;
  };
}

export async function collectBackup(serverVersion: string): Promise<BackupData> {
  const config = await db.getAdminConfig();
  if (!config) throw new Error('无法获取配置');

  const owner = process.env.USERNAME || '';
  const users = Array.from(new Set([...(await db.getAllUsers()), owner].filter(Boolean)));
  const userData: Record<string, UserBackup> = {};
  for (const username of users) {
    userData[username] = {
      playRecords: await db.getAllPlayRecords(username),
      favorites: await db.getAllFavorites(username),
      searchHistory: await db.getSearchHistory(username),
      skipConfigs: await db.getAllSkipConfigs(username),
      // 站长密码来自环境变量，不写入备份
      password: username === owner ? null : await db.getPasswordHash(username),
    };
  }

  const hostedPlaylists: Record<string, string> = {};
  for (const live of config.LiveConfig || []) {
    if (live.url?.startsWith('hosted:')) {
      const key = live.url.slice('hosted:'.length);
      const content = await db.getHostedPlaylist(key);
      if (content !== null) hostedPlaylists[key] = content;
    }
  }

  return {
    timestamp: new Date().toISOString(),
    serverVersion,
    data: { adminConfig: config, userData, hostedPlaylists },
  };
}

export async function packBackup(data: BackupData, password: string): Promise<string> {
  return encryptBackup(await gzipAsync(JSON.stringify(data)), password);
}

export async function unpackBackup(fileText: string, password: string): Promise<BackupData> {
  const compressed = decryptBackup(fileText, password);
  let json: any;
  try {
    json = JSON.parse((await gunzipAsync(compressed)).toString());
  } catch {
    throw new Error('备份文件格式错误');
  }
  validateBackup(json);
  return json as BackupData;
}

export function validateBackup(json: any): void {
  const d = json?.data;
  if (!d || typeof d !== 'object' || !d.adminConfig || typeof d.userData !== 'object') {
    throw new Error('备份文件格式无效');
  }
  for (const [name, u] of Object.entries<any>(d.userData)) {
    if (!name || /[\s:]/.test(name)) throw new Error(`备份中的用户名无效: ${name}`);
    for (const field of ['playRecords', 'favorites', 'skipConfigs'] as const) {
      if (u[field] !== undefined && (typeof u[field] !== 'object' || u[field] === null)) {
        throw new Error(`用户 ${name} 的 ${field} 格式无效`);
      }
    }
    if (u.searchHistory !== undefined && !Array.isArray(u.searchHistory)) {
      throw new Error(`用户 ${name} 的搜索历史格式无效`);
    }
  }
}

/** 把备份写入存储（调用前应已清空） */
export async function writeBackup(data: BackupData): Promise<number> {
  const owner = process.env.USERNAME;
  const adminConfig = configSelfCheck(data.data.adminConfig);
  await db.saveAdminConfig(adminConfig);

  for (const [key, content] of Object.entries(data.data.hostedPlaylists || {})) {
    await db.setHostedPlaylist(key, content);
  }

  let count = 0;
  for (const [username, user] of Object.entries(data.data.userData)) {
    count++;
    if (username !== owner && user.password) {
      // 备份里是哈希就原样写回；很旧的备份可能是明文，按新密码注册
      if (isHashed(user.password)) {
        await db.setPasswordHash(username, user.password);
      } else {
        await db.registerUser(username, user.password);
      }
    }
    for (const [key, record] of Object.entries(user.playRecords || {})) {
      const [source, ...rest] = key.split('+');
      if (source && rest.length) await db.savePlayRecord(username, source, rest.join('+'), record);
    }
    for (const [key, fav] of Object.entries(user.favorites || {})) {
      const [source, ...rest] = key.split('+');
      if (source && rest.length) await db.saveFavorite(username, source, rest.join('+'), fav);
    }
    // 历史记录按新→旧存储，逆序写入以保持顺序
    for (const keyword of [...(user.searchHistory || [])].reverse()) {
      await db.addSearchHistory(username, keyword);
    }
    for (const [key, skip] of Object.entries(user.skipConfigs || {})) {
      const [source, ...rest] = key.split('+');
      if (source && rest.length) await db.setSkipConfig(username, source, rest.join('+'), skip);
    }
  }
  return count;
}

/**
 * 导入备份：先完整校验，再对当前数据做快照；写入失败时用快照回滚。
 */
export async function restoreBackup(data: BackupData, serverVersion: string): Promise<number> {
  validateBackup(data);
  const snapshot = await collectBackup(serverVersion);
  await db.clearAllData();
  try {
    return await writeBackup(data);
  } catch (error) {
    console.error('导入失败，正在回滚:', error);
    try {
      await db.clearAllData();
      await writeBackup(snapshot);
    } catch (rollbackError) {
      console.error('回滚失败:', rollbackError);
      throw new Error(`导入失败且回滚失败：${(error as Error).message}`);
    }
    throw new Error(`导入失败，已恢复为导入前的数据：${(error as Error).message}`);
  }
}
