import { fetchWithTimeout } from './fetch-timeout';

/** 拉取并解码配置订阅；失败时抛出可以直接展示给用户的错误信息 */
export async function fetchSubscriptionConfig(url: unknown): Promise<string> {
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('请填写订阅地址');
  }
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    // 常见误操作：把订阅内容本身粘贴到了地址栏
    throw new Error(
      '订阅地址必须是 http(s) 链接；如果你粘贴的是一长串配置内容，请把它放到可访问的地址（例如 gist 的 raw 链接）后再填写链接'
    );
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(trimmed, {}, 15000);
  } catch (e) {
    throw new Error(`无法访问订阅地址：${(e as Error).message}`);
  }
  if (!response.ok) {
    throw new Error(`订阅地址返回 HTTP ${response.status}`);
  }
  const content = (await response.text()).trim();

  if (/^\s*</.test(content)) {
    throw new Error('订阅地址返回的是网页而不是订阅内容；如果是 GitHub Gist，请使用 Raw 链接');
  }

  let decoded: string;
  try {
    // bs58 是 ESM 包，需动态导入
    const bs58 = (await import('bs58')).default;
    decoded = new TextDecoder().decode(bs58.decode(content));
  } catch {
    throw new Error('订阅内容不是有效的 Base58 编码');
  }

  try {
    JSON.parse(decoded);
  } catch {
    throw new Error('订阅解码后不是有效的 JSON 配置');
  }
  return decoded;
}
