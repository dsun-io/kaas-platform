"use client";

import { useIntelChannels } from "../hooks/use-intel";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Lock, CheckCircle2 } from "lucide-react";

export function ChannelsView() {
  const { data, isLoading, error } = useIntelChannels();

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        加载失败，请稍后重试
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium mb-4">免费渠道</h3>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data?.free_channels?.length ? (
            data.free_channels.map((channel) => (
              <Card key={channel.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{channel.name}</CardTitle>
                    <Badge variant={channel.enabled ? "default" : "secondary"}>
                      <CheckCircle2 className="size-3 mr-1" />
                      {channel.enabled ? "已开通" : "未开通"}
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
            ))
          ) : (
            <p className="text-sm text-muted-foreground col-span-full">
              暂无免费渠道数据
            </p>
          )}
        </div>
      </div>

      <div>
        <h3 className="text-lg font-medium mb-4">付费渠道</h3>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data?.paid_channels?.length ? (
            data.paid_channels.map((channel) => (
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
                    {channel.enabled
                      ? "渠道已启用"
                      : "升级订阅后可使用此数据渠道"}
                  </p>
                </CardContent>
              </Card>
            ))
          ) : (
            <p className="text-sm text-muted-foreground col-span-full">
              暂无付费渠道数据
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
