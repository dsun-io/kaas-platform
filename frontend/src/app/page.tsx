"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { useAuth } from "@/lib/auth/auth-context";

/**
 * 登录落点 —— 按角色落到有业务价值的页面，而不是指标废页 /dashboard：
 * - 无凭据（无 has_token cookie）→ **直接** /login（首帧判定，不闪系统 UI）；
 * - internal 员工（含 system_admin）→ 「客户管理」/customers（业务主入口：客户+询盘一体）；
 * - customer 账号 → 产品目录 /products。
 *
 * 静态导出约束：不能用 server redirect()/middleware，只能客户端 replace
 * （先例：settings/tenant-products 页）。本页在 AuthProvider 之下（root layout），
 * 可直接 useAuth。
 */
export default function Home() {
  const { user, isLoading, isAuthenticated } = useAuth();
  const router = useRouter();
  // 首帧同步判定 cookie（effects 之后才跑，会先渲染再跳 —— 就是"先闪系统"的根源）
  const [hasCookie] = useState(() => {
    if (typeof document === "undefined") return true; // 静态预渲染占位
    return document.cookie.split("; ").some((c) => c === "has_token=1");
  });

  useEffect(() => {
    if (!hasCookie) {
      router.replace("/login");
      return;
    }
    if (isLoading) return;
    if (!isAuthenticated || !user) {
      router.replace("/login");
      return;
    }
    router.replace(
      (user.account_type === "internal" ? "/customers" : "/products") as Route,
    );
  }, [hasCookie, isLoading, isAuthenticated, user, router]);

  // 路由决定前的占位（避免白屏闪烁）
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      正在进入…
    </div>
  );
}
