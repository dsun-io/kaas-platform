'use client';

import { useEffect, useRef } from 'react';
import { useCreateEvent } from './use-create-event';

interface PageViewOptions {
  resource_id: string;
  actor_id?: string;
}

export function usePageView({ resource_id, actor_id = 'admin-1' }: PageViewOptions) {
  const createEvent = useCreateEvent();
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;

    createEvent.mutate({
      event_type: 'audit.access',
      event_source: 'frontend',
      payload: {
        resource_type: 'page',
        resource_id,
        actor_id,
        ip: null,
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource_id, actor_id]);
}
