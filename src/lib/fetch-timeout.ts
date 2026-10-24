/**
 * 带超时的 fetch。上游卡住时不会无限挂起请求、定时任务或管理员操作。
 * 调用方传入的 signal 仍然生效（任一触发都会中止）。
 */
export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = 10000
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? anySignal([init.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(input, { ...init, signal });
}

/**
 * 只限制「等待响应头」的时间，拿到响应后不再计时，适合流式转发大文件（视频分片）。
 * 调用方可通过 init.signal 在客户端断开时中止上游请求。
 */
export async function fetchWithHeaderTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = 10000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Timeout', 'TimeoutError')),
    timeoutMs
  );
  const signal = init.signal
    ? anySignal([init.signal, controller.signal])
    : controller.signal;
  try {
    return await fetch(input, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), {
      once: true,
    });
  }
  return controller.signal;
}

export function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'TimeoutError' || err.name === 'AbortError')
  );
}
