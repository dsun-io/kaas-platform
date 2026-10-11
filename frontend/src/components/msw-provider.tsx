"use client";

import { useEffect, useRef } from "react";
import { isMockMode } from "@/lib/api/config";

let globalStarted = false;

export function MswProvider({ children }: { children: React.ReactNode }) {
  const started = useRef(false);

  useEffect(() => {
    if (!isMockMode || started.current) return;
    started.current = true;

    if (globalStarted) return;
    globalStarted = true;

    import("@/mocks/browser")
      // `bypass` → `warn`：**放行行为不变**，但会在控制台**打印缺口**。
      // 原先用 bypass 时 handler 缺失是**静默**的：请求放行 → 打到真后端
      // （e2e 里 :8000 无人听）→ 页面只剩外壳，看起来像产品缺陷。
      // 2026-10-11 定位 e2e 失败时，正是靠这一步才看清哪些端点没有 mock
      // （如 /teams/me、/me/workstations）。
      .then((m) => m.worker.start({ onUnhandledRequest: "warn" }))
      .catch(() => {
        // MSW init failure in non-mock builds is expected — ignore silently
      });
  }, []);

  return <>{children}</>;
}
