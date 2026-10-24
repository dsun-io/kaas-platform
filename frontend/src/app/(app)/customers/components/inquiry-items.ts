"use client";

/**
 * 询盘多产品行（设计稿 docs/OPTIMIZATION_PLAN_2026-10-22_PRODUCT_INQUIRY_ORDER.md
 * §5 + §13.1 方案 A）的**纯数据逻辑**：表单行 → 提交 payload、读取展示（items 优先、
 * 旧字段回退）。放独立文件的目的：
 *  - 纯函数可单测（不清 DOM、不 mock axios）；
 *  - 弹窗组件（inquiry-form.tsx）和详情卡片（page.tsx）共用同一口径，
 *    不会出现「弹窗按多行提交、详情仍只显示一个产品」的漂移。
 *
 * 契约（与后端 POST /customers/{id}/inquiries 的 items 对齐）：
 *  - 每行：{ product_key?, product_name_raw, spec_text?, quantity?, quantity_unit?,
 *    application?, notes? }；
 *  - 旧标量字段 product_name_raw / quantity / quantity_unit / application 仍保留，
 *    新建时同步写**第一行**（历史报表 / 旧接口消费方不用改）。
 */

/** 一条询盘里的一个产品行（后端 cust_inquiries.items 的元素）。 */
export interface InquiryItem {
  /** 产品库 key（从产品库选中时才有；手输产品为空） */
  product_key?: string | null;
  /** 产品名称原文（必填字符串；历史数据可能是空串） */
  product_name_raw: string;
  /** 规格说明（如「2.5mm 热镀锌」）；旧数据可能把规格写在 product_name_raw 里 */
  spec_text?: string | null;
  quantity?: number | null;
  quantity_unit?: string | null;
  application?: string | null;
  notes?: string | null;
}

/** 询盘读取源：新数据看 items，历史数据只有旧标量字段。 */
export interface InquiryItemsSource {
  /** 多产品行；空数组 / 缺失 ⇒ 用旧字段合成一行（历史数据兼容） */
  items?: InquiryItem[] | null;
  product_name_raw?: string | null;
  quantity?: number | null;
  quantity_unit?: string | null;
  application?: string | null;
}

/** 详情卡片展示用的归一视图（名称/规格已拆好）。 */
export interface InquiryItemView {
  /** 产品库 key；手输产品 / 历史数据为 null */
  productKey: string | null;
  name: string;
  spec: string | null;
  quantity: number | null;
  quantityUnit: string | null;
  application: string | null;
}

/** 弹窗里一行产品的表单状态（数量用字符串，提交时再转数字）。 */
export interface InquiryItemFormRow {
  /** React 列表 key（删除中间行时不会串输入框） */
  id: string;
  product: string;
  /** 从产品库选中时由名称反查；手输时为 null */
  product_key: string | null;
  spec_text: string;
  quantity: string;
  quantity_unit: string;
  application: string;
}

/** 产品库选项（GET /products 里前端需要的字段）。 */
export interface InquiryProductOption {
  product_key: string;
  name: string;
  /**
   * 中文名之外的**全部**英文名（默认英文名 + 其它英文名 / aliases）。
   *
   * 产品可以有多个英文名（团队资料 `name_en_list`）；业务手输任一写法时
   * 也要能反查出 product_key。可选字段：旧调用方只给 name 时行为不变。
   */
  names?: string[];
}

export const EMPTY_INQUIRY_ITEM_NAME = "未填写产品";

export function emptyInquiryItemRow(id: string): InquiryItemFormRow {
  return {
    id,
    product: "",
    product_key: null,
    spec_text: "",
    quantity: "",
    quantity_unit: "",
    application: "",
  };
}

/**
 * 产品名拆分：列表只显示产品名，规格参数进详情。
 * （原在 inquiry-followups.tsx；多产品行读取也要用，移到纯函数文件避免
 *  import 单证预览等重依赖。）
 */
