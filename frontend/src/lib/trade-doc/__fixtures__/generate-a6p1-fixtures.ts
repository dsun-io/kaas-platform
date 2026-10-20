/**
 * 重新生成「A6 剩余 P1 变体」的逐字节基线（合同双语条款 + G7–G10/G12）。
 *
 * 与 `generate-fx-fixtures.ts` 分开：那份管双币种（A6-1），这份管 P1 增补
 * （引用链/税号/CI 双栏/CI 银行块/合同双语/ PI P2）。数据源 `sample-data-a6p1.json`，
 * 每类单证在 `base` 之上叠自己的 `per_doc` 字段。
 *
 * 什么时候该跑：
 *   · 改了 `sample-data-a6p1.json`（样例数据内容变了，基线自然跟着变）；
 * 什么时候**不该**跑：
 *   · 改了模板/渲染器 —— 那时基线不一致正是要报出来的问题。
 *
 * 用法（仓库根目录）：
 *   node frontend/node_modules/tsx/dist/cli.mjs \
 *     frontend/src/lib/trade-doc/__fixtures__/generate-a6p1-fixtures.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderTradeDoc } from "../render";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DATA = join(ROOT, "sample-data-a6p1.json");
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
  const suffix = docType === "contract" ? "bilingual" : "a6p1";
  writeFileSync(join(OUT, `sample_${docType}_${suffix}.html`), normalized, "utf-8");
  console.log(`  ${docType.padEnd(10)} ${normalized.length} 字符`);
}

console.log(`\n✓ 已重新生成 ${payload.doc_types.length} 份 P1 变体基线 → ${OUT}`);
