"use client";

import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

/**
 * 工位开通 / 撤销面板（仅团队管理员可见）。
 *
 * 契约上最容易踩的一个坑：`PUT /teams/{id}/subscriptions/{code}` 的成功响应
 * **只有 4 个字段**（`code/active/expires_at/source`）—— 没有 `created_at`。
 * 所以这里**绝不拿 PUT 的响应去渲染列表**：写完一律重新 `GET` 列表（列表才带完整字段），
 * 同时让 TeamProvider 重拉 `/me/workstations`，让侧边栏与路由守卫立刻生效
 * （否则会出现"管理员开通了，自己却还要等 30 秒才能用"）。
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertCircle, Check, Power, RefreshCw, X } from "lucide-react";

import apiClient from "@/lib/api/client";
import { teamErrorMessage } from "@/lib/team/team-errors";
import { subscribableWorkstationOptions } from "@/lib/workstation/visibility";
import { useTeam } from "@/lib/team/team-context";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";

import {
  useTeamSubscriptions,
  type TeamSubscriptionRow,
} from "../hooks/use-team-admin";

interface TeamSubscriptionsPanelProps {
  teamId: number;
}

/** 来源 → 中文（让人一眼看出"谁在什么时候开的"） */
const SOURCE_LABEL: Record<string, string> = {
  manual: "后台开通",
  signup: "注册时开通",
  system_migration: "存量迁移",
  bundle: "套餐附带",
};

function formatTime(value: string | null): string {
  if (!value) return "永久有效";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

export function TeamSubscriptionsPanel({
  teamId,
}: TeamSubscriptionsPanelProps) {
  const { items, loading, error, reload } = useTeamSubscriptions(teamId, true);
  const { refresh } = useTeam();
  const [pending, setPending] = useState<string | null>(null);

  const byCode = useMemo(() => {
    const map = new Map<string, TeamSubscriptionRow>();
    for (const row of items) map.set(row.code, row);
    return map;
  }, [items]);

  const bundleActive = byCode.get("full_chain")?.active === true;
  const stations = subscribableWorkstationOptions();

  /** 开通（PUT body 只给 active；不传 expires_at = 永久有效） */
  async function enable(code: string, label: string) {
    setPending(code);
    try {
      await apiClient.put(
        `/teams/${teamId}/subscriptions/${code}`,
        { active: true },
        { silent: true },
      );
      toast.success(`已开通「${label}」`);
      reload();
      await refresh(); // 让侧边栏/守卫立刻看到新状态
    } catch (err: unknown) {
      toast.error(teamErrorMessage(err, "开通失败，请稍后重试"));
    } finally {
      setPending(null);
    }
  }

  /** 撤销（后端只把 active 置 false，保留行便于审计"曾经开过"） */
  async function disable(code: string, label: string) {
    setPending(code);
    try {
      await apiClient.delete(`/teams/${teamId}/subscriptions/${code}`, {
        silent: true,
      });
      toast.success(`已停用「${label}」`);
      reload();
      await refresh();
    } catch (err: unknown) {
      toast.error(teamErrorMessage(err, "停用失败，请稍后重试"));
    } finally {
      setPending(null);
    }
  }

  return (
    <SectionCard
      title="工位开通"
      description="开通后全团队可用（个人还可由平台管理员额外开通）。未开通的工位接口返回 404，入口也不会出现。"
      action={
        <Button size="sm" variant="ghost" onClick={reload}>
          <RefreshCw className="mr-1 size-3.5" />
          刷新
        </Button>
      }
    >
      {loading ? (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : error ? (
        <div className="flex flex-col items-start gap-2 py-4 text-sm">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="size-4" />
            {error}
          </div>
          <Button size="sm" variant="outline" onClick={reload}>
            重试
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {bundleActive && (
            <p className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              当前已开通「全工位套餐」，下面每个工位都可用。如需按工位精细控制，
              先停用套餐再逐个开通。
            </p>
          )}

          <div className="overflow-x-auto">
            <Table className="w-full text-sm">
              <TableHeader>
                <TableRow className="border-b text-left text-muted-foreground">
                  <TableHead scope="col" className="p-2">
                    工位
                  </TableHead>
                  <TableHead scope="col" className="p-2">
                    状态
                  </TableHead>
                  <TableHead scope="col" className="p-2">
                    到期
                  </TableHead>
                  <TableHead scope="col" className="p-2">
                    来源
                  </TableHead>
                  <TableHead scope="col" className="p-2">
                    操作
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* 套餐行：一条顶九条，管理员常用的"全开"入口 */}
                <TableRow className="border-b bg-muted/20">
                  <TableCell className="p-2 font-medium">全工位套餐</TableCell>
                  <TableCell className="p-2">
                    {bundleActive ? (
                      <StatusBadge tone="success">已开通</StatusBadge>
                    ) : (
                      <StatusBadge tone="default">未开通</StatusBadge>
                    )}
                  </TableCell>
                  <TableCell className="p-2 text-muted-foreground">
                    {formatTime(byCode.get("full_chain")?.expires_at ?? null)}
                  </TableCell>
                  <TableCell className="p-2 text-muted-foreground">
                    {SOURCE_LABEL[byCode.get("full_chain")?.source ?? ""] ??
                      "—"}
                  </TableCell>
                  <TableCell className="p-2">
                    {bundleActive ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending === "full_chain"}
                        onClick={() => void disable("full_chain", "全工位套餐")}
                      >
                        <X className="mr-1 size-3.5" />
                        停用
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending === "full_chain"}
                        onClick={() => void enable("full_chain", "全工位套餐")}
                      >
                        <Power className="mr-1 size-3.5" />
                        开通
                      </Button>
                    )}
                  </TableCell>
                </TableRow>

                {stations.map((station) => {
                  const row = byCode.get(station.key);
                  const active = row?.active === true;
                  const viaBundle = !active && bundleActive;
                  return (
                    <TableRow
                      key={station.key}
                      className="border-b last:border-0 hover:bg-muted/40"
                    >
                      <TableCell className="p-2">
                        <div className="font-medium">{station.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {station.key}
                        </div>
                      </TableCell>
                      <TableCell className="p-2">
                        {active ? (
                          <StatusBadge tone="success">
                            <Check className="mr-1 size-3" />
                            已开通
                          </StatusBadge>
                        ) : viaBundle ? (
                          <StatusBadge tone="info">套餐内含</StatusBadge>
                        ) : (
                          <StatusBadge tone="default">未开通</StatusBadge>
                        )}
                      </TableCell>
                      <TableCell className="p-2 text-muted-foreground">
                        {active ? formatTime(row?.expires_at ?? null) : "—"}
                      </TableCell>
                      <TableCell className="p-2 text-muted-foreground">
                        {active
                          ? (SOURCE_LABEL[row?.source ?? ""] ?? "—")
                          : "—"}
                      </TableCell>
                      <TableCell className="p-2">
                        {active ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending === station.key}
                            onClick={() =>
                              void disable(station.key, station.name)
                            }
                          >
                            <X className="mr-1 size-3.5" />
                            停用
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending === station.key}
                            onClick={() =>
                              void enable(station.key, station.name)
                            }
                          >
                            <Power className="mr-1 size-3.5" />
                            开通
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <p className="text-xs text-muted-foreground">
            停用只是把订阅置为失效（保留历史记录），随时可以再开通；已产生的业务数据不受影响。
          </p>
        </div>
      )}
    </SectionCard>
  );
}
