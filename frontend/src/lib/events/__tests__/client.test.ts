import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `createEvent` 的**回归钉子**：大 payload 直接内联提交，不再打
 * `POST /oss/presign`（后端没有这条路由，见 lib/events/client.ts 的注释与
 * `.tmp/align-report.md` §2-5）。
 *
 * 为什么用 mock 而不是 MSW：这条路径的失败模式正是"axios 打了一个不存在的端点"，
 * 直接断言 `apiClient.post` 的调用参数比绕一层 node server 更能钉住"没有第二个请求"。
 */
vi.mock('@/lib/api/client', () => {
  const post = vi.fn();
  return { apiClient: { post }, default: { post } };
});

import { apiClient } from '@/lib/api/client';
import { createEvent } from '../client';

const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;

describe('createEvent', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: { id: 'evt-1' } });
  });

  it('普通 payload 只发一次 POST /events，payload 原样内联', async () => {
    const payload = { ok: true };
    const result = await createEvent({
      schema_version: 1,
      event_type: 'audit.access',
      event_source: 'frontend',
      payload,
    });

    expect(result).toEqual({ id: 'evt-1' });
    expect(post).toHaveBeenCalledTimes(1);
    const [path, body] = post.mock.calls[0] as [
      string,
      { payload: unknown },
    ];
    expect(path).toBe('/events');
    expect(body.payload).toBe(payload);
  });

  it('超过 10KB 的 payload 也不走 OSS 中转（不再出现第二次请求）', async () => {
    const payload = { big: 'a'.repeat(20_000) };
    await createEvent({
      schema_version: 1,
      event_type: 'audit.access',
      event_source: 'frontend',
      payload,
    });

    // 关键：只有 /events 这一次调用；旧实现会先 POST /oss/presign
    expect(post).toHaveBeenCalledTimes(1);
    const [path, body] = post.mock.calls[0] as [
      string,
      { payload: unknown },
    ];
    expect(path).toBe('/events');
    expect(body.payload).toBe(payload);
  });
});
