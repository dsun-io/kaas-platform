/**
 * 询盘编辑（渠道 / 多产品行）—— 表单草稿 → PATCH payload 的**纯逻辑**。
 *
 * 契约真源：`backend/worker/src/ws_crm_ext.py:482-606`（PATCH /inquiries/{id}）：
 *   · `channel` 走 `validate_enum("inquiry_channel")` —— **不接受空值**，无法清空；
 *   · `items` 落 jsonb，并把**第一行**同步写进旧标量字段
 *     （product_name_raw / quantity / quantity_unit / application），所以前端只发 items；
 *   · 数量在 pydantic 里是 float，手输字母必须前端先拦（否则整个 PATCH 422）；
 *   · 空行（全字段空）丢弃，不发垃圾行 —— 与 customers 的 buildInquiryPayload 同口径。
 *
 * 为什么"只发改过的字段"：PATCH 是部分更新，但 `items` 一传就会覆盖旧字段并与
 * 第一行同步；无改动时传空对象既省一次写，也避免把并发改动覆盖回去。
 */
import type { InquiryBase, InquiryItem } from "./types";

let draftRowSeq = 0;

/** 编辑行 key（删中间行时输入框不会串）。 */
export function newInquiryItemRowId(): string {
  draftRowSeq += 1;
  return `inquiry-item-${draftRowSeq}`;
}

/** 编辑抽屉里一行产品的表单状态（数量用字符串，提交时转数字）。 */
export interface InquiryItemDraftRow {
  id: string;
  product_name_raw: string;
  spec_text: string;
  quantity: string;
  quantity_unit: string;
  application: string;
}

export interface InquiryEditDraft {
  channel: string;
  items: InquiryItemDraftRow[];
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function quantityText(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return Number.isFinite(value) ? String(value) : "";
}

export function emptyInquiryItemDraftRow(): InquiryItemDraftRow {
  return {
    id: newInquiryItemRowId(),
    product_name_raw: "",
    spec_text: "",
    quantity: "",
    quantity_unit: "",
    application: "",
  };
}

/** 详情 items → 编辑行。 */
export function itemDraftRows(
  items: readonly InquiryItem[] | null | undefined,
): InquiryItemDraftRow[] {
  const list = Array.isArray(items) ? items : [];
  return list.map((item) => ({
    id: newInquiryItemRowId(),
    product_name_raw: textOf(item.product_name_raw),
    spec_text: textOf(item.spec_text),
    quantity: quantityText(item.quantity),
    quantity_unit: textOf(item.quantity_unit),
    application: textOf(item.application),
  }));
}

/** 详情 → 编辑草稿。 */
export function draftFromDetail(
  detail: Pick<InquiryBase, "channel" | "items">,
): InquiryEditDraft {
  return {
    channel: textOf(detail.channel),
    items: itemDraftRows(detail.items),
  };
}

interface NormalizedItem {
  product_name_raw: string | null;
  spec_text: string | null;
  quantity: number | null;
  quantity_unit: string | null;
  application: string | null;
}

function normalizeItem(item: InquiryItem): NormalizedItem {
  return {
    product_name_raw: textOf(item.product_name_raw) || null,
    spec_text: textOf(item.spec_text) || null,
    quantity: typeof item.quantity === "number" ? item.quantity : null,
    quantity_unit: textOf(item.quantity_unit) || null,
    application: textOf(item.application) || null,
  };
}

function sameItems(
  original: readonly InquiryItem[],
  next: readonly NormalizedItem[],
): boolean {
  return JSON.stringify(original.map(normalizeItem)) === JSON.stringify(next);
}

export interface InquiryUpdatePlan {
  patch: Record<string, unknown>;
  error: string | null;
}

/**
 * 草稿 → PATCH payload。
 *
 * 返回：
 *   · `error` 非空 ⇒ 前端就不该发请求（数量非数字 / 试图清空渠道）；
 *   · `patch` 为空对象 ⇒ 没有任何改动（调用方据此禁用「保存」）。
 */
export function buildInquiryUpdatePayload(
  original: Pick<InquiryBase, "channel" | "items">,
  draft: InquiryEditDraft,
): InquiryUpdatePlan {
  const patch: Record<string, unknown> = {};

  const originalChannel = textOf(original.channel);
  const channel = textOf(draft.channel);
  if (channel !== originalChannel) {
    if (!channel) {
      // 内核 validate_enum 不接受空值：清空渠道必然 422，不如在前端说清楚
      return {
        patch: {},
        error: "渠道不能清空（后端枚举不接受空值）；如需变更请选择具体渠道",
      };
    }
    patch.channel = channel;
  }

  const nextItems: NormalizedItem[] = [];
  for (let index = 0; index < draft.items.length; index += 1) {
    const row = draft.items[index];
    if (!row) continue; // noUncheckedIndexedAccess
    const name = row.product_name_raw.trim();
    const spec = row.spec_text.trim();
    const quantityTextValue = row.quantity.trim();
    const unit = row.quantity_unit.trim();
    const application = row.application.trim();
    const empty =
      !name && !spec && quantityTextValue === "" && !unit && !application;
    if (empty) continue;

    let quantity: number | null = null;
    if (quantityTextValue !== "") {
      const parsed = Number(quantityTextValue);
      if (!Number.isFinite(parsed)) {
        return {
          patch: {},
          error: `第 ${index + 1} 行产品的数量请填数字`,
        };
      }
      quantity = parsed;
    }
    nextItems.push({
      product_name_raw: name || null,
      spec_text: spec || null,
      quantity,
      quantity_unit: unit || null,
      application: application || null,
    });
  }

  if (!sameItems(original.items, nextItems)) {
    // 后端收到 items 会把第一行同步回旧标量字段（ws_crm_ext.py:571-582）
    patch.items = nextItems;
  }

  return { patch, error: null };
}

/** 是否真的改了什么（UI 用来禁用保存按钮）。 */
export function hasInquiryPatch(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).length > 0;
}
