"use client";

import { EVENT_PAYLOAD_SCHEMAS, type EventType } from "@contracts/events";

interface Props {
  event_type: string;
  schema_version: number;
  payload: unknown;
}

export function PayloadRenderer({
  event_type,
  schema_version,
  payload,
}: Props) {
  const schemaKey =
    `${event_type}:${schema_version}` as `${EventType}:${number}`;
  const schema = EVENT_PAYLOAD_SCHEMAS[schemaKey];

  const payloadObj = payload as Record<string, unknown> | null | undefined;

  if (!schema) {
    return (
      <pre className="max-h-64 overflow-auto rounded bg-muted p-3 text-xs">
        {JSON.stringify(payload, null, 2)}
      </pre>
    );
  }

  // React 19 lint（react-hooks）：JSX 不能放进 try/catch（catch 会吞掉渲染期错误）。
  // 这里只把「可能抛错的 zod schema 解析」放进 try，JSX 在 catch 之后统一构造。
  let fieldNames: string[] | null = null;
  try {
    const def = schema._def as
      | { shape?: () => Record<string, unknown> }
      | undefined;
    const shape = def?.shape?.();
    fieldNames = shape ? Object.keys(shape) : [];
  } catch {
    fieldNames = null;
  }

  if (fieldNames === null) {
    return (
      <pre className="max-h-64 overflow-auto rounded bg-muted p-3 text-xs">
        {JSON.stringify(payload, null, 2)}
      </pre>
    );
  }

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
                typeof value === "object" ? (
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
}
