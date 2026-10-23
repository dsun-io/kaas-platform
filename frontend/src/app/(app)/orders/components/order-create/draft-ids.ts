/**
 * 草稿行的本地稳定 id（附件 / 已有单证 / 货物行）。
 *
 * 抽到模块级而不是内联箭头函数：`SortableList` 会把它放进 memo 依赖，
 * 每次渲染换一个新函数会让 id 列表白算一遍（货物行排序）。
 */
import type { OrderItemDraft } from "@/lib/orders/order-create";

let attachmentSeq = 0;
export function nextAttachmentKey(): string {
  attachmentSeq += 1;
  return `attach-${Date.now().toString(36)}-${attachmentSeq}`;
}

let externalDocSeq = 0;
export function nextExternalDocKey(): string {
  externalDocSeq += 1;
  return `extdoc-${Date.now().toString(36)}-${externalDocSeq}`;
}

/** 货物明细行的拖拽 id（草稿主键叫 `key`，不改数据模型）。 */
export const orderItemId = (item: OrderItemDraft): string => item.key;
