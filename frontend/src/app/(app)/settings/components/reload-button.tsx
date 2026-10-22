"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { normalizeApiError } from "@/lib/api/api-error";
import { useReloadTenants } from "../hooks/use-tenants";
import { useCreateEvent } from "@/lib/events/use-create-event";
import { TenantList } from "./tenant-list";
import { Loader2, RefreshCw } from "lucide-react";
import type { ReloadResult } from "./types";

/**
 * 「重载产品配置」——**全局**动作：刷新所有空间的产品与分类配置。
 *
 * P0-B1 / 审计 A2：原实现点一下直接生效，是整站级变更（会影响所有空间的报价产品），
 * 且失败没有任何反馈（`mutateAsync` 没有 catch ⇒ 未处理的 rejection）。
 * 现在：二次确认 + 提交中禁用（防连点重复重载）+ 失败 toast 如实说明原因。
 */
export function ReloadButton() {
  const reloadMutation = useReloadTenants();
  const createEvent = useCreateEvent();
  const [result, setResult] = useState<ReloadResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // `inFlight` 兜住同一 tick 连点两次（mutation.isPending 要等下一次渲染才生效）
  const inFlight = useRef(false);

  const handleReload = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const data = await reloadMutation.mutateAsync();
      setResult(data);
      setConfirmOpen(false);

      createEvent.mutate({
        event_type: "audit.access",
        event_source: "frontend",
        payload: {
          resource_type: "api",
          resource_id: "admin/tenants/reload",
          actor_id: "admin-1",
          ip: null,
        },
      });
    } catch (err) {
      // 失败如实告诉用户（403 权限 / 网络等），弹窗保持打开可重试
      toast.error(
        `重载失败：${normalizeApiError(err).message || "请稍后重试"}`,
      );
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>重载产品配置</CardTitle>
        <CardDescription>
          重新加载产品配置，刷新所有空间的产品与分类信息。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button
          onClick={() => setConfirmOpen(true)}
          disabled={reloadMutation.isPending}
        >
          {reloadMutation.isPending && (
            <Loader2 className="mr-1 size-4 animate-spin" />
          )}
          <RefreshCw className="mr-1 size-4" />
          重载产品配置
        </Button>

        {result && (
          <div>
            <p className="text-sm text-success mb-2">
              已重载 {result.reloaded_count} 个空间
            </p>
            <TenantList
              tenants={result.active_tenants.map((t) => ({
                ...t,
                is_active: true,
              }))}
            />
          </div>
        )}

        {/* P0-B1/A2：全局危险操作二次确认 */}
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={(next) => {
            if (!next && !reloadMutation.isPending) setConfirmOpen(false);
          }}
          title="重载产品配置？"
          description="该操作会重新加载全部空间的产品与分类配置，影响所有空间正在使用的报价产品清单。请确认当前没有正在进行的配置调整。"
          confirmLabel="确认重载"
          pending={reloadMutation.isPending}
          onConfirm={() => void handleReload()}
        />
      </CardContent>
    </Card>
  );
}
