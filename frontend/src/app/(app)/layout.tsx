"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AppLayout } from "@/components/layout/app-layout";
import { WorkstationGate } from "@/components/workstation-gate";
import { TeamProvider } from "@/lib/team/team-context";

// Client-side replacement for the edge middleware auth redirect (the deployed
// site is a static export where middleware does not run).
//
// 三态判定（2026-10-17 修复「先闪系统 UI 再弹登录」）：
//   authed=null  首帧/判定中 —— 只渲染空壳占位（静态 HTML 也是空壳 ⇒ 无 hydration mismatch）
//   authed=true  有凭据（has_token cookie）—— 才挂载系统 UI
//   无凭据       不置 true，直接 replace 登录页 —— 用户看到的是「空壳 → 登录页」，
//                不会再出现「进系统 → 弹登录」的闪烁。
//
// 为什么不放 useState initializer 同步判：静态导出预渲染跑 initializer 得 true、
// 客户端跑得 false ⇒ hydration mismatch。三态 + effect 判定是静态导出下的标准解。
function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    const hasToken = document.cookie
      .split("; ")
      .some((c) => c === "has_token=1");
    if (!hasToken) {
      const qs = searchParams?.toString();
      const redirect = qs ? `${pathname}?${qs}` : pathname;
      router.replace(`/login?redirect=${encodeURIComponent(redirect)}`);
      return;
    }
    setAuthed(true);
  }, [pathname, searchParams, router]);

  if (!authed) {
    // 判定前的空壳：不是系统 UI（避免闪），也不是死白（有轻提示）
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        正在验证登录状态…
      </div>
    );
  }

  return <AuthGateInner>{children}</AuthGateInner>;
}

function AuthGateInner({ children }: { children: ReactNode }) {
  return (
    <>
      {/* TeamProvider 必须包住 AppLayout：侧边栏/顶栏/守卫共用同一份团队与工位快照，
          否则会出现"入口先出现再消失"，以及未开通工位被弹成通用错误 */}
      <TeamProvider>
        <AppLayout>
          <WorkstationGate>{children}</WorkstationGate>
        </AppLayout>
      </TeamProvider>
    </>
  );
}

export default function AppRouteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthGate>{children}</AuthGate>;
}
