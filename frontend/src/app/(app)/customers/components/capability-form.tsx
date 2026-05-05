"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CapabilitySchema } from "@contracts/capabilities";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CapabilityEditor } from "./capability-editor";
import { useUpdateCapability, useSyncJob } from "../hooks/use-capabilities";
import { useCreateEvent } from "@/lib/events/use-create-event";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";

const formSchema = CapabilitySchema;
type FormValues = z.infer<typeof formSchema>;

interface Props {
  customerId: string;
  capability: {
    id: string;
    product_category: string;
    spec_constraints: Record<string, unknown>;
    is_active: boolean;
  };
  onSaved?: () => void;
}

export function CapabilityForm({ customerId, capability, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [constraints, setConstraints] = useState(capability.spec_constraints);
  const [syncJobId, setSyncJobId] = useState<string | null>(null);

  const updateMutation = useUpdateCapability(customerId);
  const { data: syncJob } = useSyncJob(syncJobId);
  const createEvent = useCreateEvent();

  useEffect(() => {
    setConstraints(capability.spec_constraints);
  }, [capability.spec_constraints]);

  useEffect(() => {
    if (syncJob?.status === "done" && syncJobId) {
      setEditing(false);
      setSyncJobId(null);
      onSaved?.();
      createEvent.mutate({
        event_type: "capability.update",
        event_source: "frontend",
        payload: {
          customer_id: customerId,
          product_category: capability.product_category,
          spec_constraints_before: capability.spec_constraints,
          spec_constraints_after: constraints,
          actor_id: "admin-1",
        },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncJob?.status]);

  const handleSave = async () => {
    const result = await updateMutation.mutateAsync({
      id: capability.id,
      spec_constraints: constraints,
    });
    setSyncJobId(result.sync_job_id);
  };

  const handleCancel = () => {
    setConstraints(capability.spec_constraints);
    setEditing(false);
  };

  const syncing = !!(
    syncJobId &&
    syncJob?.status !== "done" &&
    syncJob?.status !== "failed"
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">
            {capability.product_category}
            <Badge
              variant={capability.is_active ? "default" : "secondary"}
              className="ml-2"
            >
              {capability.is_active ? "启用" : "停用"}
            </Badge>
          </CardTitle>
          {!editing ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
            >
              编辑
            </Button>
          ) : (
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCancel}
                disabled={syncing}
              >
                取消
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={handleSave}
                disabled={syncing || updateMutation.isPending}
              >
                {syncing && <Loader2 className="mr-1 size-3 animate-spin" />}
                {syncing ? "同步中…" : "保存"}
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {syncJob?.status === "done" && !editing && (
          <div className="mb-2 flex items-center gap-1 text-xs text-green-600">
            <CheckCircle2 className="size-3" />
            已同步到 L3
          </div>
        )}
        {syncJob?.status === "failed" && (
          <div className="mb-2 flex items-center gap-1 text-xs text-destructive">
            <XCircle className="size-3" />
            同步失败，请重试
          </div>
        )}
        <CapabilityEditor
          constraints={constraints}
          onChange={setConstraints}
          disabled={!editing || syncing}
        />
      </CardContent>
    </Card>
  );
}
