"use client";

import { useState } from "react";
import { useTenants } from "./hooks/use-tenants";
import { TenantList } from "./components/tenant-list";
import { ReloadButton } from "./components/reload-button";
import { ProductCategories } from "./components/product-categories";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { usePageView } from "@/lib/events/use-page-view";
import { RouteGuard } from "@/components/route-guard";

type Tab = "tenants" | "system";

export default function SettingsPage() {
  usePageView({ resource_id: "/settings" });
  const [tab, setTab] = useState<Tab>("tenants");
  const { data: tenants, isLoading } = useTenants();

  return (
    <RouteGuard adminOnly>
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">系统设置</h1>

        <div className="flex gap-1 rounded-lg border p-0.5 w-full sm:w-fit">
          {[
            { key: "tenants" as Tab, label: "租户配置" },
            { key: "system" as Tab, label: "系统操作" },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                tab === t.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "tenants" && (
          <div className="space-y-6">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle>租户列表</CardTitle>
              </CardHeader>
              <CardContent>
                <TenantList
                  tenants={
                    tenants?.map((t) => ({
                      tenant_id: t.tenant_id,
                      display_name: t.name,
                      locale: "zh-CN",
                      region: "cn-north",
                      is_active: t.is_active,
                    })) ?? []
                  }
                  loading={isLoading}
                />
              </CardContent>
            </Card>
            <ProductCategories />
          </div>
        )}

        {tab === "system" && (
          <div className="space-y-6">
            <ReloadButton />
            <Card>
              <CardHeader>
                <CardTitle>API 密钥引用</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1 text-sm">
                  <p className="font-mono text-xs text-muted-foreground">
                    ENV:FASTGPT_API_KEY_LIANJIA
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    ENV:DB_DSN_LIANJIA
                  </p>
                  <p className="text-xs text-muted-foreground mt-2">
                    密钥通过环境变量注入，不在此页面显示明文。
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </RouteGuard>
  );
}
