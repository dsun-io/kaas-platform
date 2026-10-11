/**
 * 单证模板占位符 ↔ manifest 字段定义：校验 + 修复（正式工具，替代一次性补丁脚本）
 *
 * 为什么需要它
 * ------------
 * 渲染器的口径是「**缺失字段渲染为空串**，单据上不残留 `$placeholder`」。
 * 这条口径很好（不会印出 `$remarks` 这种鬼东西），但有副作用：
 * **占位符拼错、或在模板里用了但 manifest 没声明，都不会报错** ——
 * 只是那一格静静空白。
 *
 * 历史现场：PI 模板用着 `$remarks` / `$shipping_marks` / `$country_of_origin`，
 * 而 `manifest.pi.fields` 里一个都没有 ⇒ 单证工位的「填写单据内容」面板
 * （由 manifest 驱动）**根本列不出唛头与备注**。这类不一致肉眼看模板查不出来。
 *
 * 判定
 * ----
 * - **ERROR**：模板用了 `$字段`，manifest 未声明、也非渲染器派生 ⇒ 界面填不到该字段
 * - **WARN** ：manifest 声明了但模板没直接用（行项列由渲染器按固定列生成，属正常）
 *
 * 用法（仓库根目录）
 * ----------------
 *   node <node> frontend/node_modules/tsx/dist/cli.mjs scripts/check-trade-doc-placeholders.ts
 *   ... --json              机器可读
 *   ... --fix               打印修复方案（**不改盘**）
 *   ... --fix --write       真正写入 manifest.json（外科式插入，不重排全文）
 *
 * `--fix --write` 的安全措施：只插字段声明（`required: false`，不影响必填/签发判定）、
 * 保持原有排版（不做 `JSON.stringify` 重排）、写前用 `JSON.parse` 校验、
 * 校验不过就不写。可无限重复执行（已存在的字段自动跳过）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, "..", "frontend", "src", "lib", "trade-doc", "manifest.json");
const ASSETS_PATH = join(HERE, "..", "frontend", "src", "lib", "trade-doc", "assets.json");

interface FieldSpec {
  type?: string;
  required?: boolean;
  description?: string;
}

const manifestText = readFileSync(MANIFEST_PATH, "utf-8");
const manifest = JSON.parse(manifestText) as Record<
  string,
  { name_zh?: string; fields?: Record<string, FieldSpec> }
>;
const assets = JSON.parse(readFileSync(ASSETS_PATH, "utf-8")) as {
  templates: Record<string, string>;
};

/** 渲染器**派生**的字段（模板可用，但不需要在 manifest 声明 —— 人工填没有意义） */
const DERIVED_FIELDS = new Set([
  "total_amount_words",
  "insured_amount_words",
  "total_qty",
  "total_packages",
  "total_gross_weight",
  "total_net_weight",
  "total_volume",
  "seller_name",
  "footer_note",
]);

/** 新声明字段的默认口径（类型 + 中文说明）：manifest 是给「填写内容」面板用的，说明必须是人话 */
const FIELD_HINTS: Record<string, FieldSpec> = {
  country_of_origin: { type: "string", description: "原产国（如 China）" },
  remarks: { type: "string", description: "备注（支持多行：换行会保留为 <br>，逐点换行）" },
  shipping_marks: { type: "string", description: "运输唛头（外包装标记，须与发票/装箱单一致）" },
  place_of_issue: { type: "string", description: "签发地" },
  notify_party: { type: "object", description: "通知方（公司名/地址/联系方式）" },
  port_of_loading: { type: "string", description: "装运港" },
  port_of_destination: { type: "string", description: "目的港" },
  vessel: { type: "string", description: "船名 / 航次（空运填航班）" },
  total_amount: { type: "number", description: "总金额" },
  invoice_no: { type: "string", description: "发票号" },
  lc_no: { type: "string", description: "信用证号（L/C No.）" },
  seller: { type: "object", description: "卖方信息（默认取企业主体，可手工覆盖）" },
};

/** 与 render.ts 的替换正则同源：`$$` 是转义，不算占位符 */
function extractPlaceholders(template: string): Set<string> {
  const found = new Set<string>();
  const re = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(template)) !== null) {
    if (match[0] === "$$") continue;
    const key = match[1] ?? match[2];
    if (key) found.add(key);
  }
  return found;
}

interface DocReport {
  doc_type: string;
  name_zh: string;
  undeclared: string[];
  unused: string[];
}

const reports: DocReport[] = [];
for (const [docType, spec] of Object.entries(manifest)) {
  const template = assets.templates[docType];
  if (!template) {
    reports.push({ doc_type: docType, name_zh: spec.name_zh ?? "", undeclared: ["<模板缺失>"], unused: [] });
    continue;
  }
  const declared = new Set(Object.keys(spec.fields ?? {}));
  const used = extractPlaceholders(template);
  reports.push({
    doc_type: docType,
    name_zh: spec.name_zh ?? "",
    undeclared: [...used].filter((f) => !declared.has(f) && !DERIVED_FIELDS.has(f)).sort(),
    unused: [...declared].filter((f) => !used.has(f)).sort(),
  });
}

const wantsJson = process.argv.includes("--json");
const wantsFix = process.argv.includes("--fix");
const wantsWrite = process.argv.includes("--write");
/** `--dump <path>`：把修补后的**候选文本**写到别处，供人工核对（不动 manifest 本身） */
const dumpIndex = process.argv.indexOf("--dump");
const dumpPath = dumpIndex >= 0 ? process.argv[dumpIndex + 1] : undefined;
const withErrors = reports.filter((r) => r.undeclared.length > 0);

