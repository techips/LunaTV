/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { NextRequest, NextResponse } from 'next/server';

import { AdminConfig } from '@/lib/admin.types';
import { updateConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { rejectLocalStorage, requireAuth, revokeSessions } from '@/lib/require-auth';

export const runtime = 'nodejs';

type AdminUser = AdminConfig['UserConfig']['Users'][number];

// 支持的操作类型
const ACTIONS = [
  'add',
  'ban',
  'unban',
  'setAdmin',
  'cancelAdmin',
  'changePassword',
  'deleteUser',
  'updateUserApis',
  'userGroup',
  'updateUserGroups',
  'batchUpdateUserGroups',
] as const;

const USERNAME_RE = /^[^\s:]{1,32}$/;

export async function POST(request: NextRequest) {
  const local = rejectLocalStorage();
  if (local) return local;
  const auth = await requireAuth(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();

    const username = auth.username;
    const operatorRole: 'owner' | 'admin' = auth.role === 'owner' ? 'owner' : 'admin';

    const {
      targetUsername, // 目标用户名
      targetPassword, // 目标用户密码（仅在添加用户时需要）
      action,
    } = body as {
      targetUsername?: string;
      targetPassword?: string;
      action?: (typeof ACTIONS)[number];
    };

    if (!action || !ACTIONS.includes(action)) {
      return NextResponse.json({ error: '参数格式错误' }, { status: 400 });
    }

    // 用户组操作和批量操作不需要targetUsername
    if (!targetUsername && !['userGroup', 'batchUpdateUserGroups'].includes(action)) {
      return NextResponse.json({ error: '缺少目标用户名' }, { status: 400 });
    }

    if (
      action !== 'changePassword' &&
      action !== 'deleteUser' &&
      action !== 'updateUserApis' &&
      action !== 'userGroup' &&
      action !== 'updateUserGroups' &&
      action !== 'batchUpdateUserGroups' &&
      username === targetUsername
    ) {
      return NextResponse.json(
        { error: '无法对自己进行此操作' },
        { status: 400 }
      );
    }

    if (action === 'add') {
      if (!targetUsername || !USERNAME_RE.test(targetUsername) || targetUsername === process.env.USERNAME) {
        return NextResponse.json({ error: '用户名不合法（1-32 位，不含空格和冒号）' }, { status: 400 });
      }
    }
    if ((action === 'add' || action === 'changePassword') && (!targetPassword || targetPassword.length < 6)) {
      return NextResponse.json({ error: '密码长度至少为6位' }, { status: 400 });
    }

    // 数据库副作用在配置事务提交成功后再执行，避免事务重试时重复执行
    let afterCommit: (() => Promise<void>)[] = [];

    const result = await updateConfig(async (adminConfig) => {
      afterCommit = [];
      // 查找目标用户条目（用户组操作和批量操作不需要）
      let targetEntry: AdminUser | null = null;
      let isTargetAdmin = false;

      if (!['userGroup', 'batchUpdateUserGroups'].includes(action) && targetUsername) {
        targetEntry =
          adminConfig.UserConfig.Users.find((u) => u.username === targetUsername) ?? null;

        if (
          targetEntry &&
          targetEntry.role === 'owner' &&
          !['changePassword', 'updateUserApis', 'updateUserGroups'].includes(action)
        ) {
          return NextResponse.json({ error: '无法操作站长' }, { status: 400 });
        }

        // 权限校验逻辑
        isTargetAdmin = targetEntry?.role === 'admin';
      }

      switch (action) {
        case 'add': {
          if (targetEntry) {
            return NextResponse.json({ error: '用户已存在' }, { status: 400 });
          }
          if (!targetPassword) {
            return NextResponse.json(
              { error: '缺少目标用户密码' },
              { status: 400 }
            );
          }
          afterCommit.push(() => db.registerUser(targetUsername!, targetPassword));

          // 获取用户组信息
          const { userGroup } = body as { userGroup?: string };

          // 更新配置
          const newUser: AdminUser = {
            username: targetUsername!,
            role: 'user',
          };

          // 如果指定了用户组，添加到tags中
          if (userGroup && userGroup.trim()) {
            newUser.tags = [userGroup];
          }

          adminConfig.UserConfig.Users.push(newUser);
          targetEntry =
            adminConfig.UserConfig.Users[
            adminConfig.UserConfig.Users.length - 1
            ];
          break;
        }
        case 'ban': {
          if (!targetEntry) {
            return NextResponse.json(
              { error: '目标用户不存在' },
              { status: 404 }
            );
          }
          if (isTargetAdmin) {
            // 目标是管理员
            if (operatorRole !== 'owner') {
              return NextResponse.json(
                { error: '仅站长可封禁管理员' },
                { status: 401 }
              );
            }
          }
          targetEntry.banned = true;
          afterCommit.push(() => revokeSessions(targetUsername!));
          break;
        }
        case 'unban': {
          if (!targetEntry) {
            return NextResponse.json(
              { error: '目标用户不存在' },
              { status: 404 }
            );
          }
          if (isTargetAdmin) {
            if (operatorRole !== 'owner') {
              return NextResponse.json(
                { error: '仅站长可操作管理员' },
                { status: 401 }
              );
            }
          }
          targetEntry.banned = false;
          break;
        }
        case 'setAdmin': {
          if (!targetEntry) {
            return NextResponse.json(
              { error: '目标用户不存在' },
              { status: 404 }
            );
          }
          if (targetEntry.role === 'admin') {
            return NextResponse.json(
              { error: '该用户已是管理员' },
              { status: 400 }
            );
          }
          if (operatorRole !== 'owner') {
            return NextResponse.json(
              { error: '仅站长可设置管理员' },
              { status: 401 }
            );
          }
          targetEntry.role = 'admin';
          break;
        }
        case 'cancelAdmin': {
          if (!targetEntry) {
            return NextResponse.json(
              { error: '目标用户不存在' },
              { status: 404 }
            );
          }
          if (targetEntry.role !== 'admin') {
            return NextResponse.json(
              { error: '目标用户不是管理员' },
              { status: 400 }
            );
          }
          if (operatorRole !== 'owner') {
            return NextResponse.json(
              { error: '仅站长可取消管理员' },
              { status: 401 }
            );
          }
          targetEntry.role = 'user';
          break;
        }
        case 'changePassword': {
          if (!targetEntry) {
            return NextResponse.json(
              { error: '目标用户不存在' },
              { status: 404 }
            );
          }
          if (!targetPassword) {
            return NextResponse.json({ error: '缺少新密码' }, { status: 400 });
          }

          // 权限检查：不允许修改站长密码
          if (targetEntry.role === 'owner') {
            return NextResponse.json(
              { error: '无法修改站长密码' },
              { status: 401 }
            );
          }

          if (
            isTargetAdmin &&
            operatorRole !== 'owner' &&
            username !== targetUsername
          ) {
            return NextResponse.json(
              { error: '仅站长可修改其他管理员密码' },
              { status: 401 }
            );
          }

          afterCommit.push(async () => {
            await db.changePassword(targetUsername!, targetPassword);
            await revokeSessions(targetUsername!);
          });
          break;
        }
        case 'deleteUser': {
          if (!targetEntry) {
            return NextResponse.json(
              { error: '目标用户不存在' },
              { status: 404 }
            );
          }

          // 权限检查：站长可删除所有用户（除了自己），管理员可删除普通用户
          if (username === targetUsername) {
            return NextResponse.json(
              { error: '不能删除自己' },
              { status: 400 }
            );
          }

          if (isTargetAdmin && operatorRole !== 'owner') {
            return NextResponse.json(
              { error: '仅站长可删除管理员' },
              { status: 401 }
            );
          }

          afterCommit.push(() => db.deleteUser(targetUsername!));

          // 从配置中移除用户
          const userIndex = adminConfig.UserConfig.Users.findIndex(
            (u) => u.username === targetUsername
          );
          if (userIndex > -1) {
            adminConfig.UserConfig.Users.splice(userIndex, 1);
          }

          break;
        }
        case 'updateUserApis': {
          if (!targetEntry) {
            return NextResponse.json(
              { error: '目标用户不存在' },
              { status: 404 }
            );
          }

          const { enabledApis } = body as { enabledApis?: string[] };

          // 权限检查：站长可配置所有人的采集源，管理员可配置普通用户和自己的采集源
          if (
            isTargetAdmin &&
            operatorRole !== 'owner' &&
            username !== targetUsername
          ) {
            return NextResponse.json(
              { error: '仅站长可配置其他管理员的采集源' },
              { status: 401 }
            );
          }

          // 更新用户的采集源权限
          if (enabledApis && enabledApis.length > 0) {
            targetEntry.enabledApis = enabledApis;
          } else {
            // 如果为空数组或未提供，则删除该字段，表示无限制
            delete targetEntry.enabledApis;
          }

          break;
        }
        case 'userGroup': {
          // 用户组管理操作
          const { groupAction, groupName, enabledApis } = body as {
            groupAction: 'add' | 'edit' | 'delete';
            groupName: string;
            enabledApis?: string[];
          };

          if (!adminConfig.UserConfig.Tags) {
            adminConfig.UserConfig.Tags = [];
          }

          switch (groupAction) {
            case 'add': {
              // 检查用户组是否已存在
              if (adminConfig.UserConfig.Tags.find(t => t.name === groupName)) {
                return NextResponse.json({ error: '用户组已存在' }, { status: 400 });
              }
              adminConfig.UserConfig.Tags.push({
                name: groupName,
                enabledApis: enabledApis || [],
              });
              break;
            }
            case 'edit': {
              const groupIndex = adminConfig.UserConfig.Tags.findIndex(t => t.name === groupName);
              if (groupIndex === -1) {
                return NextResponse.json({ error: '用户组不存在' }, { status: 404 });
              }
              adminConfig.UserConfig.Tags[groupIndex].enabledApis = enabledApis || [];
              break;
            }
            case 'delete': {
              const groupIndex = adminConfig.UserConfig.Tags.findIndex(t => t.name === groupName);
              if (groupIndex === -1) {
                return NextResponse.json({ error: '用户组不存在' }, { status: 404 });
              }

              // 查找使用该用户组的所有用户
              const affectedUsers: string[] = [];
              adminConfig.UserConfig.Users.forEach(user => {
                if (user.tags && user.tags.includes(groupName)) {
                  affectedUsers.push(user.username);
                  // 从用户的tags中移除该用户组
                  user.tags = user.tags.filter(tag => tag !== groupName);
                  // 如果用户没有其他标签了，删除tags字段
                  if (user.tags.length === 0) {
                    delete user.tags;
                  }
                }
              });

              // 删除用户组
              adminConfig.UserConfig.Tags.splice(groupIndex, 1);

              // 记录删除操作的影响
              logger.info(`删除用户组 "${groupName}"，影响用户: ${affectedUsers.length > 0 ? affectedUsers.join(', ') : '无'}`);

              break;
            }
            default:
              return NextResponse.json({ error: '未知的用户组操作' }, { status: 400 });
          }
          break;
        }
        case 'updateUserGroups': {
          if (!targetEntry) {
            return NextResponse.json({ error: '目标用户不存在' }, { status: 404 });
          }

          const { userGroups } = body as { userGroups: string[] };

          // 权限检查：站长可配置所有人的用户组，管理员可配置普通用户和自己的用户组
          if (
            isTargetAdmin &&
            operatorRole !== 'owner' &&
            username !== targetUsername
          ) {
            return NextResponse.json({ error: '仅站长可配置其他管理员的用户组' }, { status: 400 });
          }

          // 更新用户的用户组
          if (userGroups && userGroups.length > 0) {
            targetEntry.tags = userGroups;
          } else {
            // 如果为空数组或未提供，则删除该字段，表示无用户组
            delete targetEntry.tags;
          }

          break;
        }
        case 'batchUpdateUserGroups': {
          const { usernames, userGroups } = body as { usernames: string[]; userGroups: string[] };

          if (!usernames || !Array.isArray(usernames) || usernames.length === 0) {
            return NextResponse.json({ error: '缺少用户名列表' }, { status: 400 });
          }

          // 权限检查：站长可批量配置所有人的用户组，管理员只能批量配置普通用户
          if (operatorRole !== 'owner') {
            for (const targetUsername of usernames) {
              const targetUser = adminConfig.UserConfig.Users.find(u => u.username === targetUsername);
              if (targetUser && targetUser.role === 'admin' && targetUsername !== username) {
                return NextResponse.json({ error: `管理员无法操作其他管理员 ${targetUsername}` }, { status: 400 });
              }
            }
          }

          // 批量更新用户组
          for (const targetUsername of usernames) {
            const targetUser = adminConfig.UserConfig.Users.find(u => u.username === targetUsername);
            if (targetUser) {
              if (userGroups && userGroups.length > 0) {
                targetUser.tags = userGroups;
              } else {
                // 如果为空数组或未提供，则删除该字段，表示无用户组
                delete targetUser.tags;
              }
            }
          }

          break;
        }
        default:
          return NextResponse.json({ error: '未知操作' }, { status: 400 });
      }

    });
    if (result instanceof Response) return result;

    for (const fn of afterCommit) {
      await fn();
    }

    return NextResponse.json(
      { ok: true },
      {
        headers: {
          'Cache-Control': 'no-store', // 管理员配置不缓存
        },
      }
    );
  } catch (error) {
    logger.error('用户管理操作失败:', error);
    return NextResponse.json(
      {
        error: '用户管理操作失败',
        details: (error as Error).message,
      },
      { status: 500 }
    );
  }
}
