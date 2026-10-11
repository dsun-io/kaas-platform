/**
 * 工位订阅 → 入口可见性（**纯函数**，无 React 依赖，可直接单测）。
 *
 * 业务规则（docs/TEAMS_AND_VISIBILITY.md §10）：
 *   · 能力边界由**工位订阅**决定：没开通的工位，接口回 404，入口也不该出现；
 *   · 平台管理员不受限；
 *   · `full_chain` 是"全工位套餐"，命中等同于开通一切；
 *   · 数据隔离靠团队 —— 没有团队就没有订阅主体，所以 `has_team=false` 时先引导建/加入团队。
 *
 * 真源：`shared/contracts/workstations.ts`（key ↔ route ↔ name）。
 * 本文件只补一件事：**哪些 key 属于"计费工位"** —— 这份清单镜像后端
 * `backend/kaas_common/workstation/subscriptions.py` 的 `WORKSTATION_PATHS`。
 * 不在这张表里的入口（仪表盘、系统设置、产品定义…）后端**不拦**它们的接口
 * （见内核 `ALWAYS_ALLOWED_PREFIXES`），前端也就不该因为它们不在 `workstations` 里而隐藏。
 */
import {
  WORKSTATIONS,
  visibleWorkstations,
  workstationByRoute,
  type NavGroup,
  type Workstation,
} from "@contracts/workstations";

import { WORKSTATION_NOT_SUBSCRIBED } from "./lock-events";

/** 全工位套餐编码（后端 `FULL_CHAIN`） */
export const FULL_CHAIN_CODE = "full_chain";

/** 未开通工位的业务错误码（定义在零依赖的 lock-events 里，这里转出方便业务代码使用） */
export { WORKSTATION_NOT_SUBSCRIBED };

/** 需要订阅才能用的工位 key（镜像后端 WORKSTATION_PATHS；顺序仅为可读性，展示顺序另行派生） */
export const SUBSCRIBABLE_WORKSTATIONS: readonly string[] = [
  "research",
  "leadgen",
  "outreach",
  "quotes",
  "orders",
  "trade-docs",
  "shipments",
  "intel",
  "customers",
];

export interface WorkstationOption {
  key: string;
  name: string;
}

/** 工位是否属于"计费单元"（不是的永远可见） */
export function isSubscribableWorkstation(key: string): boolean {
  return SUBSCRIBABLE_WORKSTATIONS.includes(key);
}

/**
 * 可勾选的工位项（注册 / 建团队 / 开通面板共用）。
 * 顺序与名称一律取自契约的可见工位 —— 避免"单选列表"和"侧边栏"两套顺序、两套名字。
 */
export function subscribableWorkstationOptions(): WorkstationOption[] {
  return visibleWorkstations()
    .filter((w) => isSubscribableWorkstation(w.key))
    .map((w) => ({ key: w.key, name: w.name }));
}

/** 工位展示名（引导页要用，且必须与侧边栏同名） */
export function workstationName(key: string): string {
  return WORKSTATIONS.find((w) => w.key === key)?.name ?? key;
}

/** 工位入口路由（引导页"去开通"用） */
export function workstationRoute(key: string): string | undefined {
  return WORKSTATIONS.find((w) => w.key === key)?.route;
}

/**
 * 团队 + 我开通的工位快照（`GET /me/workstations` ∪ `GET /teams/me`）。
 *
 * `ok=false` 表示**没读到**（接口还没上线 / 网络不通）：
 * 这种情况下前端**一律放行**，宁可多给入口，也不要凭空把用户锁在自己的系统外面。
 */
export interface WorkstationSnapshot {
  /** 首屏还在拉 → 侧边栏出骨架，避免入口"闪现后消失" */
  loading: boolean;
  /** /me/workstations 是否成功读到 */
  ok: boolean;
  /** 已开通的工位 key */
  workstations: readonly string[];
  /** 生效订阅编码（团队 ∪ 个人；含 full_chain） */
  codes: readonly string[];
  isPlatformAdmin: boolean;
  hasTeam: boolean;
  /** 由 404 WORKSTATION_NOT_SUBSCRIBED 兜底记下的工位（快照可能是过期的） */
  lockedWorkstation: string | null;
}

