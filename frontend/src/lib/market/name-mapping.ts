/**
 * 品名对照（C36 #19 → B2）—— 纯函数层：列表查询串、草稿校验、行构造、重复判定、编辑补丁。
 *
 * 后端契约（`backend/worker/src/main.py:2030-2135`，2026-10-23 补全 CRUD）：
 * - `GET /api/v1/market/name-mappings?page=&page_size=&q=&region_code=&lang=`
 *   → `{items,total,page,page_size}`；空 q = 最近记录（排序 `is_verified DESC, created_at DESC`），
 *   q 对 `local_name` / `alt_names` 做 ILIKE；`region_code` 后端会 upper，`lang` 精确匹配；
 *   `page` 默认 1、`page_size` 默认 20（上限 100）；
 * - `PATCH /api/v1/market/name-mappings/{id}`：部分字段（`category_id/region_code/lang/local_name/
 *   alt_names/hs_code/source/confidence/is_verified`），空 body → 422，唯一冲突 → 409，不存在 → 404；
 * - `DELETE /api/v1/market/name-mappings/{id}` → 204（不存在 → 404）；
 * - `POST /api/v1/market/name-mappings`（201，返回库行）与 `GET /market/name-lookup?q=` 保留（市场「按品名查询」tab 仍在用）。
 * - 每行一种语言：`{category_id?, region_code, lang, local_name, alt_names?, hs_code?, source, confidence?, is_verified}`；
 *   唯一约束 `(tenant_id, category_id, region_code, lang)`（迁移 `20260919_customers_market_subs.py:190`）。
 *
 * 本模块把"中英两个输入 → 1~2 行 POST"「列表查询参数」「编辑弹窗 → 部分 PATCH」的规则收在纯函数里，便于测试与复用。
 */

export interface NameMappingDraft {
  /** 中文品名（可选，与英文至少填一个） */
  localNameZh: string;
  /** 英文品名（可选，与中文至少填一个） */
  localNameEn: string;
  /** 地区代码（必填，后端会 upper） */
  regionCode: string;
  /** 类目 id（可选，正整数） */
  categoryId: string;
  /** 别名，逗号分隔 */
  altNames: string;
  hsCode: string;
  isVerified: boolean;
}

export interface NameMappingRowInput {
  lang: "zh" | "en";
  local_name: string;
  region_code: string;
  category_id: number | null;
  alt_names: string[];
  hs_code: string | null;
  source: string;
  confidence: null;
  is_verified: boolean;
}

/** 已有对照行（`GET /market/name-lookup` 与 `GET /market/name-mappings` 共有的最小形状） */
export interface ExistingNameMapping {
  id?: number;
  lang: string;
  local_name: string;
  region_code: string;
  category_id: number | null;
}

export const EMPTY_NAME_MAPPING_DRAFT: NameMappingDraft = {
  localNameZh: "",
  localNameEn: "",
  regionCode: "",
  categoryId: "",
  altNames: "",
  hsCode: "",
  isVerified: false,
};

