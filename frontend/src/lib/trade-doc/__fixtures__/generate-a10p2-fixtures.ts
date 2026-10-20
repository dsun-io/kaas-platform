/**
 * 重新生成「A10 P2 扩展模板」的逐字节基线（`vessel_cert` / `export_license` / `ciq`）。
 *
 * 与 `generate-a10-fixtures.ts` 分开：数据源 `sample-data-a10p2.json`，不碰
 * 18 类主基线 / A6 变体 / A10 P1 的 25 份基线。
 *
 * 用法（仓库根目录）：
 *   node frontend/node_modules/tsx/dist/cli.mjs \
 *     frontend/src/lib/trade-doc/__fixtures__/generate-a10p2-fixtures.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderTradeDoc } from "../render";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DATA = join(ROOT, "sample-data-a10p2.json");
const OUT = join(HERE, "html");

const payload = JSON.parse(readFileSync(DATA, "utf-8")) as {
  doc_types: string[];
  base: Record<string, unknown>;
  per_doc: Record<string, Record<string, unknown>>;
};

mkdirSync(OUT, { recursive: true });

for (const docType of payload.doc_types) {
  const data = { ...payload.base, ...(payload.per_doc[docType] ?? {}) };
  const html = renderTradeDoc(docType, data);
  const normalized = html.replace(/\r\n/g, "\n");
  writeFileSync(join(OUT, `sample_${docType}.html`), normalized, "utf-8");
  console.log(`  ${docType.padEnd(16)} ${normalized.length} 字符`);
}

console.log(`\n✓ 已重新生成 ${payload.doc_types.length} 份 A10 P2 基线 → ${OUT}`);
