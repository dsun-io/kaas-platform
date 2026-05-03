'use client';

import { useEffect, useState } from 'react';
import { isMockMode } from '@/lib/api/config';

export function MswProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(!isMockMode);

  useEffect(() => {
    if (isMockMode) {
      setReady(false);
      import('@/mocks/browser')
        .then((m) => m.worker.start({ onUnhandledRequest: 'bypass' }))
        .finally(() => setReady(true));
    }
  }, []);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground text-sm">
        Loading mock service...
      </div>
    );
  }

  return <>{children}</>;
}
