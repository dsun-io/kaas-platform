"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { AsyncButton } from "@/components/shared";
import { useAsyncAction } from "@/lib/hooks/use-async-action";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToggleFeatureFlag } from "../hooks/use-feature-flags";
import { useCreateEvent } from "@/lib/events/use-create-event";
import { flagLabel } from "../flag-labels";

interface Props {
  tenantId: string;
  tenantName: string;
  flagKey: string;
  enabled: boolean;
}

export function FlagToggle({ tenantId, tenantName, flagKey, enabled }: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const toggleMutation = useToggleFeatureFlag();
  const createEvent = useCreateEvent();
  /**
   * P0-B2/G1+G2：切换失败原本静默且对话框"卡死"（`mutateAsync` 无 try/catch，
   * `setOpen(false)` 不执行且没有任何说明）。现在：
   * - 失败 → 弹窗内 `role="alert"` 说明原因（拦截器已 toast，不重复 toast），弹窗不关可直接重试；
   * - pending → 确认/取消都禁用、Esc/遮罩不能关（G1 两处标准统一）；
   * - **不做乐观切换**：开关视觉始终来自服务端 `enabled`，失败时天然保持旧值，不存在"看着开了其实没开"。
   */
  const toggle = useAsyncAction(
    async (reasonText: string) => {
      const data = await toggleMutation.mutateAsync({
        tenant_id: tenantId,
        flag_key: flagKey,
        enabled: !enabled,
        reason: reasonText,
        actor_id: "admin-1",
      });

      createEvent.mutate({
        event_type: "audit.access",
        event_source: "frontend",
        payload: {
          resource_type: "api",
          resource_id: `feature_flag/${flagKey}`,
          actor_id: "admin-1",
          ip: null,
        },
      });

      return data;
    },
    {
      onSuccess: () => {
        toast.success(
          `已${enabled ? "关闭" : "开启"}${flagLabel(flagKey)}（${tenantName}）`,
        );
        setOpen(false);
        setReason("");
      },
    },
  );

  const handleConfirm = () => {
    if (!reason.trim()) return;
    void toggle.run(reason.trim());
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <CardTitle className="text-sm">{tenantName}</CardTitle>
          </div>
          <Badge variant={enabled ? "default" : "secondary"}>
            {flagLabel(flagKey)}：{enabled ? "已开启" : "已关闭"}
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <div
              className={`h-3 w-3 rounded-full ${enabled ? "bg-success" : "bg-gray-300"}`}
            />
            <span className="text-xs text-muted-foreground">
              {enabled ? "已启用" : "已关闭"}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => setOpen(true)}
              disabled={toggle.pending}
            >
              {toggle.pending ? "切换中…" : "切换"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={open}
        onOpenChange={(v) => {
          // pending 期间不允许关窗（G1：确认弹窗也要有 pending 禁用）
          if (!v && !toggle.pending) setOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认切换灰度开关</DialogTitle>
            <DialogDescription>
              {flagLabel(flagKey)}：
              {enabled ? "已开启 → 将关闭" : "已关闭 → 将开启"}
              <br />
              空间：{tenantName}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium">变更原因（必填）</label>
            <Input
              placeholder="请输入变更原因..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {toggle.error ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              切换失败：{toggle.error}（开关保持原状态，可修正后重试）
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={toggle.pending}
            >
              取消
            </Button>
            <AsyncButton
              variant="default"
              size="sm"
              onClick={handleConfirm}
              disabled={!reason.trim()}
              pending={toggle.pending}
              pendingLabel="切换中…"
            >
              确认
            </AsyncButton>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
