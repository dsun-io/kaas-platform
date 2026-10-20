/**
 * 手工新增情报货运的表单口径（C36 #16）。
 *
 * 契约：`POST /api/v1/intel/shipments`（`backend/worker/src/main.py:990`，
 * 入参 `ShipmentCreate`，见 `main.py:189`）——**JSON**（不是 multipart），
 * 必填 `shipper` / `consignee` / `product_desc`；`ship_date` 是 **datetime**（不是 date），
 * `qty`/重量/体积/申报价值是 **number**。后端用 Pydantic 校验，非法输入返回 422
 * （`detail` 是字段数组），这里把字段错误**翻成中文并指到字段**，而不是只弹一句"请求失败"。
 */
import { normalizeApiError } from "@/lib/api/api-error";

/** 表单草稿：所有值都是字符串（input 原值），提交前统一 trim/转数字。 */
export interface ShipmentDraft {
  shipper: string;
  consignee: string;
  product_desc: string;
  ship_date?: string;
  carrier?: string;
  notify_party?: string;
  origin_port?: string;
  origin_country?: string;
  dest_port?: string;
  dest_country?: string;
  product_desc_norm?: string;
  hs_code?: string;
  qty?: string;
  qty_unit?: string;
  gross_weight_kg?: string;
  net_weight_kg?: string;
  volume_cbm?: string;
  container_no?: string;
  container_type?: string;
  bl_no?: string;
  voyage_no?: string;
  declared_value?: string;
  currency?: string;
  marks?: string;
  remarks?: string;
}

export type ShipmentFieldControl = "text" | "date" | "number" | "textarea";

export interface ShipmentFieldDef {
  key: keyof ShipmentDraft;
  label: string;
  control: ShipmentFieldControl;
  required?: boolean;
  placeholder?: string;
}

/** 字段多，按"基本信息 / 运输与单据 / 货物与金额 / 其他"分组（表单按组渲染）。 */
export const SHIPMENT_FIELD_GROUPS: Array<{
  title: string;
  fields: ShipmentFieldDef[];
}> = [
  {
    title: "基本信息（必填）",
    fields: [
      { key: "shipper", label: "发货人", control: "text", required: true },
      { key: "consignee", label: "收货人", control: "text", required: true },
      {
        key: "product_desc",
        label: "产品描述",
        control: "text",
        required: true,
        placeholder: "如 Galvanized chain link fence, 50x50mm",
      },
    ],
  },
  {
    title: "运输与单据",
    fields: [
      { key: "ship_date", label: "发货日期", control: "date" },
      { key: "carrier", label: "承运人", control: "text" },
      { key: "bl_no", label: "提单号", control: "text" },
      { key: "voyage_no", label: "航次号", control: "text" },
      { key: "container_no", label: "集装箱号", control: "text" },
      { key: "container_type", label: "箱型", control: "text" },
      { key: "origin_port", label: "装运港", control: "text" },
      { key: "origin_country", label: "原产国", control: "text" },
      { key: "dest_port", label: "目的港", control: "text" },
      { key: "dest_country", label: "目的国", control: "text" },
      { key: "notify_party", label: "通知方", control: "text" },
    ],
  },
  {
    title: "货物与金额",
    fields: [
      { key: "product_desc_norm", label: "品名归一", control: "text" },
      { key: "hs_code", label: "HS 编码", control: "text" },
      { key: "qty", label: "数量", control: "number" },
      { key: "qty_unit", label: "单位", control: "text" },
      { key: "gross_weight_kg", label: "毛重 (KG)", control: "number" },
      { key: "net_weight_kg", label: "净重 (KG)", control: "number" },
      { key: "volume_cbm", label: "体积 (CBM)", control: "number" },
      { key: "declared_value", label: "申报价值", control: "number" },
      { key: "currency", label: "币种", control: "text", placeholder: "USD / CNY" },
    ],
  },
  {
    title: "其他",
    fields: [
      { key: "marks", label: "唛头", control: "text" },
      { key: "remarks", label: "备注", control: "textarea" },
    ],
  },
];

