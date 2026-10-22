"use client";

import { isChannelEnabled, useIntelChannels } from "../hooks/use-intel";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingBlock } from "@/components/shared/loading-block";
import { normalizeApiError } from "@/lib/api/api-error";
import { Lock, CheckCircle2 } from "lucide-react";

export function ChannelsView() {
  const { data, isLoading, error, refetch } = useIntelChannels();

  if (isLoading) {
    return <LoadingBlock rows={4} />;
  }

  if (error) {
    return (
      // B3：失败 ≠ 空态；重试直接 refetch 同一查询
      <ErrorState
        title="数据渠道读取失败"
        message={normalizeApiError(error).message}
        onRetry={() => void refetch()}
      />
    );
  }

  const freeChannels = data?.free_channels ?? [];
  const paidChannels = data?.paid_channels ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium mb-4">免费渠道</h3>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {freeChannels.length ? (
            freeChannels.map((channel) => {
              // 后端字段是 `is_enabled`（旧代码读 `enabled` ⇒ free 通道永远"未开通"）
              const on = isChannelEnabled(channel);
              return (
                <Card key={channel.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">
                        {channel.name}
                      </CardTitle>
                      <Badge variant={on ? "default" : "secondary"}>
                        <CheckCircle2 className="size-3 mr-1" />
                        {on ? "已开通" : "未开通"}
                      </Badge>
                    </div>
                    <CardDescription>{channel.type}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      {channel.message || "暂无描述"}
                    </p>
                  </CardContent>
                </Card>
              );
            })
          ) : (
            <div className="col-span-full">
              <EmptyState
                title="暂无免费渠道数据"
                description="后端还没有返回免费渠道清单。"
                className="border-0 py-6"
              />
            </div>
          )}
        </div>
      </div>

      <div>
        <h3 className="text-lg font-medium mb-4">付费渠道</h3>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {paidChannels.length ? (
            paidChannels.map((channel) => (
              <Card key={channel.id} className="opacity-75">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{channel.name}</CardTitle>
                    <Badge variant="secondary">
                      <Lock className="size-3 mr-1" />
                      {channel.message || "未开通"}
                    </Badge>
                  </div>
                  <CardDescription>{channel.type}</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    {isChannelEnabled(channel)
                      ? "渠道已启用"
                      : "升级订阅后可使用此数据渠道"}
                  </p>
                </CardContent>
              </Card>
            ))
          ) : (
            <div className="col-span-full">
              <EmptyState
                title="暂无付费渠道数据"
                description="后端还没有返回付费渠道清单。"
                className="border-0 py-6"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
