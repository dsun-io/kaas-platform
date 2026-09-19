"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AppLayout } from "@/components/layout/app-layout";

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
      <AppLayout>{children}</AppLayout>
    </AuthGate>
  );
}
