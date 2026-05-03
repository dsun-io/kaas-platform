'use client';

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { PayloadRenderer } from './payload-renderer';

interface EventDetail {
  id: string;
  event_type: string;
  schema_version: number;
  tenant_id: string;
  actor_id: string;
  session_id: string;
  trace_id: string;
  event_source: string;
  payload: unknown;
  created_at: string;
  sampled: boolean;
}

interface Props {
  event: EventDetail | null;
  onClose: () => void;
}

export function EventDetailSheet({ event, onClose }: Props) {
  return (
    <Sheet open={!!event} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-auto">
        {event && (
          <>
            <SheetHeader>
              <SheetTitle className="font-mono text-sm">{event.id}</SheetTitle>
            </SheetHeader>

            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap gap-2">
                <Badge>{event.event_type}</Badge>
                <Badge variant="secondary">v{event.schema_version}</Badge>
                <Badge variant="outline">{event.event_source}</Badge>
                {event.sampled && (
                  <Badge variant="secondary">已采样</Badge>
                )}
              </div>

              <Separator />

              <dl className="space-y-2 text-sm">
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-muted-foreground">租户</dt>
                  <dd>{event.tenant_id}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-muted-foreground">操作人</dt>
                  <dd>{event.actor_id}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-muted-foreground">会话</dt>
                  <dd className="font-mono text-xs">{event.session_id}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-muted-foreground">Trace</dt>
                  <dd className="font-mono text-xs">{event.trace_id}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-muted-foreground">时间</dt>
                  <dd>{new Date(event.created_at).toLocaleString('zh-CN')}</dd>
                </div>
              </dl>

              {!event.sampled && (
                <>
                  <Separator />
                  <div>
                    <h4 className="mb-2 text-sm font-medium">Payload</h4>
                    <PayloadRenderer
                      event_type={event.event_type}
                      schema_version={event.schema_version}
                      payload={event.payload}
                    />
                  </div>
                </>
              )}

              {event.sampled && (
                <p className="text-xs text-muted-foreground italic">
                  采样事件不展示完整 trace 数据
                </p>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
