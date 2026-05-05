"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { useReloadTenants } from "../hooks/use-tenants";
import { useCreateEvent } from "@/lib/events/use-create-event";
import { TenantList } from "./tenant-list";
import { Loader2, RefreshCw } from "lucide-react";
import type { ReloadResult } from "./types";

export function ReloadButton() {
  const reloadMutation = useReloadTenants();
  const createEvent = useCreateEvent();
  const [result, setResult] = useState<ReloadResult | null>(null);

  const handleReload = async () => {
    const data = await reloadMutation.mutateAsync();
    setResult(data);

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
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>重载租户配置</CardTitle>
        <CardDescription>
          重新加载所有租户的 YAML 配置，刷新缓存中的租户信息。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button onClick={handleReload} disabled={reloadMutation.isPending}>
          {reloadMutation.isPending && (
            <Loader2 className="mr-1 size-4 animate-spin" />
          )}
          <RefreshCw className="mr-1 size-4" />
          重载租户配置
        </Button>

        {result && (
          <div>
            <p className="text-sm text-green-600 mb-2">
              已重载 {result.reloaded_count} 个租户
            </p>
            <TenantList
              tenants={result.active_tenants.map((t) => ({
                ...t,
                is_active: true,
              }))}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