if (wantsJson && !wantsFix) {
  console.log(JSON.stringify({ ok: withErrors.length === 0, reports }, null, 2));
  process.exit(withErrors.length > 0 ? 1 : 0);
}

if (!wantsFix) {
  console.log("单证模板占位符 ↔ manifest 字段定义\n" + "=".repeat(66));
  for (const r of reports) {
    const tag = r.undeclared.length > 0 ? "FAIL" : r.unused.length > 0 ? "WARN" : "OK  ";
    const detail =
      r.undeclared.length > 0
        ? `模板用了但 manifest 未声明：${r.undeclared.join(", ")}`
        : r.unused.length > 0
          ? `manifest 声明但模板未直接用：${r.unused.join(", ")}`
          : "一致";
    console.log(`  ${tag}  ${r.doc_type.padEnd(22)} ${r.name_zh}  ${detail}`);
  }
  console.log();
  if (withErrors.length > 0) {
    console.log(
      `✗ ${withErrors.length} 类存在「模板用到但界面填不到」的字段 —— 渲染器对缺失字段输出空串，` +
        `所以**不会报错、只会静静空白**。`,
    );
    console.log("  用 --fix 看修复方案，--fix --write 落盘。");
  } else {
    console.log("✓ 全部模板的占位符都已在 manifest 里声明（或属渲染器派生）。");
  }
  process.exit(withErrors.length > 0 ? 1 : 0);
}

// ── 修复：在对应 doc_type 的 fields 末尾外科式插入字段声明 ──────────────────

/** 从 `{` 处向后找配对的 `}`（跳过字符串内的括号与转义） */
function matchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("manifest.json 里大括号不配对");
}

let text = manifestText;
const applied: { doc_type: string; field: string }[] = [];

/** 生成一条字段声明（与 manifest 现有排版一致：6 空格键、8 空格属性） */
function entryText(field: string): string {
  const spec = FIELD_HINTS[field] ?? { type: "string", description: field };
  return (
    `      "${field}": {\n` +
    `        "type": "${spec.type}",\n` +
    `        "required": false,\n` +
    `        "description": ${JSON.stringify(spec.description ?? field)}\n` +
    `      }`
  );
}

for (const report of withErrors) {
  const docType = report.doc_type;
  for (const field of report.undeclared) {
    const spec = FIELD_HINTS[field] ?? { type: "string", description: field };
    console.log(`[PLAN] ${docType}.${field} → ${spec.type}  ${spec.description ?? ""}`);
    applied.push({ doc_type: docType, field });
  }
  // 干跑时不改文本；但给了 --dump 就要把候选文本算出来供核对
  if (!wantsWrite && !dumpPath) continue;

  // 每个 doc_type **一次性**插入它缺的全部字段：插完再逐个重算索引容易错位
  const blockStart = text.indexOf(`\n  "${docType}": {`);
  if (blockStart < 0) throw new Error(`manifest 里找不到 doc_type: ${docType}`);
  const fieldsKey = text.indexOf('"fields":', blockStart);
  if (fieldsKey < 0) throw new Error(`${docType} 没有 fields`);
  const openBrace = text.indexOf("{", fieldsKey);
  const closeBrace = matchingBrace(text, openBrace);
  const lineStart = text.lastIndexOf("\n", closeBrace) + 1;

  // fields 内最后一个条目原本没有尾逗号，需要补一个。
  // ⚠️ 这里的坑：补逗号会让 `text` 变长 1 个字符，**之后不能再复用 lineStart**
  // （它指向插入点之后，会整体偏移 → 多切出一个换行、JSON 立刻非法）。
  // 所以先把 head/tail 切开，再在 head 里补逗号，最后拼接。
  let prev = lineStart - 1;
  while (prev >= 0 && " \t\r\n".includes(text[prev] ?? "")) prev -= 1;
  const head = text.slice(0, lineStart);
  const tail = text.slice(lineStart);
  const headWithComma =
    text[prev] === "}" ? `${head.slice(0, prev + 1)},${head.slice(prev + 1)}` : head;
  const inserted = report.undeclared.map(entryText).join(",\n");
  // 注意：head 末尾的逗号已经把「原最后一个字段」与「第一个新字段」隔开；
  // inserted 内部用 `,\n` 分隔，**末尾不能再加逗号**（否则 `},\n    }` 非法 JSON）。
  text = `${headWithComma}${inserted}\n${tail}`;
}

if (dumpPath) {
  writeFileSync(dumpPath, text, "utf-8");
  console.log(`[DUMP] 候选文本已写到 ${dumpPath}（manifest.json 未改动）`);
}

try {
  JSON.parse(text);
} catch (error) {
  console.error(
    `[FATAL] 修补后的 manifest 不是合法 JSON，**未写入**：${(error as Error).message}`,
  );
  process.exit(2);
}

if (!wantsWrite) {
  console.log(
    `\n共需声明 ${applied.length} 个字段（上面是方案）。加 --write 落盘；` +
      `本工具只插入 required:false 的字段声明，不改必填判定，也不重排 JSON。`,
  );
  process.exit(0);
}

writeFileSync(MANIFEST_PATH, text, "utf-8");
console.log(
  JSON.stringify({ written: MANIFEST_PATH, declared: applied.length }, null, 2),
);
console.log("下一步：重跑本脚本（应为 0 个 ERROR）并跑前端测试。");
