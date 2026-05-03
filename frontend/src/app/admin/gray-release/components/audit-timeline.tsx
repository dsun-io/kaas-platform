'use client';

import { Badge } from '@/components/ui/badge';

interface AuditEntry {
  id: string;
  action: string;
  actor_id: string;
  flag_key: string;
  enabled_before: boolean;
  enabled_after: boolean;
  reason: string;
  timestamp: string;
}

interface Props {
  entries: AuditEntry[];
  loading?: boolean;
}

export function AuditTimeline({ entries, loading }: Props) {
  if (loading) {
    return <div className="py-4 text-center text-sm text-muted-foreground">加载中...</div>;
  }

  return (
    <div className="relative border-l pl-6 space-y-4">
      {entries.map((entry) => (
        <div key={entry.id} className="relative">
          <div className="absolute -left-[calc(1.5rem+2px)] top-1 h-2 w-2 rounded-full bg-border" />
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">{entry.flag_key}</Badge>
            <span className="text-xs">
              {entry.enabled_before ? 'ON' : 'OFF'} → {entry.enabled_after ? 'ON' : 'OFF'}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{entry.reason}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {entry.actor_id} · {new Date(entry.timestamp).toLocaleString('zh-CN')}
          </p>
        </div>
      ))}
    </div>
  );
}
