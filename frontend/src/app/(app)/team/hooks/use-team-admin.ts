"use client";

/**
 * 团队管理页的数据层（成员 / 邀请 / 工位订阅）。
 *
 * 为什么不用 `useQuery`：这三个接口已由 worker `ws_teams.py` / `ws_workstations.py` 实现，
 * 但仍要求"失败必须降级成空态 + 提示，绝不能崩/白屏"（权限/网络/形状异常都可能失败）。
 * 这里用 `useState + useEffect + try/catch` 显式控制：
 * 失败时 items 归零、error 给中文文案，由 UI 渲染"暂不可用"，不存在被异常打穿的可能。
 *
 * 所有请求都带 `silent: true`：错误由本页自己显示，不再弹全局 toast（避免一条错误弹两遍）。
 */
import { useCallback, useEffect, useState } from "react";

import apiClient from "@/lib/api/client";
import { teamErrorMessage } from "@/lib/team/team-errors";
import type { JoinApplication } from "@/lib/team/join-applications";

export interface TeamMember {
  user_id: number;
  email: string;
  display_name: string;
  role: string;
  is_admin: boolean;
  console_access: boolean;
}

export interface TeamInviteRow {
  id: number;
  email: string | null;
  token: string;
  status: string;
  created_at: string | null;
  expires_at: string | null;
  accepted_at: string | null;
}

export interface TeamSubscriptionRow {
  code: string;
  active: boolean;
  expires_at: string | null;
  source: string | null;
  /** ⚠️ 只有**列表**接口带 created_at；PUT 的单条响应刻意没有它（契约如此） */
  created_at: string | null;
}

/** 加入申请行（类型真源 = lib/team/join-applications.ts，与后端契约对齐）。 */
export type TeamApplicationRow = JoinApplication;

// ── 形状归一化（后端字段缺失/类型漂移时退化成安全默认值，不把坏数据塞进 UI）──

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

function itemList(data: unknown): Record<string, unknown>[] {
  const body = asRecord(data);
  const items = body?.["items"];
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null);
}

function normalizeMembers(data: unknown): TeamMember[] {
  return itemList(data).flatMap((row) => {
    const id = asNumber(row["user_id"]);
    if (id === null) return [];
    return [
      {
        user_id: id,
        email: asText(row["email"]) ?? "",
        display_name: asText(row["display_name"]) ?? "",
        role: asText(row["role"]) ?? "user",
        is_admin: row["is_admin"] === true,
        console_access: row["console_access"] === true,
      },
    ];
  });
}

function normalizeInvites(data: unknown): TeamInviteRow[] {
  return itemList(data).flatMap((row) => {
    const id = asNumber(row["id"]);
    const token = asText(row["token"]);
    if (id === null || token === null) return [];
    return [
      {
        id,
        token,
        email: asText(row["email"]),
        status: asText(row["status"]) ?? "pending",
        created_at: asText(row["created_at"]),
        expires_at: asText(row["expires_at"]),
        accepted_at: asText(row["accepted_at"]),
      },
    ];
  });
}

function normalizeSubscriptions(data: unknown): TeamSubscriptionRow[] {
  return itemList(data).flatMap((row) => {
    const code = asText(row["code"]);
    if (code === null) return [];
    return [
      {
        code,
        active: row["active"] === true,
        expires_at: asText(row["expires_at"]),
        source: asText(row["source"]),
        created_at: asText(row["created_at"]),
      },
    ];
  });
}

function normalizeApplication(data: unknown): TeamApplicationRow | null {
  const body = asRecord(data);
  const row = body?.["application"];
  const rec = asRecord(row);
  if (!rec) return null;
  const id = asNumber(rec["id"]);
  if (id === null) return null;
  return {
    id,
    team_id: asNumber(rec["team_id"]) ?? 0,
    team_name: asText(rec["team_name"]),
    user_id: asNumber(rec["user_id"]) ?? 0,
    email: asText(rec["email"]) ?? "",
    display_name: asText(rec["display_name"]) ?? "",
    message: asText(rec["message"]),
    status: (asText(rec["status"]) ??
      "pending") as TeamApplicationRow["status"],
    reject_reason: asText(rec["reject_reason"]),
    reviewed_by: asNumber(rec["reviewed_by"]),
    reviewed_at: asText(rec["reviewed_at"]),
    created_at: asText(rec["created_at"]),
  };
}

