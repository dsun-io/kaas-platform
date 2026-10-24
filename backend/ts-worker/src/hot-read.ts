/**
 * P0 热读（AUTH_DB_SPLIT）公共骨架 —— **只有两类东西**：
 * ① TS-DB 查询失败的错误映射（设计 §5.4 四类错误分离：db_unavailable 单独一类）；
 * ② 团队行级谓词（ws_files.py:79-107 `_team_scope` / `_team_scope_soft` 的逐行镜像）。
 *
 * 为什么谓词放这里而不是每个域各写一份：Q6「用户创建的业务数据仅团队内部可见」
 * 是全平台同一条尺（ws_files.py 与 orchestrator 逐字同义），复制即漂移。
 * 判定仍是**纯协议层**：没有业务 if，只有角色豁免 + team 相等（ADR-008）。
 *
 * ⚠️ 本模块只在 AUTH_DB_SPLIT=on 的直连路径上被调用；off 时门面一个字节都不碰。
 */
import type { Context } from "hono";

import { MissingSecretError } from "./env";
import { ApiError } from "./http";
import { isAdminRole } from "./rules";
import type { CurrentUser } from "./session";

/** TS-DB 不可用时给用户看的兜底文案（内部异常串只进 console.error）。 */
export const DB_UNAVAILABLE_MESSAGE = "数据库暂时不可用，请稍后重试";

/**
 * 直连读的统一出口：把「拿不到 DB」映射成 503 `{error:"db_unavailable", retryable:true}`。
 *
 * 与 proxy 的 `kernel_unavailable`(502) **刻意分开**：运维/前端据此一眼区分
 * 「内核没起来（可换路径）」与「数据库有问题（换哪条路都一样）」。
 * 业务/协议错误（ApiError：401/403/404/422）与缺 secret（503）原样上抛，
 * 由 respond()/外层中间件按既有信封处理 —— 本函数不改写它们。
 */
export async function directDb(
  c: Context,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError || e instanceof MissingSecretError) throw e;
    console.error("[hot-read] db query failed", e);
    return c.json(
      {
        error: "db_unavailable",
        message: DB_UNAVAILABLE_MESSAGE,
        status: 503,
        retryable: true,
      },
      503,
    );
  }
}

/**
 * ws_files.py:79-96 `_team_scope`（硬版）：**用户创建的业务数据仅团队内部可见**。
 * - 管理员 ⇒ `("", [])`（不加谓词，含历史 team_id IS NULL 行，D3/D4）；
 * - 有团队 ⇒ `AND <col>=$next` + 团队 id；
 * - 无团队 ⇒ **403 NO_TEAM**（§1.5 的次序：403 在 404 之前）。
 *
 * 参数占位符用调用方给的 `nextIndex`（= 现有 params 长度 + 1），与 Python 的位置占位符口径一致。
 */
export function teamScope(
  user: CurrentUser,
  nextIndex: number,
  col: string = "team_id",
): [string, unknown[]] {
  if (isAdminRole(user.role)) return ["", []];
  if (user.team_id === null || user.team_id === undefined) {
    throw httpForbiddenNoTeam();
  }
  return [" AND " + col + "=$" + String(nextIndex), [user.team_id]];
}

/**
 * ws_files.py:99-107 `_team_scope_soft`（软版）：只给「公开层 + 私有层混在一起」的端点用
 * （产品清单：产品定义人人可读，但图片/资料是团队私有）。
 * 无团队 ⇒ 谓词 `= NULL`（恒不成立）⇒ 私有部分为空，**公开层照旧返回**（Q6 两层不压平）。
 */
export function teamScopeSoft(
  user: CurrentUser,
  nextIndex: number,
  col: string = "team_id",
): [string, unknown[]] {
  if (isAdminRole(user.role)) return ["", []];
  return [" AND " + col + "=$" + String(nextIndex), [user.team_id ?? null]];
}

/** 403 `{error:"forbidden", code:"NO_TEAM"}`（与 Python `_team_scope` 同一信封）。 */
function httpForbiddenNoTeam(): ApiError {
  return new ApiError(403, { error: "forbidden", code: "NO_TEAM" });
}
