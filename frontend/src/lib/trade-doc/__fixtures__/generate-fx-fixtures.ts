/**
 * 重新生成「双币种 PI/CI 变体」的逐字节基线（A6-1）。
 *
 * 为什么单独一个生成器、而不是并进 `scripts/gen-trade-doc-fixtures.ts`：
 * 那个脚本负责 18 类**单币种**基线（历史迁移等价性证明），双币种是新增变体、
 * 数据源也不同（`sample-data-fx.json`）。分开生成，谁都不用改对方的输出。
 *
 * 什么时候该跑：
 *   · 改了 `sample-data-fx.json`（样例数据内容变了，基线自然要跟着变）；
 * 什么时候**不该**跑：
 *   · 改了模板/渲染器 —— 那时基线不一致正是要报出来的问题。
 *
 * 用法（仓库根目录）：
 *   node frontend/node_modules/tsx/dist/cli.mjs \
 *     frontend/src/lib/trade-doc/__fixtures__/generate-fx-fixtures.ts
 *
 * 产物：`frontend/src/lib/trade-doc/__fixtures__/html/sample_{pi,ci}_fx.html`（LF 存储）
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderTradeDoc } from "../render";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DATA = join(ROOT, "sample-data-fx.json");
const OUT = join(HERE, "html");

const payload = JSON.parse(readFileSync(DATA, "utf-8")) as {
  doc_types: string[];
  base: Record<string, unknown>;
};

mkdirSync(OUT, { recursive: true });

for (const docType of payload.doc_types) {
  const html = renderTradeDoc(docType, payload.base);
  // 统一写 LF：测试是严格逐字节比对（Windows 下写成 CRLF 会全线失败）
  const normalized = html.replace(/\r\n/g, "\n");
  writeFileSync(join(OUT, `sample_${docType}_fx.html`), normalized, "utf-8");
  console.log(`  ${docType.padEnd(6)} ${normalized.length} 字符`);
}

console.log(`\n✓ 已重新生成 ${payload.doc_types.length} 份双币种基线 → ${OUT}`);
