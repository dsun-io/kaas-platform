"use client";

import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
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

  const handleConfirm = async () => {
    await toggleMutation.mutateAsync({
      tenant_id: tenantId,
      flag_key: flagKey,
      enabled: !enabled,
      reason,
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

    setOpen(false);
    setReason("");
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <CardTitle className="text-sm">{tenantName}</CardTitle>
            <p className="text-xs text-muted-foreground font-mono">
              {tenantId}
            </p>
          </div>
          <Badge variant={enabled ? "default" : "secondary"}>
            {flagKey}: {enabled ? "ON" : "OFF"}
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <div
              className={`h-3 w-3 rounded-full ${enabled ? "bg-green-500" : "bg-gray-300"}`}
            />
            <span className="text-xs text-muted-foreground">
              {enabled ? "已启用" : "已关闭"}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => setOpen(true)}
              disabled={toggleMutation.isPending}
            >
              {toggleMutation.isPending ? "切换中…" : "切换"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认切换灰度开关</DialogTitle>
            <DialogDescription>
              {flagKey}: {enabled ? "ON → OFF" : "OFF → ON"}
              <br />
              租户: {tenantName} ({tenantId})
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
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleConfirm}
              disabled={!reason.trim()}
            >
              确认
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
