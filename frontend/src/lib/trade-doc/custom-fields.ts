/**
 * 单据手工填写内容（`trade_docs.raw_payload.custom`）的表单口径。
 *
 * 为什么单独一个模块
 * ------------------
 * 字段清单来自模板 manifest（`getTemplateFields`），而「回填 / 校验 / 组包」
 * 这套规则是**纯函数**：抽出来才能单测，界面只负责渲染与交互。
 *
 * 为什么 custom 是「优先」的
 * --------------------------
 * 后端 `build_render_data()` 的顺序是：上游快照 → 企业主体 → 默认条款 → **custom 最后覆盖**。
 * 所以手工填的值能盖掉上游带入的值（补一句银行信息、改一次唛头），
 * 而没填的字段仍然用上游数据 —— 不需要把整张单据重填一遍。
 */
import { getTemplateFields } from "./render";

export interface CustomFieldSpec {
  type?: string;
  required?: boolean;
  description?: string;
}

/** 表单控件种类：由 manifest 的 type 推导，未知 type 退回纯文本 */
export type CustomControl = "text" | "date" | "number" | "boolean" | "json" | "image";

export interface CustomFieldDef {
  name: string;
  spec: CustomFieldSpec;
  control: CustomControl;
  /** 受保护：只能来自上游快照/系统计算，界面不给可编辑控件，服务端也会拒绝 */
  protected: boolean;
}

export interface ParseResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface TradeDocRawPayload {
  sources?: Record<string, unknown>;
  custom?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * 受保护字段：与后端**同一口径**
 * （`kaas_common.trade_doc.payload_shared.PROTECTED_CUSTOM_FIELDS`）。
 *
 * 金额与行项只能来自上游订单/报价或系统计算：一份对外单据的金额若可被手填内容改写，
 * 单证与订单就对不上，而银行/海关正是按这两项审单。
 * 界面这层只是"不给你编辑入口"，**真正的闸门是服务端的 422**
 * （`CUSTOM_FIELD_PROTECTED`）+ 渲染层再挡一次。
 */
export const PROTECTED_FIELDS = ["items", "total_amount"] as const;

/**
 * 渲染器**派生**字段：manifest 里要声明（模板占位符检查用），但**没有手填意义** ——
 * A6-1 的 `fx_block`（双币种金额块）、A6 P1 的合同条款块 / CI 收款账户 / CI 双栏。
 * 不把它们列进「填写内容」表单，否则用户会看到"填 HTML 表格"的荒谬输入框。
 */
export const RENDERER_DERIVED_FIELDS = [
  "fx_block",
  "contract_clauses_block",
  "ci_bank_block",
  "ci_parties_block",
] as const;

export function isRendererDerivedField(name: string): boolean {
  return (RENDERER_DERIVED_FIELDS as readonly string[]).includes(name);
}

export function isProtectedField(name: string): boolean {
  return (PROTECTED_FIELDS as readonly string[]).includes(name);
}

export function controlFor(type?: string): CustomControl {
  switch ((type ?? "string").toLowerCase()) {
    case "date":
      return "date";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
    case "array":
    case "image_list":
      return "json";
    case "image":
      return "image";
    default:
      return "text";
  }
}

/** 该单证类型可手工填的字段（含类型与中文说明），顺序与 manifest 一致 */
export function listCustomFields(docType: string): CustomFieldDef[] {
  const fields = getTemplateFields(docType) as Record<string, CustomFieldSpec> | null;
  if (!fields) return [];
  return Object.entries(fields)
    .filter(([name]) => !isRendererDerivedField(name))
    .map(([name, spec]) => ({
      name,
      spec,
      control: controlFor(spec?.type),
      protected: isProtectedField(name),
    }));
}

/** 已填值 → 表单文本（对象/数组按 2 空格缩进 JSON，便于人工核对） */
export function toInputText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/**
 * 表单文本 → 业务值。
 * **空串 = 不填**（返回 `value: undefined`），由 `buildCustom` 把该键删掉 ——
 * 写空串会让「必填为空」的判断与人工核对都变模糊，渲染器对空值本来也不输出。
 */
export function parseInput(control: CustomControl, text: string): ParseResult {
  const raw = text ?? "";
  if (raw.trim() === "") return { ok: true, value: undefined };
  switch (control) {
    case "number": {
      const num = Number(raw);
      return Number.isFinite(num)
        ? { ok: true, value: num }
        : { ok: false, error: "不是合法数字" };
    }
    case "boolean":
      return { ok: true, value: raw === "true" };
    case "json":
      try {
        return { ok: true, value: JSON.parse(raw) };
      } catch {
        return { ok: false, error: "JSON 解析失败" };
      }
    default:
      // text / date / image（图片位存 data URI 字符串）
      return { ok: true, value: raw };
  }
}

/** 表单值 → 新的 custom（`undefined` 的键删掉，其余覆盖） */
export function buildCustom(
  existing: Record<string, unknown> | null | undefined,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(values)) {
    // 受保护字段一律不写（服务端也会 422 拒绝；这里先保证界面不会把它送上去）
    if (isProtectedField(key)) continue;
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

/**
 * PATCH `/trade-docs/{id}` 的 `raw_payload`。
 *
 * **必须带上 `sources`**：后端 PATCH 是整块替换 `raw_payload`（`COALESCE($4, raw_payload)`），
 * 只发 `custom` 会把上游订单/报价快照一起抹掉 —— 那张单从此回不到上游，
 * 客户页的溯源也断了。这条是踩了就很难发现的坑，所以放在纯函数里并加测试。
 */
export function buildPayloadPatch(
  existingPayload: TradeDocRawPayload | null | undefined,
  custom: Record<string, unknown>,
): TradeDocRawPayload {
  return { ...(existingPayload ?? {}), custom };
}

/** 本地图片文件 → data URI（渲染器的图片白名单只认 `data:` 与 `http(s)`） */
export function readImageAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}
