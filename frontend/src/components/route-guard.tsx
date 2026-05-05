"use client";

import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth/auth-context";

interface RouteGuardProps {
  children: ReactNode;
  adminOnly?: boolean;
  fallback?: ReactNode;
}

export function RouteGuard({
  children,
  adminOnly = false,
  fallback,
}: RouteGuardProps) {
  const { user } = useAuth();
  const isAdmin = user?.account_type === "internal";

  if (adminOnly && !isAdmin) {
    return (
      fallback ?? (
        <div className="py-16 text-center text-muted-foreground">
          您没有访问此页面的权限
        </div>
      )
    );
  }

  return <>{children}</>;
}
