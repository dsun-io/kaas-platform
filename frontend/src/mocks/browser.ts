import { setupWorker } from "msw/browser";

import { handlers } from "./handlers";
import { persistAfterMockedResponse } from "./persistence";

export const worker = setupWorker(...handlers);

/**
 * C5：mock 模式的写操作落到 localStorage（刷新不丢）。
 *
 * 为什么挂在 worker 生命周期而不是每个 handler 里手调：
 *  · `response:mocked` 触发时 resolver **已经返回响应** ⇒ store 里就是新值；
 *  · 只有**被 mock 的**响应才触发（未匹配/真实网络不会误写）。
 * 具体"哪个 URL 的写操作影响哪些集合"在 `persistence.ts` 的 `WRITE_RULES` 里，
 * 按 store 粒度落盘（只写被写操作碰过的集合，不做全量快照）。
 */
worker.events.on("response:mocked", ({ request }) => {
  persistAfterMockedResponse(request.method, request.url);
});
