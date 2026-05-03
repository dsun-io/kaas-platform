'use client';

import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Eye } from 'lucide-react';

const EVENT_TYPE_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  'audit.access': 'default',
  'capability.update': 'secondary',
  'chat.turn': 'outline',
  'kb.edit': 'default',
  'quote.request': 'secondary',
  'quote.response': 'outline',
};

interface EventRow {
  id: string;
  event_type: string;
  schema_version: number;
  actor_id: string;
  created_at: string;
  sampled: boolean;
  event_source: string;
}

interface Props {
  events: EventRow[];
  onSelect: (event: EventRow) => void;
  loading?: boolean;
}

function EventRowCell({ event, onSelect }: { event: EventRow; onSelect: (e: EventRow) => void }) {
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{event.id}</TableCell>
      <TableCell>
        <Badge variant={EVENT_TYPE_VARIANT[event.event_type] ?? 'default'}>
          {event.event_type}
        </Badge>
      </TableCell>
      <TableCell className="text-xs">v{event.schema_version}</TableCell>
      <TableCell>
        <Badge variant="outline">{event.event_source}</Badge>
      </TableCell>
      <TableCell className="text-xs">{event.actor_id}</TableCell>
      <TableCell>
        {event.sampled && (
          <Badge variant="secondary" className="text-[10px]">
            sampled
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-xs">
        {new Date(event.created_at).toLocaleString('zh-CN')}
      </TableCell>
      <TableCell>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onSelect(event)}
        >
          <Eye className="size-3" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

export function EventTable({ events, onSelect, loading }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: events.length > 200 ? events.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 10,
  });

  if (loading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        加载中...
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        暂无事件数据
      </div>
    );
  }

  if (events.length <= 200) {
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>事件 ID</TableHead>
            <TableHead>类型</TableHead>
            <TableHead>版本</TableHead>
            <TableHead>来源</TableHead>
            <TableHead>操作人</TableHead>
            <TableHead>采样</TableHead>
            <TableHead>时间</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => (
            <EventRowCell key={event.id} event={event} onSelect={onSelect} />
          ))}
        </TableBody>
      </Table>
    );
  }

  return (
    <div ref={parentRef} style={{ height: '600px', overflow: 'auto' }}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>事件 ID</TableHead>
            <TableHead>类型</TableHead>
            <TableHead>版本</TableHead>
            <TableHead>来源</TableHead>
            <TableHead>操作人</TableHead>
            <TableHead>采样</TableHead>
            <TableHead>时间</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          <tr style={{ height: `${virtualizer.getTotalSize()}px` }}>
            <td style={{ padding: 0 }} colSpan={8}>
              <div style={{ position: 'relative' }}>
                {virtualizer.getVirtualItems().map((virtualItem) => {
                  const event = events[virtualItem.index]!;
                  return (
                    <div
                      key={event.id}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: `${virtualItem.size}px`,
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      <EventRowCell event={event} onSelect={onSelect} />
                    </div>
                  );
                })}
              </div>
            </td>
          </tr>
        </TableBody>
      </Table>
    </div>
  );
}
