"use client";

/**
 * 设置 → API 令牌（`/settings/api-tokens`）。
 *
 * 入口：`/settings` 页底部的「API 令牌」卡片。
 * 权限：管理端点只认 JWT 会话（后端按 created_by 隔离，不能拿 API token 管理 token），
 * 因此页面不额外加 adminOnly —— 任何登录用户都能管理自己创建的令牌。
 */
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { buttonVariants } from "@/components/ui/button";
import { usePageView } from "@/lib/events/use-page-view";

import { ApiTokensView } from "./components/api-tokens-view";

export default function ApiTokensPage() {
  usePageView({ resource_id: "/settings/api-tokens" });

  return (
    <div className="space-y-6">
      <PageHeader
        title="API 令牌"
        description="创建与管理用于 REST API / MCP 访问的 API 令牌；明文只显示一次。"
        actions={
          <Link
            href="/settings"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <ArrowLeft className="size-3.5" />
            返回设置
          </Link>
        }
      />
      <ApiTokensView />
    </div>
  );
}
