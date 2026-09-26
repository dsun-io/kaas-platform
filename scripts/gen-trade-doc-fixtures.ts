/**
 * 重新生成 18 类单证的「逐字节回归基线」。
 *
 * 什么时候该跑：
 *   · 改了 `sample-data.json`（样例数据的**内容**变了，基准自然要跟着变）
 * 什么时候**不该**跑：
 *   · 改了模板或渲染器 —— 那时基线不一致正是要报出来的问题，
 *     跑本脚本等于把基准改成"自己现在的输出"，回归保护就废了。
 *
 * 跑完必须做的一致性证明（否则基线只是"TS 对 TS"）：
 *   用归档的 Python 渲染器（archive/2026-09-trade-doc-xprime-python）渲染同一份数据，
 *   与新基线逐字节比对 —— 见 scripts/verify-trade-doc-fixtures.py
 *
 * 用法（在 kaas-platform 根目录）：
 *   npx tsx scripts/gen-trade-doc-fixtures.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderTradeDoc } from "../frontend/src/lib/trade-doc/render";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DATA = join(ROOT, "frontend/src/lib/trade-doc/sample-data.json");
const OUT = join(ROOT, "frontend/src/lib/trade-doc/__fixtures__/html");

const payload = JSON.parse(readFileSync(DATA, "utf-8")) as {
  doc_types: string[];
  base: Record<string, unknown>;
  other_extra: Record<string, unknown>;
};

mkdirSync(OUT, { recursive: true });

for (const docType of payload.doc_types) {
  const data = {
    ...payload.base,
    ...(docType === "other" ? payload.other_extra : {}),
  };
  const html = renderTradeDoc(docType, data);
  // 统一写 LF：测试是严格逐字节比对，Windows 下写成 CRLF 会导致全线失败
  const normalized = html.replace(/\r\n/g, "\n");
  writeFileSync(join(OUT, `sample_${docType}.html`), normalized, "utf-8");
  console.log(`  ${docType.padEnd(22)} ${normalized.length} 字符`);
}

console.log(`\n✓ 已重新生成 ${payload.doc_types.length} 份基线 → ${OUT}`);
console.log("  下一步必须跑：python scripts/verify-trade-doc-fixtures.py");
