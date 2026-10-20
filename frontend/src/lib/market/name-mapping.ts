/**
 * 品名对照（C36 #19）—— 纯函数层：草稿校验、行构造、重复判定。
 *
 * 后端契约（`backend/worker/src/main.py:1728-1805`）：
 * - 只有 `POST /api/v1/market/name-mappings`（201，返回库行）+ `GET /api/v1/market/name-lookup?q=`（关键词查询）；
 * - **没有**全量列表 / PATCH / DELETE 接口 ⇒ UI 只能"搜索 + 新增"，更新/删除待后端补（审计已记录）。
 * - 每行一种语言：`{category_id?, region_code, lang, local_name, alt_names?, hs_code?, source, confidence?, is_verified}`；
 *   唯一约束 `(tenant_id, category_id, region_code, lang)`（迁移 `20260919_customers_market_subs.py:190`）。
 *
 * 本模块把"中英两个输入 → 1~2 行 POST"的规则收在纯函数里，便于测试与复用。
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

/** 已有对照行（`GET /market/name-lookup` 的最小形状） */
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
  if (draft.hsCode.trim() && !/^\d{4,12}(\.\d{1,4})?$/.test(draft.hsCode.trim())) {
    errors.push("HS 编码格式不对（4–12 位数字，可带小数）");
  }
  return errors;
}

/**
 * 中英输入 → POST 行。中文/英文各自成行（表按 `lang` 区分语言）；
 * 两行共享地区/类目/别名/HS/核实状态。
 */
export function buildNameMappingRows(draft: NameMappingDraft): NameMappingRowInput[] {
  const region = draft.regionCode.trim().toUpperCase();
  const category = draft.categoryId.trim()
    ? Number(draft.categoryId)
    : null;
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
      e.region_code.trim().toUpperCase() === row.region_code.trim().toUpperCase() &&
      e.local_name.trim().toLowerCase() === name,
  );
}

/** 冲突行的人类可读描述（用于"已存在，未提交"提示）。 */
export function describeDuplicate(row: NameMappingRowInput): string {
  return `${row.local_name}（${row.lang === "zh" ? "中文" : "英文"} / ${row.region_code}）`;
}
