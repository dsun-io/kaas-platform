/**
 * 单证「中译英」的**纯逻辑**（A13）。
 *
 * 职责：从单证手工内容（`trade_docs.raw_payload.custom`）里挑出**含中文的文本字段**，
 * 交给后端 `POST /trade-docs/{id}/translate` 翻译；本模块只做抽取/标签/路径解释，
 * **不做任何翻译**，也不判"翻好了没有"——`path=template` 表示 AI 不可用、后端原样返回，
 * UI 必须如实提示"请人工翻译"（不能显示成已翻译）。
 *
 * 为什么字段清单从模板 manifest 推导（`listCustomFields`）而不是手写一份：
 * 18 类单证的字段各不相同，手写必然漂移；manifest 是渲染器同一份真源。
 * 只收 `control === "text"` 的字段 ⇒ 日期/数字/布尔/图片/对象（items、seller、bank_info…）
 * 天然被排除；`items`/`total_amount` 另有保护，也不会进来。
 */
import { listCustomFields } from "./custom-fields";

/** 可翻译字段（从 manifest 顺序 + custom 实际值推导出来的一项）。 */
export interface TranslatableField {
  /** manifest 里的键名（= raw_payload.custom 的键，也是 translate 请求体的键） */
  name: string;
  /** 给用户看的中文说明（manifest `description`，缺失回退键名） */
  label: string;
  /** 当前中文原文（翻译请求体里的值） */
  text: string;
}

/** 翻译端点返回的 `path`：`template` = AI 不可用的原样返回；`ai:<provider>` = 真翻译。 */
export type TranslatePath = string;

export interface TranslateResponse {
  /** 字段名 → 译文（template 路径下 = 原文） */
  fields: Record<string, string>;
  path: TranslatePath;
  /** 任务键（后端固定 `trade_doc_translate`） */
  task?: string;
  /** `path="none"` 时的说明 */
  detail?: string;
}

export interface TranslateRequest {
  fields: Record<string, string>;
  /** 目标语言；当前后端固定 en（保留字段以便未来扩展） */
  target?: string;
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 文本里有没有中日韩统一表意文字（用来判断"这字段是不是中文待译"）。 */
export function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}

/**
 * 从 `raw_payload.custom` 里抽"含中文的文本字段"。
 *
 * 规则（与后端写入通道对齐）：
 * - 只认 manifest 声明且 `control=text` 的键（日期/数字/布尔/图片/对象都不翻）；
 * - 值必须是**非空字符串**且**至少含一个汉字**（已填成英文的字段不重复翻）；
 * - 值从 `custom` 取，不去拿上游快照/派生值 —— 后端翻译写回的也只有 custom。
 */
export function collectTranslatableFields(
  docType: string,
  custom: Record<string, unknown> | null | undefined,
): TranslatableField[] {
  if (!custom) return [];
  const out: TranslatableField[] = [];
  for (const field of listCustomFields(docType)) {
    if (field.control !== "text") continue;
    const value = custom[field.name];
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!text || !hasCjk(text)) continue;
    out.push({
      name: field.name,
      label: field.spec.description ?? field.name,
      text,
    });
  }
  return out;
}

/** 勾选状态 → 翻译请求体（`{字段名: 原文}`）；空选返回空对象（调用方不要发请求）。 */
export function buildTranslateFields(
  fields: TranslatableField[],
  selected: Record<string, boolean>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    if (selected[field.name] !== false) out[field.name] = field.text;
  }
  return out;
}

/** `path=template` = AI 不可用（后端原样返回），UI 必须提示人工翻译。 */
export function isTemplateFallback(path: TranslatePath): boolean {
  return path === "template";
}

/** `path=ai:<provider>` → provider 名；不是 AI 路径返回 null。 */
export function aiProviderOf(path: TranslatePath): string | null {
  return path.startsWith("ai:") ? path.slice(3) || null : null;
}

/** 路径的人话（用于结果区标题；不用它决定是否算"已翻译"）。 */
export function translatePathLabel(path: TranslatePath): string {
  if (path === "none") return "没有可翻译的字段";
  if (isTemplateFallback(path)) return "AI 不可用（模板降级：原样返回）";
  const provider = aiProviderOf(path);
  return provider ? `AI 翻译（${provider}）` : `已返回（${path}）`;
}

/**
 * 单行译文是否真的变了（用于标注"未翻译/回退原文"）。
 *
 * 后端解析层对"模型没译到的键"会**回退原文**（`parse_translation` 不丢数据），
 * AI 路径下也可能个别行等于原文 —— UI 逐行标出来，避免把回退当成功。
 */
export function isUnchangedTranslation(original: string, translated: string): boolean {
  return original.trim() === translated.trim();
}
