"use client";

import { useState } from "react";
import Link from "next/link";
import { KeyRound, Users } from "lucide-react";
import { useTenants } from "./hooks/use-tenants";
import { TenantList } from "./components/tenant-list";
import { ReloadButton } from "./components/reload-button";
import { ProductCategories } from "./components/product-categories";
import { AccountManagement } from "./components/account-management";
import { Badge } from "@/components/ui/badge";
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
        <PageHeader title="系统设置" description="空间、平台账号与系统操作" />

        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList variant="pills">
            <TabsTrigger variant="pills" value="tenants">
              空间配置
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
                  <CardTitle>空间列表</CardTitle>
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
                  <CardTitle>第三方服务密钥</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span>智能助手服务</span>
                      <Badge variant="secondary">已配置</Badge>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>业务数据库</span>
                      <Badge variant="secondary">已配置</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      服务密钥由运维统一配置，这里只显示配置状态，不显示密钥内容。
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>

        {/* 系统对接密钥入口：密钥管理按 created_by 隔离（任何登录用户只能看到/撤销
            自己创建的令牌）；/settings 本身是平台运营页，这里只负责放入口。 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>系统对接密钥</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                给外部系统或自动化工具对接平台用；完整密钥只在创建时显示一次，普通成员不需要。
              </p>
              <Link
                href="/settings/api-tokens"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                <KeyRound className="size-3.5" />
                管理系统对接密钥
              </Link>
            </div>
          </CardContent>
        </Card>

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