export const INITIAL_WORKSTATION_SNAPSHOT: WorkstationSnapshot = {
  loading: true,
  ok: false,
  workstations: [],
  codes: [],
  isPlatformAdmin: false,
  hasTeam: false,
  lockedWorkstation: null,
};

/** `GET /me/workstations` 响应归一化后的字段 */
export interface MyWorkstationsPayload {
  workstations: string[];
  codes: string[];
  isPlatformAdmin: boolean;
  /** null = 后端没给这个字段（老版本），由调用方兜底 */
  hasTeam: boolean | null;
}

function payloadRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function payloadStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item !== "");
}

/**
 * 解析 `/me/workstations` 响应；**形状不认识就返回 null**（= 当没读到）。
 *
 * 为什么不能把"字段缺失"当成"一个工位都没开通"：前端可能先于后端上线，
 * 那样会把所有工位入口与页面锁死（用户彻底没法用）—— 误放行远好于误锁死。
 */
export function parseMyWorkstationsPayload(
  data: unknown,
): MyWorkstationsPayload | null {
  const body = payloadRecord(data);
  if (!body || !Array.isArray(body["workstations"])) return null;
  return {
    workstations: payloadStrings(body["workstations"]),
    codes: payloadStrings(body["codes"]),
    isPlatformAdmin: body["is_admin"] === true,
    hasTeam: typeof body["has_team"] === "boolean" ? body["has_team"] : null,
  };
}

/** 某个工位现在能不能用（未知一律放行） */
export function isWorkstationEnabled(
  snapshot: WorkstationSnapshot,
  key: string,
): boolean {
  if (snapshot.isPlatformAdmin) return true;
  if (snapshot.codes.includes(FULL_CHAIN_CODE)) return true;
  if (!isSubscribableWorkstation(key)) return true;
  if (!snapshot.ok) return true;
  return snapshot.workstations.includes(key);
}

/** 按已开通工位过滤侧边栏分组（空分组一并丢弃，避免剩下一个光秃秃的组标题） */
export function filterNavGroups(
  groups: ReadonlyArray<NavGroup & { items: Workstation[] }>,
  snapshot: WorkstationSnapshot,
): Array<NavGroup & { items: Workstation[] }> {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((w) => isWorkstationEnabled(snapshot, w.key)),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * 当前页面的工位访问状态。
 *
 * 三种"拦"是有区别的：没有团队（先去建/加入）≠ 团队没开通这个工位（找管理员开通）
 * ≠ 信息没拿到（放行，不能瞎拦）。
 */
export type WorkstationAccessState =
  | { kind: "ok" }
  /** 工位信息没拿到：放行（降级） */
  | { kind: "unknown" }
  | { kind: "no-team"; workstationKey: string }
  | { kind: "not-subscribed"; workstationKey: string };

export function resolveWorkstationAccess(input: {
  pathname: string;
  snapshot: WorkstationSnapshot;
  lockedWorkstation?: string | null;
}): WorkstationAccessState {
  const { pathname, snapshot } = input;
  const locked = input.lockedWorkstation ?? snapshot.lockedWorkstation;

  if (snapshot.isPlatformAdmin) return { kind: "ok" };

  const ws = workstationByRoute(pathname);
  // 非工位路由（/team、/onboarding…）永远放行
  if (!ws) return { kind: "ok" };
  // 仪表盘 / 系统设置这类不是计费单元，后端也不拦，永远放行
  if (!isSubscribableWorkstation(ws.key)) return { kind: "ok" };

  // ① 后端刚用 404 明确拒绝过**这个**工位（快照可能是过期的）：
  //    只对"当前路由的工位"生效 —— 换到别的工位页面自动失效，不会黏住。
  if (locked && locked === ws.key) {
    return snapshot.hasTeam
      ? { kind: "not-subscribed", workstationKey: ws.key }
      : { kind: "no-team", workstationKey: ws.key };
  }

  // ② 快照没读到：不拦
  if (!snapshot.ok) return { kind: "unknown" };

  // ③ 没有团队：先引导建/加入团队（没有团队就没有订阅主体）
  if (!snapshot.hasTeam) return { kind: "no-team", workstationKey: ws.key };

  // ④ 团队有，但这个工位没开通
  if (!isWorkstationEnabled(snapshot, ws.key)) {
    return { kind: "not-subscribed", workstationKey: ws.key };
  }

  return { kind: "ok" };
}
