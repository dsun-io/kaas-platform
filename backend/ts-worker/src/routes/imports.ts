/**
 * KaaS TS 门面 · 历史订单批量导入（C29，2 条显式路由）。
 *
 * 真源逐条对齐 backend/worker/src/imports_api.py：
 * - POST /api/v1/imports/orders/preview —— 逐行校验 + 预览（内核零写入）；
 * - POST /api/v1/imports/orders         —— 单事务全有全无写入（保留 CSV 的 order_no）。
 *
 * ── 边界（ADR-008 铁纪律）──────────────────────────────────────────────────
 * 本文件只有 **路由注册 + 原样透传**：
 * - multipart（file + customer_id）**不解析、不重写**，Content-Type/boundary 原样带过去；
 * - CSV 解析 / 逐行校验 / 客户归属 / 事务 / 撞库判定全部在 Python 内核；
 * - 门面不写任何业务 if，也不把 422/409 的错误信封改写（4xx 原样回，5xx 归一 kernel_error）。
 *
 * 鉴权口径（与 Python 一致）：内核端点依赖 _get_current_user ⇒ 请求照旧透传给内核裁决
 * （JWT 非法时门面先 401）。**API token 未声明 scope**：/api/v1/imports 不在
 * src/scope-map.ts 的规则表里 ⇒ 门面 403 SCOPE_NOT_DECLARED（设计 §1-9，有意如此，
 * 批量写入不开放给 API token）。
 */
import { Hono, type Context } from "hono";

import type { Env } from "../env";
import { forwardKernelRequest } from "../proxy";

const app = new Hono<{ Bindings: Env }>();

/** 原样透传（与引擎域 mount 共用 src/proxy.ts:forwardKernelRequest 这一份实现）。 */
function forward(c: Context): Promise<Response> {
  return forwardKernelRequest(c);
}

app.post("/api/v1/imports/orders/preview", forward);
app.post("/api/v1/imports/orders", forward);

export default app;
