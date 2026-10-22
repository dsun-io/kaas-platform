"use client";

import type { ReactNode } from "react";
import Link from "next/link";

import { ErrorState } from "@/components/shared/error-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth/auth-context";

/**
 * 平台运营 = internal 账号 + 管理员角色。
 *
 * 与后端 `main.py:160-174 _require_platform_ops`、`ws_admin_proposals.py:34`、
 * `kaas_common.workstation.scope.is_admin_role` 同口径（`admin` 是历史角色，等价
 * `system_admin`）。角色来自登录态 `/auth/me` 的 `role` 字段（`buildUser()` 保留原值）——
 * 不额外发请求，避免守卫在首屏多打一次接口。
 */
export function isPlatformOperator(
  user:
    | {
        account_type?: string | null;
        role?: string | null;
      }
    | null
    | undefined,
): boolean {
  if (!user || user.account_type !== "internal") return false;
  return user.role === "system_admin" || user.role === "admin";
}

interface RouteGuardProps {
  children: ReactNode;
  /**
   * 平台运营页（internal **且** 管理员角色）—— 与后端平台闸门同口径。
   *
   * 2026-10-20 前后端对齐审计（P2-6）：此前只判 `account_type === "internal"`，
   * 比后端宽一层 ⇒ internal 非管理员能打开 /audit-log、/events、/admin/gray-release、
   * /settings，随后接口 403。**前端隐藏不是权限边界，但也不该把"注定 403 的页面"给出去。**
   */
  adminOnly?: boolean;
  /**
   * 仅内部账号可见（**不**要求管理员角色）。
   *
   * 给"后端没有平台运营闸门、只需内部账号可达"的页面留的入口：`adminOnly`
   * 收紧到「internal + 管理员」后，这类页面若继续用 `adminOnly` 会被误伤。
   * 当前没有页面启用（/kb 属此类，但它的目录不在本次改动范围，未改成 internalOnly）。
   */
  internalOnly?: boolean;
  fallback?: ReactNode;
}

export function RouteGuard({
  children,
  adminOnly = false,
  internalOnly = false,
  fallback,
}: RouteGuardProps) {
  const { user } = useAuth();
  const allowed =
    (!adminOnly || isPlatformOperator(user)) &&
    (!internalOnly || user?.account_type === "internal");

  if (!allowed) {
    return (
      fallback ?? (
        // A1（U-P0B5）：无权限不是"死白一行字" —— 保留页头 + 说明 + 返回入口，
        // 让用户知道被什么挡住、下一步去哪（而不是以为页面坏了）。
        <div className="space-y-6">
          <PageHeader
            title="无权限访问"
            description="当前账号没有访问该页面的权限。"
          />
          <ErrorState
            title="没有访问权限"
            message="您没有访问此页面的权限。该能力按账号角色开放；如确需使用，请联系平台管理员为你的账号开通对应角色。"
          />
          <div>
            <Link href="/">
              <Button variant="outline">返回工作台</Button>
            </Link>
          </div>
        </div>
      )
    );
  }

  return <>{children}</>;
}