// ── 通用列表加载 ────────────────────────────────────────────────────────────

export interface TeamListResult<T> {
  items: T[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

function useTeamList<T>(
  path: string | null,
  enabled: boolean,
  normalize: (data: unknown) => T[],
  fallbackError: string,
): TeamListResult<T> {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || path === null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const { data } = await apiClient.get<unknown>(path, { silent: true });
        if (!cancelled) setItems(normalize(data));
      } catch (err) {
        if (!cancelled) {
          setItems([]);
          setError(teamErrorMessage(err, fallbackError));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, enabled, nonce, normalize, fallbackError]);

  return { items, loading, error, reload };
}

export function useTeamMembers(
  teamId: number | null,
  enabled: boolean,
): TeamListResult<TeamMember> {
  return useTeamList<TeamMember>(
    teamId === null ? null : `/teams/${teamId}/members`,
    enabled,
    normalizeMembers,
    "成员列表读取失败（可稍后重试）",
  );
}

export function useTeamInvites(
  teamId: number | null,
  enabled: boolean,
): TeamListResult<TeamInviteRow> {
  return useTeamList<TeamInviteRow>(
    teamId === null ? null : `/teams/${teamId}/invites`,
    enabled,
    normalizeInvites,
    "邀请列表读取失败（可稍后重试）",
  );
}

export function useTeamSubscriptions(
  teamId: number | null,
  enabled: boolean,
): TeamListResult<TeamSubscriptionRow> {
  return useTeamList<TeamSubscriptionRow>(
    teamId === null ? null : `/teams/${teamId}/subscriptions`,
    enabled,
    normalizeSubscriptions,
    "工位订阅读取失败（可稍后重试）",
  );
}

// ── 加入申请（2026-10-22） ─────────────────────────────────────────────────

export function useTeamJoinApplications(
  teamId: number | null,
  enabled: boolean,
  status: "pending" | "approved" | "rejected" | "canceled" | "all" = "pending",
): TeamListResult<TeamApplicationRow> {
  return useTeamList<TeamApplicationRow>(
    teamId === null
      ? null
      : `/teams/${teamId}/join-applications?status=${status}`,
    enabled,
    (data) => {
      const body = asRecord(data);
      const items = Array.isArray(body?.["items"])
        ? (body?.["items"] as unknown[])
        : [];
      return items.flatMap((item) => {
        const app = normalizeApplication({ application: item });
        return app ? [app] : [];
      });
    },
    "加入申请列表读取失败（可稍后重试）",
  );
}

export interface MyJoinApplicationResult {
  application: TeamApplicationRow | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** 我的最近一条加入申请（无团队用户看"审核中"用；没有 → application=null）。 */
export function useMyJoinApplication(
  enabled: boolean,
): MyJoinApplicationResult {
  const [application, setApplication] = useState<TeamApplicationRow | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const { data } = await apiClient.get<unknown>("/me/join-application", {
          silent: true,
        });
        if (!cancelled) setApplication(normalizeApplication(data));
      } catch (err) {
        if (!cancelled) {
          setApplication(null);
          setError(teamErrorMessage(err, "申请状态读取失败（可稍后重试）"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, nonce]);

  return { application, loading, error, reload };
}

/** 审核动作（团队管理员）：通过 / 驳回 / 撤回。失败抛错由调用方转中文。 */
export async function approveJoinApplication(
  teamId: number,
  applicationId: number,
): Promise<void> {
  await apiClient.post(
    `/teams/${teamId}/join-applications/${applicationId}/approve`,
    {},
    { silent: true },
  );
}

export async function rejectJoinApplication(
  teamId: number,
  applicationId: number,
  reason: string | null,
): Promise<void> {
  await apiClient.post(
    `/teams/${teamId}/join-applications/${applicationId}/reject`,
    { reason },
    { silent: true },
  );
}

export async function cancelJoinApplication(
  applicationId: number,
): Promise<void> {
  await apiClient.post(
    `/join-applications/${applicationId}/cancel`,
    {},
    { silent: true },
  );
}
