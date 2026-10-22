#!/usr/bin/env node
/**
 * UI 交互模式静态门禁（P0-C，**先 shadow**）。
 *
 * 为什么需要：`ui:standards` 只管"视觉/语义合规"（h1、th scope、硬编码色…），
 * 但 UI 审计里反复出现的 P0/P1 是**交互模式**问题，占位组件早就有了、页面却各写各的：
 *   · 危险操作 `window.confirm`（无法展示后端 403/409 原因、无法 pending）；
 *   · 手写 `<table>`（表头/空态/加载/分页各页飘）；
 *   · 数据区纯文本「加载中/暂无/加载失败」（失败被渲染成空态）；
 *   · `useMutation` 没有 `onError`（失败静默）；
 *   · 硬编码 `page_size` 却不接 `PaginationBar`（列表只能看前 N 条）。
 *
 * 规则（全部可机检；R4 用 TypeScript AST，避免正则误报）：
 *   R1 no-native-dialog          禁 `window.confirm/alert/prompt`，也禁裸全局调用
 *   R2 no-bare-table             禁业务代码裸 `<table>`（白名单：ui/table.tsx、ui/virtual-table.tsx）
 *   R3 no-plain-text-state       数据区纯文本「加载中/暂无/加载失败」
 *   R4 use-mutation-on-error     `useMutation({...})` 缺 `onError`
 *   R5 page-size-without-pagination  硬编码 `page_size: <数字>` 且文件里没有 PaginationBar
 *
 * 用法（cwd=frontend）：
 *   pnpm ui:patterns              # shadow：只打印清单，**退出 0**
 *   pnpm ui:patterns --strict     # 有违规即退出 1（CI 转强制后用它）
 *   pnpm ui:patterns --json       # 机器可读
 *   pnpm ui:patterns --root <dir> # 只扫指定目录（fixture 自测用）
 *
 * **转强制时间点（重要）**：shadow 期 2026-10-23 → **2026-10-30**（一周）。
 * P0-B（三态/确认/防重）回填完成后，把本脚本默认行为改成 `--strict` 语义
 * （即默认 exit 1，并删掉 shadow 文案），届时 CI 增加 `pnpm ui:patterns` 步骤。
 * 在那之前**不要**因为本门禁红就去改规则——违规是存量、由 P0-B/后续批次按页清。
 *
 * 已知盲区（有意不报，避免误报拖垮可信度）：
 *   · `useMutation` 首个参数不是对象字面量（变量/工厂函数）→ 无法静态判断，计入"跳过"；
 *   · 对象字面量里带 `...spread` 且无显式 onError → 可能由 spread 提供，计入"跳过"；
 *   · 纯文本状态只认 JSX 文本节点，`<EmptyState title="…"/>` 这类正当用法不会命中。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RULES = {
  nativeDialog: "no-native-dialog",
  bareTable: "no-bare-table",
  plainTextState: "no-plain-text-state",
  mutationOnError: "use-mutation-on-error",
  pageSizePagination: "page-size-without-pagination",
};

/** 规则中文说明（报告里按规则分组打印）。 */
const RULE_LABELS = {
  [RULES.nativeDialog]: "禁原生弹窗（window.confirm/alert/prompt）",
  [RULES.bareTable]: "禁裸 <table>（用共享 DataTable / ui/table）",
  [RULES.plainTextState]: "禁数据区纯文本状态（用 LoadingBlock/EmptyState/ErrorState）",
  [RULES.mutationOnError]: "useMutation 必须有 onError（失败不能静默）",
  [RULES.pageSizePagination]: "硬编码 page_size 必须接 PaginationBar",
};

/** R2 白名单：这些文件本身就是共享表格原语。 */
const BARE_TABLE_WHITELIST = new Set([
  "src/components/ui/table.tsx",
  "src/components/ui/virtual-table.tsx",
]);

/** 扫描根（相对 root）。 */
const SCAN_ROOTS = ["src/app", "src/components"];
const SKIP_DIR_RE = /(node_modules|\.next|\.next-build|coverage|test-results|playwright-report|__tests__|mocks)[\\/]/;
const SKIP_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/;