export function splitProductName(raw: string | null | undefined): {
  name: string;
  spec: string | null;
} {
  if (!raw || raw.trim() === "")
    return { name: EMPTY_INQUIRY_ITEM_NAME, spec: null };
  const value = raw.trim();
  const specRe =
    /\d+(?:\.\d+)?\s*(?:mm|cm|m2|m²|㎡|目|卷|吨|kg|g|inch|in)\b|\s*[×xX*]\s*\d/i;
  const match = value.match(specRe);
  if (!match || match.index === undefined) return { name: value, spec: null };
  const name = value.slice(0, match.index).replace(/[\s\-–—·]+$/, "");
  const spec = value
    .slice(match.index)
    .replace(/^[\s\-–—×xX*·]+/, "")
    .trim();
  return { name: name || value, spec: spec || null };
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberOf(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 读取一条询盘的展示行：**items 优先**；items 为空时用旧标量字段合成一行。
 * 返回空数组 = 历史上「什么都没填」的询盘（卡片显示「未填写产品」）。
 */
export function displayInquiryItems(
  inquiry: InquiryItemsSource,
): InquiryItemView[] {
  const rawItems = Array.isArray(inquiry.items) ? inquiry.items : [];
  const items = rawItems.filter(
    (item): item is InquiryItem => Boolean(item) && typeof item === "object",
  );
  if (items.length > 0) {
    return items.map((item) => {
      const raw = textOf(item.product_name_raw);
      const key = textOf(item.product_key) || null;
      const split = splitProductName(raw);
      const specText = textOf(item.spec_text);
      return {
        productKey: key,
        // 显式 spec_text 存在时：名称直接用原文（不再二次拆，避免把用户写进
        // 名称里的型号当规格吞掉）；没有 spec_text 的新/旧数据才按旧式拆分兜底。
        name: raw
          ? specText
            ? raw
            : split.name
          : (key ?? EMPTY_INQUIRY_ITEM_NAME),
        spec: specText || split.spec || null,
        quantity: numberOf(item.quantity),
        quantityUnit: textOf(item.quantity_unit) || null,
        application: textOf(item.application) || null,
      };
    });
  }

  const legacyRaw = textOf(inquiry.product_name_raw);
  const legacyQuantity = numberOf(inquiry.quantity);
  const legacyUnit = textOf(inquiry.quantity_unit);
  const legacyApplication = textOf(inquiry.application);
  if (
    !legacyRaw &&
    legacyQuantity === null &&
    !legacyUnit &&
    !legacyApplication
  ) {
    return [];
  }
  const split = splitProductName(legacyRaw);
  return [
    {
      productKey: null,
      name: legacyRaw ? split.name : EMPTY_INQUIRY_ITEM_NAME,
      spec: split.spec,
      quantity: legacyQuantity,
      quantityUnit: legacyUnit || null,
      application: legacyApplication || null,
    },
  ];
}

/** 卡片摘要文案（产品名列表；多产品时折叠成「甲、乙 等 3 个产品」）。 */
export function inquiryProductSummary(views: InquiryItemView[]): string {
  if (views.length === 0) return EMPTY_INQUIRY_ITEM_NAME;
  const names = views.map((view) => view.name);
  if (names.length <= 2) return names.join("、");
  return `${names[0]}、${names[1]} 等 ${names.length} 个产品`;
}

/**
 * 产品名归一：去两端空白、连续空白并成一个、大小写不敏感。
 *
 * 为什么不能只 `=== name`：英文名有多条（默认名 + 别名），业务手输时大小写
 * （`cattle fence` / `Cattle Fence`）或多余空格很常见，不该因此丢 product_key。
 */
function normalizeProductName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * 产品名（中文名 / 任一英文名）→ product_key；手输的自由文本返回 null，不猜。
 */
export function resolveProductKey(
  name: string,
  options: ReadonlyArray<InquiryProductOption>,
): string | null {
  const value = normalizeProductName(name);
  if (!value) return null;
  for (const option of options) {
    const candidates = [option.name, ...(option.names ?? [])];
    if (
      candidates.some((candidate) => normalizeProductName(candidate) === value)
    ) {
      return option.product_key;
    }
  }
  return null;
}

export interface InquiryFormPayload {
  channel?: string;
  notes?: string;
  items?: InquiryItem[];
  /** 旧字段兼容：同步第一行 */
  product_name_raw?: string;
  quantity?: number;
  quantity_unit?: string;
  application?: string;
}

/**
 * 弹窗表单 → POST payload。
 * - 空行（所有字段都空）丢弃，不会发出 product_name_raw: "" 的垃圾行；
 * - 至少填了一行 ⇒ 发 items[]，并把**第一行**同步进旧标量字段；
 * - 一行都没填 ⇒ 不发明细（保持旧版「只填渠道/备注也能建询盘」的行为）。
 * - 数量非法（手输字母）返回可读错误，不发请求。
 */
export function buildInquiryPayload(input: {
  channel: string;
  notes: string;
  rows: InquiryItemFormRow[];
}): { payload: InquiryFormPayload; error: string | null } {
  const items: InquiryItem[] = [];
  for (let index = 0; index < input.rows.length; index += 1) {
    const row = input.rows[index];
    if (!row) continue; // noUncheckedIndexedAccess
    const product = row.product.trim();
    const spec = row.spec_text.trim();
    const quantityText = row.quantity.trim();
    const unit = row.quantity_unit.trim();
    const application = row.application.trim();
    let quantity: number | null = null;
    if (quantityText !== "") {
      const parsed = Number(quantityText);
      if (!Number.isFinite(parsed)) {
        return {
          payload: {},
          error: `第 ${index + 1} 行产品的数量请填数字`,
        };
      }
      quantity = parsed;
    }
    if (!product && !spec && quantityText === "" && !unit && !application) {
      continue;
    }
    const item: InquiryItem = { product_name_raw: product };
    if (row.product_key) item.product_key = row.product_key;
    if (spec) item.spec_text = spec;
    if (quantity !== null) item.quantity = quantity;
    if (unit) item.quantity_unit = unit;
    if (application) item.application = application;
    items.push(item);
  }

  const payload: InquiryFormPayload = {};
  const channel = input.channel.trim();
  if (channel) payload.channel = channel;
  const notes = input.notes.trim();
  if (notes) payload.notes = notes;

  const first = items[0];
  if (first) {
    payload.items = items;
    // 旧字段兼容：后端 / 报表仍读这三个标量字段（设计稿 §5「新建时把第一行同步写进旧字段」）。
    payload.product_name_raw = first.product_name_raw;
    if (first.quantity != null) payload.quantity = first.quantity;
    if (first.quantity_unit) payload.quantity_unit = first.quantity_unit;
    if (first.application) payload.application = first.application;
  }

  return { payload, error: null };
}
