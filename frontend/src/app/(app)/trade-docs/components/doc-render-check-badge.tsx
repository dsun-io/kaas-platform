"use client";

import { StatusBadge } from "@/components/shared/status-badge";
import {
  renderCheckBadge,
  type RenderCheckSummary,
} from "@/lib/trade-doc/render-check";

/**
 * 单证列表里的「对账标识」（TODO A8/A9）。
 *
 * 只负责渲染：什么时候该有标识、什么颜色、提示语是什么，全在
 * `renderCheckBadge`（纯函数、有单测）；这里不重复判定。
 */
export function DocRenderCheckBadge({
  check,
}: {
  check?: RenderCheckSummary | null;
}) {
  const badge = renderCheckBadge(check);
  if (!badge) return null;
  return (
    <span title={badge.title} aria-label={badge.title}>
      <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
    </span>
  );
}
