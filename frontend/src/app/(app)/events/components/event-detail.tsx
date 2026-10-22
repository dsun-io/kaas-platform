"use client";

import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PayloadRenderer } from "./payload-renderer";
import { eventSourceLabel, eventTypeLabel } from "./event-labels";

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
  // 原始数据默认折叠：普通查看只需要中文摘要（设计稿 §1/§7）
  const [showRaw, setShowRaw] = useState(false);

  return (
    <Sheet open={!!event} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-auto">
        {event && (
          <>
            <SheetHeader>
              <SheetTitle className="text-base">
                {eventTypeLabel(event.event_type)}
              </SheetTitle>
            </SheetHeader>

            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap gap-2">
                <Badge title={event.event_type}>
                  {eventTypeLabel(event.event_type)}
                </Badge>
                <Badge variant="outline" title={event.event_source}>
                  {eventSourceLabel(event.event_source)}
                </Badge>
                {event.sampled && <Badge variant="secondary">已采样</Badge>}
              </div>

              <Separator />

              <dl className="space-y-2 text-sm">
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-muted-foreground">时间</dt>
                  <dd>{new Date(event.created_at).toLocaleString("zh-CN")}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-muted-foreground">操作人</dt>
                  <dd>{event.actor_id || "—"}</dd>
                </div>
              </dl>

              {!event.sampled && (
                <>
                  <Separator />
                  <div>
                    <h4 className="mb-2 text-sm font-medium">这次发生了什么</h4>
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
                  采样事件不展示完整内容
                </p>
              )}

              <Separator />

              <div className="space-y-2">
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline decoration-dotted underline-offset-2"
                  aria-expanded={showRaw}
                  onClick={() => setShowRaw((value) => !value)}
                >
                  查看详情（一般不需要看）
                </button>
                {showRaw && (
                  <div className="space-y-2 text-xs text-muted-foreground">
                    <dl className="space-y-1">
                      <div className="flex gap-2">
                        <dt className="w-20 shrink-0">事件编号</dt>
                        <dd className="break-all font-mono">{event.id}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-20 shrink-0">格式版本</dt>
                        <dd>v{event.schema_version}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-20 shrink-0">空间</dt>
                        <dd>{event.tenant_id}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-20 shrink-0">会话</dt>
                        <dd className="break-all font-mono">
                          {event.session_id || "—"}
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-20 shrink-0">追踪号</dt>
                        <dd className="break-all font-mono">
                          {event.trace_id || "—"}
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-20 shrink-0">事件代码</dt>
                        <dd className="break-all font-mono">
                          {event.event_type}
                        </dd>
                      </div>
                    </dl>
                    <pre className="max-h-64 overflow-auto rounded bg-muted p-3 font-mono text-[11px] text-foreground">
                      {JSON.stringify(
                        {
                          event_type: event.event_type,
                          schema_version: event.schema_version,
                          event_source: event.event_source,
                          payload: event.payload,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
