"use client";

import { EVENT_PAYLOAD_SCHEMAS, type EventType } from "@contracts/events";
import { payloadFieldLabel, payloadValueText } from "./event-labels";

interface Props {
  event_type: string;
  schema_version: number;
  payload: unknown;
}

/**
 * 事件内容摘要（中文内容项 + 人话取值）。
 *
 * 原始数据结构不在这里铺开：详情页把它们收在「查看详情（一般不需要看）」里，
 * 这里只负责让普通查看能看懂「这次发生了什么」。
 */
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
      <p className="rounded bg-muted p-3 text-xs text-muted-foreground">
        这项事件暂无可读摘要，原始记录可在下方「查看详情（一般不需要看）」里核对。
      </p>
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
      <p className="rounded bg-muted p-3 text-xs text-muted-foreground">
        这项事件暂无可读摘要，原始记录可在下方「查看详情（一般不需要看）」里核对。
      </p>
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
              {payloadFieldLabel(field)}
            </dt>
            <dd className="text-xs">
              {hasValue ? (
                payloadValueText(field, value)
              ) : (
                <span className="italic text-muted-foreground">
                  这项内容当时还没有
                </span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
