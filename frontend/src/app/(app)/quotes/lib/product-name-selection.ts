/**
 * 报价行 · 「客户英文名（本单使用）」的选择口径 —— **纯函数，可单测**。
 *
 * 背景（A 项 2026-10-24）：同一产品可以配置多个英文名（团队级
 * `product_profiles.info.name_en_list`，主名在前）。报价行里的 `product_name`
 * 是**本单使用的那一个**，随「报价行 → 订单 → 单证」快照走；同一客户下次报
 * 同一产品时默认沿用上次选的名，没有历史才用产品默认英文名。
 *
 * 这里只放两件与 UI 无关的判断：
 *  1. 下拉选项怎么来（去空白 / 丢空串 / 大小写去重、默认名在前）；
 *  2. 换客户时要清哪些行（手动选过的行不动 —— 那是业务对这个客户的明确选择）。
 *
 * 权威口径仍在内核：偏好查询 `GET /quotes/product-name-preference` 与
 * `backend/worker/src/quote_api.py:quote_product_name_preference`。前端只做搬运，
 * 不在这里重新定义"哪个名是主名"。
 */
import type { LineDraft } from "../components/quote-line-card";

/**
 * 英文名下拉选项：`[默认名, ...其它英文名]` —— 去空白、丢空串、**大小写不敏感去重**
 * （保留首次出现的写法，默认名因此永远排第一）。
 */
export function dedupeNameOptions(
  primary: string | null | undefined,
  aliases?: readonly string[] | null,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [primary ?? "", ...(aliases ?? [])]) {
    const name = String(raw ?? "").trim();
    if (!name) continue;
    const folded = name.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(name);
  }
  return out;
}

/**
 * 客户历史偏好名 → 本次要用的名。
 *
 * 口径（与后端偏好接口的语义对齐）：
 * - 偏好名必须**命中本产品的某个英文名**（大小写不敏感）才采用 —— 团队改过英文名后，
 *   历史偏好可能已经不在选项里，这时**不能**把它写进本单（单证会印一个产品资料里
 *   不存在的名字）；
 * - 没历史 / 没命中 ⇒ 用产品默认英文名（选项第一项）；
 * - 一个选项都没有 ⇒ `""`（调用方回落到 `formulas.name_en` / 中文名）。
 */
export function resolveDefaultNameEn(
  options: readonly string[],
  preferred: string | null | undefined,
): string {
  const wanted = String(preferred ?? "")
    .trim()
    .toLowerCase();
  if (wanted) {
    const hit = options.find((name) => name.toLowerCase() === wanted);
    if (hit) return hit;
  }
  return options[0] ?? "";
}

/**
 * 换客户：**手动选过英文名的行原样保留**（业务对那个客户的明确选择），其余行清空
 * `nameEn` —— 由行卡按新客户的历史偏好重新解析默认名。
 *
 * 注意：只在「用户换客户」时调用；草稿初始化/恢复不能走这里，否则会把已解析的默认名
 * 误清一遍。已经是空的行走同一份数组（不制造无意义的 re-render）。
 */
export function resetNameOnCustomerChange(lines: LineDraft[]): LineDraft[] {
  let changed = false;
  const next = lines.map((line) => {
    if (line.nameEnManual || !line.nameEn) return line;
    changed = true;
    return { ...line, nameEn: "" };
  });
  return changed ? next : lines;
}
