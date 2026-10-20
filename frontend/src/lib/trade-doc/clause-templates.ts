/**
 * 单证条款模板（A5-W1）—— 纯函数层。
 *
 * 口径（用户已拍板）：团队级条款库 + 预置 6 类常用条款；模板中英双语。
 * 后端契约（并行任务）：`GET/POST/PATCH/DELETE /api/v1/clause-templates`，
 * 形状 `{id,name,doc_types:[],text_zh,text_en,sort_order,is_active}`。
 *
 * 为什么把这些规则抽成纯函数：
 * - **模板 → 表单字段的映射**只有一处（否则设置页/表单/测试各写一遍会漂移）；
 * - 「只填空字段 / 已填要二次确认」是业务规则，必须可单测；
 * - 单段字段的双语取舍（英文单证回填英文）也要一个可解释的固定口径。
 *
 * 注意：本模块**不**读/改 `manifest.json`/`render.ts`（A6-1 在改），
 * 只按 manifest 暴露的字段名做子集判断。
 */

/** 条款类字段：manifest 里真实存在的 5 个（contract 全有；payment_terms 另见 quotation/pi/ci）。 */
export const CLAUSE_FIELD_NAMES = [
  "payment_terms",
  "inspection",
  "claims",
  "force_majeure",
  "arbitration",
] as const;

export type ClauseFieldName = (typeof CLAUSE_FIELD_NAMES)[number];

export function isClauseField(name: string): boolean {
  return (CLAUSE_FIELD_NAMES as readonly string[]).includes(name);
}

export interface ClauseTemplate {
  id: number;
  name: string;
  /** 适用单证类型（manifest 的 doc_type）；空数组按"通用"处理 */
  doc_types: string[];
  text_zh: string;
  text_en: string;
  sort_order?: number;
  is_active?: boolean;
}

export interface ClauseTemplateInput {
  name: string;
  doc_types: string[];
  text_zh: string;
  text_en: string;
  sort_order?: number;
}

/**
 * 模板是否适用于某单证类型。
 *
 * 后端契约：`doc_types` 是**非空**的 18 类子集（`normalize_doc_types` 校验），
 * 列表端点 `$3 = ANY(doc_types)` 严格过滤。这里的空数组分支只是**防御**：
 * 历史/异常行若为空，按"通用"处理，不把模板藏起来。
 */
export function templateAppliesTo(
  template: ClauseTemplate,
  docType: string,
): boolean {
  if (template.doc_types.length === 0) return true;
  return template.doc_types.includes(docType);
}

export type TemplateLang = "en" | "zh";

export interface TemplateFill {
  /** 要写进表单的文本；空串 = 该模板无可用文本 */
  text: string;
  /** en / zh：说明实际回填的是哪一版（单段字段只能选一版） */
  lang: TemplateLang;
  /** 给用户看的说明（在表单字段下方展示 / toast） */
  note: string;
}

/**
 * 选模板 → 表单文本。
 *
 * **为什么英文优先**：模板渲染的是英文单证（模板规范 §一：发票/合同/装箱单等全部英文），
 * 而 manifest 里条款字段是**单段字符串**（没有 `*_zh`/`*_en` 两个槽位）。
 * 因此同名字段只有一个时，按英文单证口径回填 `text_en`；无英文才退回 `text_zh`。
 * 未采用的那一版**不丢弃**：模板库仍保留双语，用户可手工粘贴或改模板。
 */
export function pickTemplateFill(template: ClauseTemplate): TemplateFill {
  const en = (template.text_en ?? "").trim();
  const zh = (template.text_zh ?? "").trim();
  if (en) {
    return {
      text: en,
      lang: "en",
      note: zh
        ? "该字段是单段文本（英文单证口径）：已回填英文；中文版本保留在模板库，可手工粘贴。"
        : "已回填英文（模板无中文版本）。",
    };
  }
  if (zh) {
    return {
      text: zh,
      lang: "zh",
      note: "该模板没有英文，已回填中文；英文单证请人工翻译后再用。",
    };
  }
  return { text: "", lang: "en", note: "该模板中英文内容都是空的，未回填。" };
}

export type FillDecision = "fill" | "confirm-overwrite" | "noop";

/**
 * 回填决策（A5-W1 风险 1）：**默认只填空字段**；已填内容必须二次确认才覆盖。
 * 内容与模板文本已一致时返回 `noop`（不弹确认、不重复写）。
 */
export function decideFill(currentText: string, templateText: string): FillDecision {
  const next = templateText.trim();
  if (!next) return "noop";
  const current = (currentText ?? "").trim();
  if (!current) return "fill";
  if (current === next) return "noop";
  return "confirm-overwrite";
}

/** 列表摘要：优先中文，压成一行（换行压成空格），超长截断。 */
export function templateSummary(template: ClauseTemplate, max = 60): string {
  const text = (template.text_zh || template.text_en || "").replace(/\s+/g, " ").trim();
  if (!text) return "（未填写内容）";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 设置页 doc_types 展示用：把 doc_type 列表映射成中文名（未知类型原样返回）。 */
export function docTypeLabels(
  docTypes: string[],
  labelOf: (docType: string) => string | undefined,
): string {
  if (docTypes.length === 0) return "通用";
  return docTypes.map((d) => labelOf(d) ?? d).join("、");
}
