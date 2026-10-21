"use client";

/**
 * 平台管理端「团队管理」页的数据层（`GET /teams`，仅系统管理员）。
 *
 * 为什么不用 `useQuery`：与 `use-team-admin.ts` 同口径 —— 这个接口是**全量**团队列表，
 * 403（ADMIN_ONLY）/ 网络 / 形状异常都可能发生；失败时必须降级成"错误文案 + 重试"，
 * 不能崩、也不能白屏。所以用 `useState + useEffect + try/catch` 显式控制。
 *
 * 请求带 `silent: true`：错误由本页自己展示（错误信息 + 重试按钮），不再弹全局 toast。
 *
 * 形状（后端契约，2026-10-21）：
 *   `{ items: [{ id, name, created_by, created_by_email, created_by_name,
 *               member_count, workstation_count, workstation_codes, created_at }], total }`
 * 字段缺失/类型漂移时归一化成安全默认值，不把坏数据塞进 UI。
 */
import { useCallback, useEffect, useState } from "react";

import apiClient from "@/lib/api/client";
import { teamErrorMessage } from "@/lib/team/team-errors";

export interface AdminTeam {
  id: number;
  name: string;
  created_by: number | null;
  created_by_email: string | null;
  created_by_name: string | null;
  member_count: number;
  workstation_count: number;
  workstation_codes: string[];
  created_at: string | null;
}

export interface AdminTeamsResult {
  items: AdminTeam[];
  total: number;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

// ── 形状归一化（缺字段/类型漂移 → 安全默认值）──────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 只保留非空字符串码，去重 —— 工位码是"已开通"清单，重复没有意义。 */
function asCodeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const codes = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item !== "");
  return Array.from(new Set(codes));
}

function normalizeTeams(data: unknown): AdminTeam[] {
  const body = asRecord(data);
  const items = body?.["items"];
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw) => {
    const row = asRecord(raw);
    if (!row) return [];
    const id = asNumber(row["id"]);
    const name = asText(row["name"]);
    if (id === null || name === null) return [];
    const workstationCodes = asCodeList(row["workstation_codes"]);
    return [
      {
        id,
        name,
        created_by: asNumber(row["created_by"]),
        created_by_email: asText(row["created_by_email"]),
        created_by_name: asText(row["created_by_name"]),
        member_count: asNumber(row["member_count"]) ?? 0,
        workstation_count:
          asNumber(row["workstation_count"]) ?? workstationCodes.length,
        workstation_codes: workstationCodes,
        created_at: asText(row["created_at"]),
      },
    ];
  });
}

function normalizeTotal(data: unknown, fallback: number): number {
  const total = asNumber(asRecord(data)?.["total"]);
  return total === null ? fallback : total;
}

export function useAdminTeams(): AdminTeamsResult {
  const [items, setItems] = useState<AdminTeam[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // 重试/刷新时先切回 loading 再发请求。
  // ⚠️ 别把 `setLoading(true)` 写在 effect 里：React Hooks v7 的
  //    `react-hooks/set-state-in-effect` 会报"effect 内同步 setState"（本仓库该规则为
  //    warn，升级前遗留 28 处）；写在事件回调里语义也更准（重试时才需要 loading）。
  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const { data } = await apiClient.get<unknown>("/teams", {
          silent: true,
        });
        if (cancelled) return;
        const rows = normalizeTeams(data);
        setItems(rows);
        setTotal(normalizeTotal(data, rows.length));
      } catch (err) {
        if (cancelled) return;
        setItems([]);
        setTotal(0);
        setError(teamErrorMessage(err, "团队列表读取失败（可稍后重试）"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { items, total, loading, error, reload };
}
