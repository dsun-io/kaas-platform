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
      .then((m) => m.worker.start({ onUnhandledRequest: "bypass" }))
      .catch(() => {
        // MSW init failure in non-mock builds is expected — ignore silently
      });
  }, []);

  return <>{children}</>;
}