let ts = null;
try {
  // 项目 devDependency（frontend/node_modules/typescript）；R4 必须走 AST。
  ts = require("typescript");
} catch {
  ts = null;
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function lineOf(source, offset) {
  const { line, character } = source.getLineAndCharacterOfPosition(offset);
  return { line: line + 1, column: character + 1 };
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_RE.test(full + path.sep)) continue;
      walk(full, out);
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      if (SKIP_FILE_RE.test(entry.name)) continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * 分析一段源码，返回违规与跳过项（纯函数，供 fixture 测试直接用）。
 * @param {string} rel 相对 frontend 根的 posix 路径
 * @param {string} text 源码
 */
function analyzeSource(rel, text) {
  const violations = [];
  const skipped = [];
  if (!ts) {
    return {
      violations,
      skipped: [{ rule: RULES.mutationOnError, file: rel, reason: "缺少 typescript 依赖，R4 无法执行" }],
    };
  }
  const scriptKind = rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKind);

  const add = (offset, rule, message) => {
    const pos = lineOf(source, offset);
    violations.push({ rule, file: rel, line: pos.line, column: pos.column, message });
  };

  const visit = (node) => {
    // ── R1 原生弹窗 ──────────────────────────────────────────────────
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ["confirm", "alert", "prompt"].includes(callee.name.text)
      ) {
        const owner = callee.expression;
        if (ts.isIdentifier(owner) && (owner.text === "window" || owner.text === "globalThis")) {
          add(
            node.getStart(source),
            RULES.nativeDialog,
            `禁止 window.${callee.name.text}()：无法展示后端原因/无法 pending；请用 ConfirmDialog 或页面错误态`,
          );
        }
      } else if (
        ts.isIdentifier(callee) &&
        ["confirm", "alert", "prompt"].includes(callee.text)
      ) {
        add(
          node.getStart(source),
          RULES.nativeDialog,
          `禁止裸 ${callee.text}()（全局弹窗）；请用 ConfirmDialog 或 ErrorState`,
        );
      }
    }

    // ── R2 裸 <table> ────────────────────────────────────────────────
    if (
      (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) &&
      !BARE_TABLE_WHITELIST.has(rel)
    ) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      // 大小写敏感：`<table>` 是原生标签，`<Table>` 是共享 ui/table 组件（合法）
      if (opening.tagName.getText(source) === "table") {
        add(
          node.getStart(source),
          RULES.bareTable,
          "禁止裸 <table>（th scope/空态/分页会各写各的）；请用共享 DataTable",
        );
      }
    }

    // ── R3 纯文本状态 ────────────────────────────────────────────────
    // 只认"整块数据区里的一句状态"：关键词要出现在句首附近（前面最多 6 个字且无
    // 句读），整段不超过 24 字。这样「说明性长文案里顺带提到'暂无'」不会误报，
    // 而「加载失败，请稍后重试」这种裸文案仍然命中。
    if (ts.isJsxText(node)) {
      const label = node.text.trim().replace(/\s+/g, " ");
      if (
        label &&
        label.length <= 24 &&
        /^[^，。；：！？]{0,6}(?:加载中|加载失败|暂无(?!法))/.test(label)
      ) {
        add(
          node.getStart(source),
          RULES.plainTextState,
          `数据区纯文本状态「${label.slice(0, 24)}」；请用 LoadingBlock / EmptyState / ErrorState`,
        );
      }
    }

    // ── R4 useMutation 缺 onError ───────────────────────────────────
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "useMutation"
    ) {
      const first = node.arguments[0];
      if (!first || !ts.isObjectLiteralExpression(first)) {
        skipped.push({
          rule: RULES.mutationOnError,
          file: rel,
          line: lineOf(source, node.getStart(source)).line,
          reason: "首个参数不是对象字面量，无法静态判断",
        });
      } else {
        let hasOnError = false;
        let hasSpread = false;
        for (const prop of first.properties) {
          if (ts.isSpreadAssignment(prop)) hasSpread = true;
          const name =
            "name" in prop && prop.name && ts.isIdentifier(prop.name)
              ? prop.name.text
              : "name" in prop && prop.name
                ? prop.name.getText(source)
                : null;
          if (name === "onError") hasOnError = true;
        }
        if (!hasOnError && !hasSpread) {
          add(
            node.getStart(source),
            RULES.mutationOnError,
            "useMutation 缺少 onError：失败会静默；请加 onError（toast/错误态）或改用 useAsyncAction",
          );
        } else if (!hasOnError && hasSpread) {
          skipped.push({
            rule: RULES.mutationOnError,
            file: rel,
            line: lineOf(source, node.getStart(source)).line,
            reason: "对象字面量含 spread，onError 可能由 spread 提供",
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  // ── R5 硬编码 page_size 但没接 PaginationBar ─────────────────────
  const hasPaginationBar = /\bPaginationBar\b/.test(text);
  for (const match of text.matchAll(/\bpage_size\s*:\s*(\d+)\b/g)) {
    if (hasPaginationBar) continue;
    const offset = match.index ?? 0;
    add(
      offset,
      RULES.pageSizePagination,
      `硬编码 page_size: ${match[1]} 但文件未使用 PaginationBar：列表只能看前 ${match[1]} 条`,
    );
  }

  return { violations, skipped };
}

/** 扫描整棵树（默认 frontend 根）。 */
function checkTree(root) {
  const files = [];
  for (const scanRoot of SCAN_ROOTS) {
    const abs = path.join(root, scanRoot);
    if (fs.existsSync(abs)) walk(abs, files);
  }
  const violations = [];
  const skipped = [];
  for (const file of files) {
    const rel = toPosix(path.relative(root, file));
    const text = fs.readFileSync(file, "utf8");
    const result = analyzeSource(rel, text);
    violations.push(...result.violations);
    skipped.push(...result.skipped);
  }
  return { root, scannedFiles: files.length, violations, skipped };
}

function printReport(result, { strict }) {
  const byRule = new Map();
  for (const v of result.violations) {
    if (!byRule.has(v.rule)) byRule.set(v.rule, []);
    byRule.get(v.rule).push(v);
  }

  const line = (text = "") => process.stdout.write(`${text}\n`);
  line("── UI 交互模式门禁（P0-C）──");
  line(`扫描文件：${result.scannedFiles}（src/app + src/components，排除测试/mocks/ui 原语）`);
  line(`违规总数：${result.violations.length}（按规则）`);
  for (const rule of Object.values(RULES)) {
    const count = byRule.get(rule)?.length ?? 0;
    line(`  ${count === 0 ? "✓" : "⚠"} ${rule}  ${count}  ${RULE_LABELS[rule]}`);
  }
  line();

  for (const rule of Object.values(RULES)) {
    const list = byRule.get(rule);
    if (!list || list.length === 0) continue;
    line(`[${rule}] ${list.length} 处`);
    for (const v of list.slice(0, 300)) {
      line(`  ${v.file}:${v.line}:${v.column}  ${v.message}`);
    }
    if (list.length > 300) line(`  … 其余 ${list.length - 300} 处省略（--json 可拿全量）`);
    line();
  }

  if (result.skipped.length > 0) {
    line(`ℹ 跳过（静态不可判定，${result.skipped.length} 处）：`);
    for (const s of result.skipped.slice(0, 50)) {
      line(`  - ${s.file}:${s.line ?? "?"} ${s.reason}`);
    }
    if (result.skipped.length > 50) line(`  … 其余 ${result.skipped.length - 50} 处省略`);
    line();
  }

  if (strict) {
    if (result.violations.length > 0) {
      line(
        `✗ --strict：${result.violations.length} 处违规（规则见文件头；存量由 P0-B 按页回填）`,
      );
    }
  } else {
    line(
      `shadow 模式：不阻塞（违规 ${result.violations.length} 处，退出 0）。` +
        " 转强制时间点：2026-10-30（P0-B 回填完成后默认 exit 1）。",
    );
  }
}

function parseArgv(argv) {
  let root = path.join(__dirname, "..");
  const rootIndex = argv.indexOf("--root");
  if (rootIndex >= 0 && argv[rootIndex + 1]) {
    root = path.resolve(argv[rootIndex + 1]);
  }
  return {
    root,
    strict: argv.includes("--strict"),
    json: argv.includes("--json"),
  };
}

function main(argv) {
  const { root, strict, json } = parseArgv(argv);
  if (!fs.existsSync(root)) {
    process.stderr.write(`ui:patterns: root 不存在：${root}\n`);
    process.exit(2);
  }
  const result = checkTree(root);

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printReport(result, { strict });
  }

  if (strict && result.violations.length > 0) process.exit(1);
  process.exit(0);
}

module.exports = {
  RULES,
  RULE_LABELS,
  BARE_TABLE_WHITELIST,
  analyzeSource,
  checkTree,
};

if (require.main === module) main(process.argv.slice(2));
