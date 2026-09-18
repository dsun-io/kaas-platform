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
import { Button } from "@/components/ui/button";
import { Lock } from "lucide-react";

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
      {data?.message && (
        <div className="rounded-md bg-muted p-4 text-sm text-muted-foreground">
          {data.message}
        </div>
      )}

      <div>
        <h3 className="text-lg font-medium mb-4">免费渠道</h3>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data?.free_channels?.map((channel) => (
            <Card key={channel.id}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">
                    {channel.channel_name}
                  </CardTitle>
                  <Badge variant="default">免费</Badge>
                </div>
                <CardDescription>{channel.channel_code}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {channel.description || "暂无描述"}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-lg font-medium mb-4">付费渠道</h3>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data?.paid_channels?.map((channel) => (
            <Card key={channel.id} className="opacity-75">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">
                    {channel.channel_name}
                  </CardTitle>
                  <Badge variant="secondary">
                    <Lock className="size-3 mr-1" />
                    未开通
                  </Badge>
                </div>
                <CardDescription>{channel.channel_code}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-3">
                  {channel.description || "升级订阅后可使用"}
                </p>
                <Button variant="outline" size="sm" disabled>
                  升级订阅解锁
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
