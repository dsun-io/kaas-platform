/**
 * 手工新建线索的表单口径（C36 #18）。
 *
 * 契约：`POST /api/v1/leads`（`backend/worker/src/chain.py:1349`，入参 `LeadCreate`）。
 * 必填只有 `company_name`；其余可选。后端还会：
 *   · `_require_sub(conn, "leadgen")` ⇒ 未开通线索开发工位时 404 `WORKSTATION_NOT_SUBSCRIBED`；
 *   · 同一 `place_id`（不传则由公司名 hash 生成）已存在 ⇒ **409 `DUPLICATE_PLACE`**。
 * 这两个错误都要如实告诉用户（尤其重复：用户会反复提交同一家公司）。
 */
import { normalizeApiError } from "@/lib/api/api-error";

export interface LeadDraft {
  company_name: string;
  country?: string;
  region?: string;
  city?: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
  industry?: string;
  opening_line?: string;
  /** 三态：未选 / 是 / 否（后端 can_supply?: bool） */
  can_supply?: "" | "yes" | "no";
  shop_type?: string;
  product_name?: string;
  product_name_cn?: string;
  spec_raw?: string;
  link_url?: string;
  place_id?: string;
  supply_notes?: string;
}

export interface LeadFieldDef {
  key: keyof LeadDraft;
  label: string;
  control: "text" | "textarea" | "select";
  placeholder?: string;
}

export const LEAD_FIELD_GROUPS: Array<{ title: string; fields: LeadFieldDef[] }> = [
  {
    title: "基本信息（公司必填）",
    fields: [
      {
        key: "company_name",
        label: "公司名称",
        control: "text",
        placeholder: "如 HANSA FENCE GMBH",
      },
      { key: "country", label: "国家/地区代码", control: "text", placeholder: "DE / US / AU" },
      { key: "region", label: "州/省", control: "text" },
      { key: "city", label: "城市", control: "text" },
      { key: "address", label: "地址", control: "text" },
    ],
  },
  {
    title: "联系方式",
    fields: [
      { key: "phone", label: "电话", control: "text" },
      { key: "email", label: "邮箱", control: "text", placeholder: "sales@example.com" },
      { key: "website", label: "网站", control: "text", placeholder: "https://..." },
      { key: "place_id", label: "外部 Place ID", control: "text", placeholder: "留空则按公司名去重" },
    ],
  },
  {
    title: "业务画像",
    fields: [
      { key: "industry", label: "行业", control: "text" },
      { key: "shop_type", label: "店铺类型", control: "text", placeholder: "manufacturer / dealer" },
      { key: "product_name", label: "产品名（外文）", control: "text" },
      { key: "product_name_cn", label: "产品名（中文）", control: "text" },
      { key: "spec_raw", label: "规格原文", control: "text" },
      { key: "link_url", label: "产品链接", control: "text" },
      { key: "can_supply", label: "可供货", control: "select" },
      { key: "opening_line", label: "开场话术", control: "textarea" },
      { key: "supply_notes", label: "供货备注", control: "textarea" },
    ],
  },
];

export const LEAD_FIELDS: LeadFieldDef[] = LEAD_FIELD_GROUPS.flatMap((group) => group.fields);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface LeadValidation {
  ok: boolean;
  errors: Record<string, string>;
  /** 可直接 POST 的 payload：空串剔除、can_supply 转 boolean、不传后端无字段 */
  payload: Record<string, unknown>;
}

/**
 * 校验并组包。前端只做"能提前判断"的校验（公司必填、邮箱格式），
 * 不复制后端全部 Pydantic 规则；后端 422 会由 `formatManualLeadError` 原样展示。
 */
export function validateManualLeadDraft(draft: LeadDraft): LeadValidation {
  const errors: Record<string, string> = {};
  const payload: Record<string, unknown> = {};

  const company = (draft.company_name ?? "").trim();
  if (!company) errors.company_name = "公司名称不能为空";
  else payload.company_name = company;

  const email = (draft.email ?? "").trim();
  if (email && !EMAIL_RE.test(email)) errors.email = "邮箱格式不正确";

  for (const field of LEAD_FIELDS) {
    const key = field.key;
    if (key === "company_name" || key === "can_supply") continue;
    const value = (draft[key] as string | undefined)?.trim() ?? "";
    if (value) payload[key] = value;
  }

  const canSupply = draft.can_supply;
  if (canSupply === "yes") payload.can_supply = true;
  else if (canSupply === "no") payload.can_supply = false;

  return { ok: Object.keys(errors).length === 0, errors, payload };
}

export function emptyLeadDraft(): LeadDraft {
  return {
    company_name: "",
    country: "",
    region: "",
    city: "",
    address: "",
    phone: "",
    email: "",
    website: "",
    industry: "",
    opening_line: "",
    can_supply: "",
    shop_type: "",
    product_name: "",
    product_name_cn: "",
    spec_raw: "",
    link_url: "",
    place_id: "",
    supply_notes: "",
  };
}

/**
 * 后端错误 → 人话。
 * 特别处理两个"用户真会撞上"的语义错误：
 *   · 409 `DUPLICATE_PLACE`（同一公司已在线索池）——直接点明，不要只说"请求失败"；
 *   · 404 `WORKSTATION_NOT_SUBSCRIBED`（线索开发工位未开通）——指向去开通。
 * 422 的 `detail` 是字段数组，先拍平成字段级文案。
 */
export function formatManualLeadError(error: unknown): string {
  const normalized = normalizeApiError(error);
  if (normalized.code === "DUPLICATE_PLACE" || normalized.status === 409) {
    return "同一公司已存在线索（重复）：请直接在线索池里搜索它，不要重复新建";
  }
  if (normalized.code === "WORKSTATION_NOT_SUBSCRIBED") {
    return "线索开发工位未开通：请先在「团队与工位」开通该工位后再新建线索";
  }

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
      const label = LEAD_FIELDS.find((field) => field.key === loc)?.label ?? loc;
      return label ? `${label}：${msg}` : msg;
    });
    if (parts.length > 0) return parts.join("；");
  }

  return normalized.message;
}
