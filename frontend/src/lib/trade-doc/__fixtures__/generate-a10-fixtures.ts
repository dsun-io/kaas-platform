/**
 * 重新生成「A10 P1 扩展模板」的逐字节基线（`beneficiary_decl` / `saso_coc`）。
 *
 * 与 `generate-a6p1-fixtures.ts` / `generate-fx-fixtures.ts` 分开：数据源
 * `sample-data-a10.json`，**不碰** 18 类主基线（`sample-data.json`）与既有 23 份变体。
 * 这样 `scripts/verify-trade-doc-fixtures.py`（归档 Python 渲染器复验 18 类）口径不变。
 *
 * 什么时候该跑：
 *   · 改了 `sample-data-a10.json`（样例数据内容变了，基线自然跟着变）；
 * 什么时候**不该**跑：
 *   · 改了模板/渲染器 —— 那时基线不一致正是要报出来的问题。
 *
 * 用法（仓库根目录）：
 *   node frontend/node_modules/tsx/dist/cli.mjs \
 *     frontend/src/lib/trade-doc/__fixtures__/generate-a10-fixtures.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderTradeDoc } from "../render";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DATA = join(ROOT, "sample-data-a10.json");
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
  console.log(`  ${docType.padEnd(18)} ${normalized.length} 字符`);
}

console.log(`\n✓ 已重新生成 ${payload.doc_types.length} 份 A10 P1 基线 → ${OUT}`);
