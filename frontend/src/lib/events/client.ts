import { apiClient } from '@/lib/api/client';
import type { EventType } from '@contracts/events';

/**
 * POST /api/v1/events — create a single event.
 *
 * **payload 直接内联提交，不再走 OSS 中转。**
 *
 * 历史：这里曾按 `>10KB` 先 `POST /oss/presign` 换上传地址、把 payload 传上去、
 * 只提交 `{ _oss_key }`。但后端**没有这条路由**（worker 全仓 `oss` 0 命中；
 * 见 `.tmp/align-report.md` §2-5），mock 里那个 200 的 handler 反而掩盖了这一点：
 * 每次大 payload 都要先打一次必然 404 的请求，再 catch 回退内联 ——
 * 用两次往返换一个注定失败的尝试，且事件表照样被撑大。
 *
 * 若将来确实要归档大 payload：应改走**已存在**的 `/file-objects/presign` +
 * `/file-objects/register`（`lib/products/use-products.ts` 的直传链路），
 * 而不是复活这一步。已知代价（P2）：超大 payload 会撑大 events 表，
 * 需要真后端/对象存储落档才能解决，前端不再假装有这条路。
 *
 * Never called directly from UI; use useCreateEvent for queue-based writes.
 */
export async function createEvent(body: {
  schema_version: number;
  event_type: EventType;
  event_source: 'frontend' | 'backend';
  tenant_id?: string;
  actor_id?: string;
  session_id?: string;
  trace_id?: string;
  payload: unknown;
}): Promise<{ id: string }> {
  const { data } = await apiClient.post<{ id: string }>('/events', body);

  return data;
}