/** 所有表单字段（扁平，便于测试） */
export const SHIPMENT_FIELDS: ShipmentFieldDef[] =
  SHIPMENT_FIELD_GROUPS.flatMap((group) => group.fields);

const REQUIRED_FIELDS: Array<keyof ShipmentDraft> = [
  "shipper",
  "consignee",
  "product_desc",
];

const NUMBER_FIELDS: Array<keyof ShipmentDraft> = [
  "qty",
  "gross_weight_kg",
  "net_weight_kg",
  "volume_cbm",
  "declared_value",
];

export interface ShipmentValidation {
  ok: boolean;
  errors: Record<string, string>;
  /** 可直接 POST 的 payload（只含非空字段；数字已转 number；ship_date 已转 datetime） */
  payload: Record<string, unknown>;
}

/**
 * 校验并组包。规则（与后端 `ShipmentCreate` 对齐）：
 * - 三个必填字段 trim 后不能为空；
 * - 数字字段：留空 = 不填；非空但 `Number()` 不是有限数 ⇒ 字段级错误；
 * - `ship_date` 的 `<input type="date">` 给的是 `YYYY-MM-DD`，而后端要 datetime ⇒
 *   补 `T00:00:00`（否则 Pydantic 可能直接 422；这里不让用户看到这种契约细节）；
 * - 其余字符串 trim 后为空则省略（后端 `exclude_none` 语义，不传空串）。
 */
export function validateShipmentDraft(draft: ShipmentDraft): ShipmentValidation {
  const errors: Record<string, string> = {};
  const payload: Record<string, unknown> = {};

  for (const key of REQUIRED_FIELDS) {
    const value = (draft[key] ?? "").trim();
    if (!value) {
      const label = SHIPMENT_FIELDS.find((field) => field.key === key)?.label ?? key;
      errors[key] = `${label}不能为空`;
    } else {
      payload[key] = value;
    }
  }

  for (const field of SHIPMENT_FIELDS) {
    const key = field.key;
    if ((REQUIRED_FIELDS as readonly string[]).includes(key)) continue;
    const raw = (draft[key] ?? "").trim();
    if (!raw) continue;

    if (NUMBER_FIELDS.includes(key)) {
      const num = Number(raw);
      if (!Number.isFinite(num)) {
        errors[key] = `${field.label}必须是数字`;
        continue;
      }
      payload[key] = num;
    } else if (key === "ship_date") {
      // date → datetime（见函数注释）
      payload[key] = `${raw}T00:00:00`;
    } else {
      payload[key] = raw;
    }
  }

  return { ok: Object.keys(errors).length === 0, errors, payload };
}

/** 表单空草稿 */
export function emptyShipmentDraft(): ShipmentDraft {
  return Object.fromEntries(
    SHIPMENT_FIELDS.map((field) => [field.key, ""]),
  ) as unknown as ShipmentDraft;
}

/**
 * 后端错误 → 人话。422 的 `detail` 是**字段数组**（`[{loc:["body","qty"],msg,...}]`），
 * `normalizeApiError` 只认 `detail` 是对象/字符串的情况 ⇒ 这里先把数组拍平成字段级文案。
 */
export function formatShipmentError(error: unknown): string {
  const detail = (
    error as { response?: { data?: { detail?: unknown } } } | undefined
  )?.response?.data?.detail;
  if (Array.isArray(detail)) {
    const parts = detail.slice(0, 6).map((item) => {
      const rec =
        typeof item === "object" && item !== null
          ? (item as Record<string, unknown>)
          : {};
      const loc = Array.isArray(rec.loc)
        ? rec.loc.filter((part) => part !== "body" && part !== "query").join(".")
        : "";
      const msg = typeof rec.msg === "string" ? rec.msg : "校验失败";
      const label =
        SHIPMENT_FIELDS.find((field) => field.key === loc)?.label ?? loc;
      return label ? `${label}：${msg}` : msg;
    });
    if (parts.length > 0) return parts.join("；");
  }
  return normalizeApiError(error).message;
}
