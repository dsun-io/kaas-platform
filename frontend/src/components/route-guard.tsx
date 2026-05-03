'use client';

import type { ReactNode } from 'react';

interface RouteGuardProps {
  children: ReactNode;
  adminOnly?: boolean;
  fallback?: ReactNode;
}

// Phase 0: hardcoded admin; Phase 1 → session.user.role check
const isAdmin = true;

export function RouteGuard({ children, adminOnly = false, fallback }: RouteGuardProps) {
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
