"use client";

import { useState } from "react";
import Link from "next/link";
import { Users } from "lucide-react";
import { useTenants } from "./hooks/use-tenants";
import { TenantList } from "./components/tenant-list";
import { ReloadButton } from "./components/reload-button";
import { ProductCategories } from "./components/product-categories";
import { AccountManagement } from "./components/account-management";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePageView } from "@/lib/events/use-page-view";
import { RouteGuard } from "@/components/route-guard";
import { PageHeader } from "@/components/shared";
import { useRole } from "@/hooks/use-role";

type Tab = "tenants" | "accounts" | "system";

export default function SettingsPage() {
  usePageView({ resource_id: "/settings" });
  const [tab, setTab] = useState<Tab>("tenants");
  const { data: tenants, isLoading } = useTenants();
  // 账号治理口径：租户 tab 仅平台运营（internal + 管理员）可见。
  // 2026-10-20 对齐后 `RouteGuard adminOnly` 已与后端 `_require_platform_ops` 同口径，
  // 这里的 `isSystemAdmin` 只用于**页内 tab 级**细分（admin 历史角色不显示租户管理）。
  const { isSystemAdmin } = useRole();

  return (
    <RouteGuard adminOnly>
      <div className="space-y-6">
        <PageHeader title="系统设置" description="租户、平台账号与系统操作" />

        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList variant="pills">
            <TabsTrigger variant="pills" value="tenants">
              租户配置
            </TabsTrigger>
            {isSystemAdmin ? (
              <TabsTrigger variant="pills" value="accounts">
                平台账号管理
              </TabsTrigger>
            ) : null}
            <TabsTrigger variant="pills" value="system">
              系统操作
            </TabsTrigger>
          </TabsList>

          {isSystemAdmin ? (
            <TabsContent value="accounts">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle>平台账号管理</CardTitle>
                </CardHeader>
                <CardContent>
                  <AccountManagement />
                </CardContent>
              </Card>
            </TabsContent>
          ) : null}

          <TabsContent value="tenants">
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
                        display_name: t.display_name,
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
          </TabsContent>

          <TabsContent value="system">
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
          </TabsContent>
        </Tabs>

        {/* 团队管理入口：**仅系统管理员**可见（与 /admin/teams 的 adminOnly 同口径）。
            后端 GET /teams 是 ADMIN_ONLY，非管理员即使点到也只会看到 403 —— 不给入口。 */}
        {isSystemAdmin ? (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>团队管理</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  查看所有团队、成员与工位开通情况（仅系统管理员）。
                </p>
                <Link
                  href="/admin/teams"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  <Users className="size-3.5" />
                  进入团队管理
                </Link>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </RouteGuard>
  );
}
