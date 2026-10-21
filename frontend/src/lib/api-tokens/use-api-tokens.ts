"use client";

/**
 * API 令牌管理数据层（W5 M1）。
 *
 * 契约（以 `backend/ts-worker/src/routes/api-tokens.ts` 为准）：
 * - `GET /api-tokens` → `{items:[{id,name,prefix,scopes,created_at,last_used_at,expires_at,revoked_at}],total}`
 * - `POST /api-tokens` body `{name,scopes[],expires_in_days?}` → 201 `{...token,plaintext}`
 *   —— **plaintext 只在此响应出现一次**，前端不缓存、不写 localStorage。
 * - `DELETE /api-tokens/{id}` → 200 `{revoked:true,id,revoked_at}`；重复撤销 409
 *   TOKEN_ALREADY_REVOKED。
 *
 * 管理端点只认 JWT 会话（API token 不能管理 token，防自举提权），
 * 因此这里不带 API token 逻辑，axios 会照常注入 UI 会话的 Bearer。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

export interface ApiToken {
  id: number;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

/** 创建响应：明文只在这里出现一次。 */
export interface CreatedApiToken extends ApiToken {
  plaintext: string;
}

export interface ApiTokensResult {
  items: ApiToken[];
  total: number;
}

export interface CreateApiTokenInput {
  name: string;
  scopes: string[];
  /** 省略 = 永不过期（后端 max 3650 天）。 */
  expires_in_days?: number;
}

export interface RevokedApiToken {
  revoked: boolean;
  id: number;
  revoked_at: string | null;
}

export const apiTokenKeys = {
  all: ["api-tokens"] as const,
  list: () => ["api-tokens", "list"] as const,
};

/** 形状归一化：坏行直接丢弃，不让 `undefined` 进渲染。 */
function normalizeToken(raw: unknown): ApiToken | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const id = Number(row.id);
  const name = typeof row.name === "string" ? row.name : "";
  if (!Number.isInteger(id) || id <= 0 || name.trim() === "") return null;
  const scopes = Array.isArray(row.scopes)
    ? row.scopes
        .map((scope) => (typeof scope === "string" ? scope : ""))
        .filter((scope) => scope !== "")
    : [];
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value : null;
  return {
    id,
    name,
    prefix: text(row.prefix) ?? "",
    scopes: Array.from(new Set(scopes)),
    created_at: text(row.created_at),
    last_used_at: text(row.last_used_at),
    expires_at: text(row.expires_at),
    revoked_at: text(row.revoked_at),
  };
}

export function useApiTokens() {
  return useQuery({
    queryKey: apiTokenKeys.list(),
    queryFn: async (): Promise<ApiTokensResult> => {
      const { data } = await apiClient.get<{
        items?: unknown[];
        total?: number;
      }>("/api-tokens", { silent: true });
      const payload = data ?? {};
      const items = (payload.items ?? []).flatMap((raw) => {
        const token = normalizeToken(raw);
        return token ? [token] : [];
      });
      const total =
        typeof payload.total === "number" && Number.isFinite(payload.total)
          ? payload.total
          : items.length;
      return { items, total };
    },
    // 列表不会高频变化；创建/撤销后 mutation 会显式 invalidate。
    staleTime: 15_000,
    retry: 1,
  });
}

export function useCreateApiToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateApiTokenInput) => {
      const { data } = await apiClient.post<CreatedApiToken>(
        "/api-tokens",
        input,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: apiTokenKeys.all });
    },
  });
}

export function useRevokeApiToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: number) => {
      const { data } = await apiClient.delete<RevokedApiToken>(
        `/api-tokens/${id}`,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: apiTokenKeys.all });
    },
  });
}
