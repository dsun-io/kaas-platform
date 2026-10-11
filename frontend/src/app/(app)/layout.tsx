"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AppLayout } from "@/components/layout/app-layout";
import { WorkstationGate } from "@/components/workstation-gate";
import { TeamProvider } from "@/lib/team/team-context";

// Client-side replacement for the edge middleware auth redirect (the deployed
// site is a static export where middleware does not run).
function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    const hasToken = document.cookie
      .split("; ")
      .some((c) => c === "has_token=1");
    if (!hasToken) {
      const qs = searchParams?.toString();
      const redirect = qs ? `${pathname}?${qs}` : pathname;
      router.replace(`/login?redirect=${encodeURIComponent(redirect)}`);
    }
  }, [pathname, searchParams, router]);

  return <>{children}</>;
}

export default function AppRouteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGate>
      {/* TeamProvider 必须包住 AppLayout：侧边栏/顶栏/守卫共用同一份团队与工位快照，
          否则会出现"入口先出现再消失"，以及未开通工位被弹成通用错误 */}
      <TeamProvider>
        <AppLayout>
          <WorkstationGate>{children}</WorkstationGate>
        </AppLayout>
      </TeamProvider>
    </AuthGate>
  );
}