export function parseAltNames(text: string): string[] {
  return Array.from(
    new Set(
      (text ?? "")
        .split(/[,，;；\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

/** 草稿校验：返回人类可读错误（空数组 = 通过）。 */
export function validateNameMappingDraft(draft: NameMappingDraft): string[] {
  const errors: string[] = [];
  if (!draft.localNameZh.trim() && !draft.localNameEn.trim()) {
    errors.push("中文品名或英文品名至少填一个");
  }
  if (!draft.regionCode.trim()) errors.push("地区必填");
  if (draft.categoryId.trim()) {
    const n = Number(draft.categoryId);
    if (!Number.isInteger(n) || n <= 0) errors.push("类目 id 必须是正整数");
  }
  if (
    draft.hsCode.trim() &&
    !/^\d{4,12}(\.\d{1,4})?$/.test(draft.hsCode.trim())
  ) {
    errors.push("HS 编码格式不对（4–12 位数字，可带小数）");
  }
  return errors;
}

/**
 * 中英输入 → POST 行。中文/英文各自成行（表按 `lang` 区分语言）；
 * 两行共享地区/类目/别名/HS/核实状态。
 */
export function buildNameMappingRows(
  draft: NameMappingDraft,
): NameMappingRowInput[] {
  const region = draft.regionCode.trim().toUpperCase();
  const category = draft.categoryId.trim() ? Number(draft.categoryId) : null;
  const alt = parseAltNames(draft.altNames);
  const hs = draft.hsCode.trim() || null;
  const base = {
    region_code: region,
    category_id: category,
    alt_names: alt,
    hs_code: hs,
    source: "manual",
    confidence: null,
    is_verified: draft.isVerified,
  } as const;
  const rows: NameMappingRowInput[] = [];
  if (draft.localNameZh.trim()) {
    rows.push({ ...base, lang: "zh", local_name: draft.localNameZh.trim() });
  }
  if (draft.localNameEn.trim()) {
    rows.push({ ...base, lang: "en", local_name: draft.localNameEn.trim() });
  }
  return rows;
}

/** 重复判定：同地区 + 同语言 + 同品名（忽略大小写/首尾空格）。 */
export function isDuplicateMapping(
  existing: ExistingNameMapping[],
  row: NameMappingRowInput,
): boolean {
  const name = row.local_name.trim().toLowerCase();
  return existing.some(
    (e) =>
      e.lang === row.lang &&
      e.region_code.trim().toUpperCase() ===
        row.region_code.trim().toUpperCase() &&
      e.local_name.trim().toLowerCase() === name,
  );
}

/** 冲突行的人类可读描述（用于"已存在，未提交"提示）。 */
export function describeDuplicate(row: NameMappingRowInput): string {
  return `${row.local_name}（${row.lang === "zh" ? "中文" : "英文"} / ${row.region_code}）`;
}

// ════════════════════════════════════════════════════════════════════════════
// 分页列表（GET /market/name-mappings · B2）
// ════════════════════════════════════════════════════════════════════════════

/** 列表默认每页条数（后端 `page_size` 默认 20、上限 100）。 */
export const NAME_MAPPING_PAGE_SIZE = 20;

/** 列表行（库行直出；`created_at/updated_at/source` 前端不展示但后端会给）。 */
export interface NameMappingRow {
  id: number;
  category_id: number | null;
  region_code: string;
  lang: string;
  local_name: string;
  alt_names: string[] | null;
  hs_code: string | null;
  source?: string | null;
  confidence?: string | null;
  is_verified: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface NameMappingListResponse {
  items: NameMappingRow[];
  total: number;
  page: number;
  page_size: number;
}

export interface NameMappingListQuery {
  page: number;
  pageSize: number;
  q?: string;
  regionCode?: string;
  lang?: string;
}

/**
 * 列表查询串（不含 `?`）。
 *
 * 口径与后端 Query 参数一致：`q` 空串**不下发**（后端空 q 返回最近记录，不能拼成 `q=`）；
 * `region_code` 统一大写（后端也会 upper，前端先归一避免缓存键出现 `de`/`DE` 两份）；
 * `page/page_size` 一定下发，非法值夹到后端下限。
 */
export function buildNameMappingListQuery(query: NameMappingListQuery): string {
  const params = new URLSearchParams();
  params.set("page", String(Math.max(1, Math.trunc(query.page) || 1)));
  const pageSize = Math.max(
    1,
    Math.trunc(query.pageSize) || NAME_MAPPING_PAGE_SIZE,
  );
  params.set("page_size", String(pageSize));
  const q = (query.q ?? "").trim();
  if (q) params.set("q", q);
  const region = (query.regionCode ?? "").trim().toUpperCase();
  if (region) params.set("region_code", region);
  const lang = (query.lang ?? "").trim();
  if (lang) params.set("lang", lang);
  return params.toString();
}

/** 列表请求路径（`/` 开头，供 apiClient 拼 baseURL）。 */
export function nameMappingListUrl(query: NameMappingListQuery): string {
  return `/market/name-mappings?${buildNameMappingListQuery(query)}`;
}

/**
 * 删除后应停留的页：删掉当前页最后一条时回退一页（否则会停在空页）。
 * 纯函数便于测试；调用方传**删除前**的当前页与本页条数。
 */
export function pageAfterRemove(page: number, pageItemCount: number): number {
  const safePage = Math.max(1, Math.trunc(page) || 1);
  return Math.trunc(pageItemCount) <= 1 && safePage > 1
    ? safePage - 1
    : safePage;
}

// ════════════════════════════════════════════════════════════════════════════
// 编辑（PATCH /market/name-mappings/{id} · B2）
// ════════════════════════════════════════════════════════════════════════════

/** 编辑弹窗草稿：只编辑行级字段（`category_id/alt_names` 不在本批 UI 内，保持 null 语义不误改）。 */
export interface NameMappingEditDraft {
  localName: string;
  /** 不限于 zh/en：种子数据里有 de 等语言，编辑时必须原样保留（不能悄悄改成 en）。 */
  lang: string;
  regionCode: string;
  hsCode: string;
  isVerified: boolean;
}

/** 行 → 编辑草稿（预填；语言原样保留，未知语言在弹窗里以「其他（xx）」展示）。 */
export function toNameMappingEditDraft(
  row: Pick<
    NameMappingRow,
    "local_name" | "lang" | "region_code" | "hs_code" | "is_verified"
  >,
): NameMappingEditDraft {
  return {
    localName: row.local_name ?? "",
    lang: row.lang ?? "",
    regionCode: (row.region_code ?? "").toUpperCase(),
    hsCode: row.hs_code ?? "",
    isVerified: row.is_verified === true,
  };
}

/** HS 编码格式（与新增同口径）。 */
export function isValidHsCode(text: string): boolean {
  const value = text.trim();
  return value === "" || /^\d{4,12}(\.\d{1,4})?$/.test(value);
}

/** 编辑草稿校验：返回人类可读错误（空数组 = 通过）。 */
export function validateNameMappingEditDraft(
  draft: NameMappingEditDraft,
): string[] {
  const errors: string[] = [];
  if (!draft.localName.trim()) errors.push("品名必填");
  if (!draft.regionCode.trim()) errors.push("地区必填");
  if (!draft.lang.trim()) errors.push("语言必填");
  if (!isValidHsCode(draft.hsCode))
    errors.push("HS 编码格式不对（4–12 位数字，可带小数）");
  return errors;
}

/** PATCH 请求体（部分字段；`hs_code` 清空时显式传 null）。 */
export interface NameMappingPatch {
  local_name: string;
  lang: string;
  region_code: string;
  hs_code: string | null;
  is_verified: boolean;
}

export function buildNameMappingPatch(
  draft: NameMappingEditDraft,
): NameMappingPatch {
  return {
    local_name: draft.localName.trim(),
    lang: draft.lang,
    region_code: draft.regionCode.trim().toUpperCase(),
    hs_code: draft.hsCode.trim() || null,
    is_verified: draft.isVerified,
  };
}
