/**
 * 调研产品 CSV 导出（纯函数 + 浏览器下载，从 page.tsx 抽出，落地格式不变）。
 *
 * 口径：表头固定 18 列、`can_supply` 归一成 TRUE/FALSE/空、字符串统一双引号转义、
 * 文件带 UTF-8 BOM（Excel 直接打开不乱码）、文件名 `market-research-YYYY-MM-DD.csv`。
 */
import type { ResearchProduct } from "./types";

const CSV_HEADER = [
  "product_name",
  "product_name_cn",
  "spec_raw",
  "country",
  "city",
  "shop_name",
  "shop_type",
  "phone",
  "email",
  "website",
  "link_url",
  "address",
  "product_category",
  "price_local",
  "price_currency",
  "can_supply",
  "supply_notes",
  "market_note",
] as const;

/** 生成 CSV 文本（含 BOM；纯函数，便于单测/复用）。 */
export function buildResearchCsv(rows: ResearchProduct[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = rows.map((p) =>
    CSV_HEADER.map((k) => {
      if (k === "can_supply") {
        return esc(
          p.can_supply === null ? "" : p.can_supply ? "TRUE" : "FALSE",
        );
      }
      return esc((p as unknown as Record<string, unknown>)[k]);
    }).join(","),
  );
  return "\uFEFF" + [CSV_HEADER.join(","), ...lines].join("\n");
}

/** 触发浏览器下载（唯一副作用集中在这里）。 */
export function downloadResearchCsv(rows: ResearchProduct[]): void {
  const blob = new Blob([buildResearchCsv(rows)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `market-research-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
