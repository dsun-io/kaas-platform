'use client';

import { EVENT_PAYLOAD_SCHEMAS, type EventType } from '@contracts/events';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

interface Props {
  event_type: string;
  schema_version: number;
  payload: unknown;
}

export function PayloadRenderer({ event_type, schema_version, payload }: Props) {
  const [loadingOss, setLoadingOss] = useState(false);
  const [ossData, setOssData] = useState<unknown>(null);

  const schemaKey = `${event_type}:${schema_version}` as `${EventType}:${number}`;
  const schema = EVENT_PAYLOAD_SCHEMAS[schemaKey];

  const payloadObj = payload as Record<string, unknown> | null | undefined;

  // OSS key reference — lazy load
  if (payloadObj?._oss_key && !ossData) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Payload 已归档至 OSS: <code className="text-xs">{String(payloadObj._oss_key)}</code>
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={loadingOss}
          onClick={async () => {
            setLoadingOss(true);
            try {
              // In production: fetch presigned GET URL then fetch the payload
              // For Phase 0: simulate with a timeout
              await new Promise((r) => setTimeout(r, 500));
              setOssData({ _loaded: true, _note: 'OSS data placeholder' });
            } finally {
              setLoadingOss(false);
            }
          }}
        >
          {loadingOss && <Loader2 className="mr-1 size-3 animate-spin" />}
          点击加载完整数据
        </Button>
      </div>
    );
  }

  if (!schema) {
    return (
      <pre className="max-h-64 overflow-auto rounded bg-muted p-3 text-xs">
        {JSON.stringify(payload, null, 2)}
      </pre>
    );
  }

  try {
    const def = schema._def as { shape?: () => Record<string, unknown> } | undefined;
    const shape = def?.shape?.();
    const fieldNames = shape ? Object.keys(shape) : [];

    return (
      <dl className="space-y-2">
        {fieldNames.map((field) => {
          const value = payloadObj?.[field];
          const hasValue = value !== undefined && value !== null;
          return (
            <div key={field} className="flex gap-2">
              <dt className="w-36 shrink-0 text-xs font-medium text-muted-foreground">
                {field}
              </dt>
              <dd className="text-xs">
                {hasValue ? (
                  typeof value === 'object' ? (
                    <code className="rounded bg-muted px-1">
                      {JSON.stringify(value)}
                    </code>
                  ) : (
                    String(value)
                  )
                ) : (
                  <span className="italic text-muted-foreground">
                    该字段在 v{schema_version} 之后引入
                  </span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    );
  } catch {
    return (
      <pre className="max-h-64 overflow-auto rounded bg-muted p-3 text-xs">
        {JSON.stringify(payload, null, 2)}
      </pre>
    );
  }
}
