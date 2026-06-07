"use client";

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Settings, Plus, Activity } from "lucide-react";

interface PlatformConfig {
  id: number;
  platform_display_name: string;
  api_endpoint: string;
  is_enabled: boolean;
  is_primary: boolean;
  health_check_status?: string;
  daily_quota?: number;
  daily_used_count: number;
}

export default function InvoicePlatformsPage() {
  const [platforms] = useState<PlatformConfig[]>([
    {
      id: 1,
      platform_display_name: "百望云",
      api_endpoint: "https://api.baiwang.com/v1",
      is_enabled: true,
      is_primary: true,
      health_check_status: "ok",
      daily_quota: 1000,
      daily_used_count: 42,
    },
    {
      id: 2,
      platform_display_name: "航天信息",
      api_endpoint: "https://api.aisino.com/v2",
      is_enabled: true,
      is_primary: false,
      health_check_status: "ok",
      daily_quota: 500,
      daily_used_count: 8,
    },
  ]);

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Settings className="size-6" />
            开票平台配置
          </h1>
          <p className="text-muted-foreground mt-1">
            管理开票平台对接配置，支持多平台切换与配额监控
          </p>
        </div>
        <Button>
          <Plus className="size-4 mr-1" />
          新增平台
        </Button>
      </div>

      <div className="grid gap-4">
        {platforms.map((p) => (
          <Card key={p.id}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold">
                      {p.platform_display_name}
                    </span>
                    {p.is_primary && <Badge variant="default">主平台</Badge>}
                    {p.is_enabled ? (
                      <Badge variant="outline" className="text-green-600">
                        启用
                      </Badge>
                    ) : (
                      <Badge variant="secondary">停用</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {p.api_endpoint}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-sm text-muted-foreground">日配额使用</p>
                    <p className="text-sm font-medium">
                      {p.daily_used_count} / {p.daily_quota || "∞"}
                    </p>
                  </div>
                  <Button size="sm" variant="outline">
                    <Activity className="size-4 mr-1" />
                    健康检查
                  </Button>
                  <Button size="sm" variant="outline">
                    编辑
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
