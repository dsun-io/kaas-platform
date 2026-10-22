/**
 * API 令牌 scope 目录（W5 M1，设置页「API 令牌」多选）。
 *
 * ⚠️ 唯一真源 = `backend/ts-worker/src/tokens.ts` 的 `API_TOKEN_SCOPES`（21 项）。
 * 前端不能 import 后端源码（构建边界），所以这里按真源镜像一份供 UI 展示；
 * **创建令牌时后端仍会逐项校验白名单**，未知 scope 返回 422 UNKNOWN_SCOPE。
 *
 * 增删 scope 必须同步改两处（本文件 + backend tokens.ts）；mock handler 也读本文件，
 * 因此 mock 与 UI 不会再各抄一份。
 */
export interface ApiTokenScopeOption {
  value: string;
  label: string;
}

export interface ApiTokenScopeGroup {
  label: string;
  scopes: readonly ApiTokenScopeOption[];
}

export const API_TOKEN_SCOPE_GROUPS: readonly ApiTokenScopeGroup[] = [
  {
    label: "客户",
    scopes: [
      { value: "customers:read", label: "读取客户" },
      { value: "customers:write", label: "创建 / 编辑客户" },
    ],
  },
  {
    label: "询盘",
    scopes: [
      { value: "inquiries:read", label: "读取询盘" },
      { value: "inquiries:write", label: "创建 / 编辑询盘" },
    ],
  },
  {
    label: "订单",
    scopes: [
      { value: "orders:read", label: "读取订单" },
      { value: "orders:write", label: "创建 / 编辑订单" },
    ],
  },
  {
    label: "报价",
    scopes: [
      { value: "quotes:read", label: "读取报价" },
      { value: "quotes:calc", label: "执行报价计算" },
    ],
  },
  {
    label: "单证",
    scopes: [
      { value: "trade_docs:read", label: "读取单证" },
      { value: "trade_docs:write", label: "创建 / 编辑单证" },
    ],
  },
  {
    label: "出货",
    scopes: [
      { value: "shipments:read", label: "读取出货记录" },
      { value: "shipments:write", label: "创建 / 编辑出货记录" },
    ],
  },
  {
    label: "线索",
    scopes: [
      { value: "leadgen:read", label: "读取线索" },
      { value: "leadgen:write", label: "创建 / 编辑线索" },
    ],
  },
  {
    label: "触达",
    scopes: [
      { value: "outreach:read", label: "读取触达记录" },
      { value: "outreach:write", label: "创建 / 编辑触达记录" },
    ],
  },
  {
    label: "调研",
    scopes: [
      { value: "research:read", label: "读取调研" },
      { value: "research:write", label: "创建 / 编辑调研" },
    ],
  },
  {
    label: "情报",
    scopes: [{ value: "intel:read", label: "读取情报" }],
  },
  {
    label: "文件",
    scopes: [
      { value: "files:read", label: "读取文件" },
      { value: "files:write", label: "上传 / 编辑文件" },
    ],
  },
];

/** 扁平化的 scope 白名单（与后端 21 项一一对应）。 */
export const API_TOKEN_SCOPES: readonly string[] =
  API_TOKEN_SCOPE_GROUPS.flatMap((group) =>
    group.scopes.map((scope) => scope.value),
  );

/** 判断一个 scope 是否在 UI 目录里（mock handler 复用它做 422 校验）。 */
export function isKnownApiTokenScope(scope: string): boolean {
  return API_TOKEN_SCOPES.includes(scope);
}

const SCOPE_LABELS = new Map(
  API_TOKEN_SCOPE_GROUPS.flatMap((group) =>
    group.scopes.map((scope) => [scope.value, scope.label] as const),
  ),
);

/** scope code → 中文短名；未知 scope 原样显示（便于发现契约漂移）。 */
export function scopeLabel(scope: string): string {
  return SCOPE_LABELS.get(scope) ?? scope;
}

/**
 * 表格里的作用域摘要：最多展示 `max` 项，其余折叠成 `+N`。
 * 完整 scope 列表放在 title 里，避免 21 项把行撑得极高。
 */
export function summarizeScopes(scopes: readonly string[], max = 3): string {
  if (scopes.length === 0) return "未选择权限范围";
  const labels = scopes.map(scopeLabel);
  if (labels.length <= max) return labels.join("、");
  return `${labels.slice(0, max).join("、")} +${labels.length - max}`;
}
