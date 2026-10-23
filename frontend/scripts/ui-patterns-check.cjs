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

/**
 * 显式白名单：按「规则 + 文件」豁免，**必须写理由**（task-27 起）。
 *
 * 只允许两类：
 *   ① **语义误报**——规则的字面命中在这个文件里不是同一个问题（例：page_size 是
 *      下拉选择器的取数上限，不是分页列表）；
 *   ② **真实遗留**——问题成立，但修复落点不在本批写入范围；理由里必须写排期。
 * 白名单不是静默：报告单独打印「白名单 N 处 + 理由」，数字与原因都可以核对。
 */
const ALLOWLIST = {
  [RULES.bareTable]: [
    {
      file: "src/app/(app)/customers/page.tsx",
      reason:
        "交互行表格：客户列表每行是 tabIndex+aria-label+onClick/onKeyDown 的键盘可达容器，共享 DataTable 不支持行级交互容器（需扩公共 API，超出 task-38 写范围）",
    },
    {
      file: "src/app/(app)/orders/components/order-change-banner.tsx",
      reason:
        "特殊表格：变更申请的「字段级旧→新 diff 条」（每行是多字段对比，不是列表数据）；DataTable 无行级多值对比语义，改造成本高于收益（task-36 登记）",
    },
    {
      file: "src/app/(app)/orders/components/order-create/step-items-amount.tsx",
      reason:
        "特殊表格：可编辑货物行（行内输入 + SortableList 拖拽排序）；DataTable 是只读渲染，需扩展行内编辑能力（task-36 登记）",
    },
    {
      file: "src/app/(app)/orders/components/order-items-editor.tsx",
      reason:
        "特殊表格：可编辑货物行（行内输入/删除/新增，整批替换提交）；DataTable 是只读渲染（task-36 登记）",
    },
    {
      file: "src/app/(app)/orders/page.tsx",
      reason:
        "特殊表格：订单列表带列显隐配置 + 密度切换 + 窄屏卡片双渲染（同一数据两套 DOM），且行内「状态/详情」动作依赖行上下文；DataTable 无列配置/行属性插槽，迁移需先扩展 shared（跨批次，task-36 登记）",
    },
    {
      file: "src/app/(app)/receivables/components/receivables-table.tsx",
      reason:
        "特殊表格：逾期行需要行级 data-overdue 与背景高亮（测试与视觉都依赖），DataTable 无行属性插槽；逾期判据依赖页面按订单取到的到期日（task-36 登记）",
    },
    {
      file: "src/app/(app)/trade-docs/page.tsx",
      reason:
        "特殊表格：单证列表带勾选（批量操作）+ 列显隐配置 + 密度切换 + 窄屏卡片双渲染；DataTable 无选择列/列配置能力（跨批次，task-36 登记）",
    },
    {
      file: "src/app/(app)/trade-docs/components/doc-content-versions.tsx",
      reason:
        "特殊表格：版本 diff（每行 = 旧值/新值两列对比 + 选择动作），不是列表数据；DataTable 无行级对比语义（task-36 登记）",
    },
    {
      file: "src/app/(app)/trade-docs/components/doc-items-batch-editor.tsx",
      reason:
        "特殊表格：批量行内编辑（多列可输入 + 行勾选 + 合计行），DataTable 是只读渲染（task-36 登记）",
    },
    {
      file: "src/app/(app)/quotes/components/bulk-import-panel.tsx",
      reason:
        "特殊表格：报价导入结果预览（列由后端模板动态决定 + 吸顶表头 + 200 行截断），DataTable 的静态列定义表达不了动态列（task-35 登记）",
    },
    {
      file: "src/app/(app)/quotes/components/quote-order-edit-dialog.tsx",
      reason:
        "特殊表格：报价行项可编辑表单（每个单元格是受控 Input + 逐行删除/新增），DataTable 只读渲染（task-35 登记）",
    },
    {
      file: "src/app/(app)/pricing-data/components/PricingDataTable.tsx",
      reason:
        "特殊表格：定价矩阵（dims 动态列 + 行选中 aria-current/键盘操作 + 同页动作），DataTable 无动态列/行选中能力；同文件只读汇总表已改 DataTable（task-35 登记）",
    },
  ],
  [RULES.pageSizePagination]: [
    {
      file: "src/app/(app)/quotes/views/batch-quote-view.tsx",
      reason:
        "语义误报：page_size:100 是批量报价的客户选择器取数上限，不是分页列表",
    },
  ],
};

/** 取某文件在某规则下的白名单理由（无则 undefined）。 */
function allowEntry(rel, rule) {
  return (ALLOWLIST[rule] ?? []).find((entry) => entry.file === rel);
}

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
 * R1 用：收集文件内**本地声明**的 confirm/alert/prompt 绑定。
 *
 * 只按"同名即本地"做文件级判断（不做作用域精度）：局部函数 `const confirm = …`
 * 或 `import { confirm } from "./x"` 后调用 `confirm()` **不是**原生弹窗，
 * 之前会误报（quote-issue-button / doc-void-button 的 handleConfirm 早期就叫 confirm）。
 */
function collectLocalBindings(source) {
  const bound = new Set();
  const addName = (node) => {
    if (node && ts.isIdentifier(node)) bound.add(node.text);
  };
  const addPattern = (pattern) => {
    if (!pattern) return;
    if (ts.isIdentifier(pattern)) {
      bound.add(pattern.text);
      return;
    }
    if (ts.isObjectBindingPattern(pattern) || ts.isArrayBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        if (ts.isBindingElement(element)) addPattern(element.name);
      }
    }
  };
  const visit = (node) => {
    if (ts.isVariableDeclaration(node)) {
      addPattern(node.name);
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name
    ) {
      addName(node.name);
    } else if (ts.isParameter(node)) {
      addPattern(node.name);
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      addPattern(node.variableDeclaration.name);
    } else if (ts.isImportClause(node)) {
      // 默认导入：`import confirm from "./x"`
      addName(node.name);
    } else if (
      ts.isImportSpecifier(node) ||
      ts.isNamespaceImport(node) ||
      ts.isImportEqualsDeclaration(node)
    ) {
      addName(node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bound;
}

/**
 * 分析一段源码，返回违规、跳过项与白名单豁免（纯函数，供 fixture 测试直接用）。
 * @param {string} rel 相对 frontend 根的 posix 路径
 * @param {string} text 源码
 */
function analyzeSource(rel, text) {
  const violations = [];
  const skipped = [];
  const allowed = [];
  if (!ts) {
    return {
      violations,
      skipped: [{ rule: RULES.mutationOnError, file: rel, reason: "缺少 typescript 依赖，R4 无法执行" }],
      allowed,
    };
  }
  const scriptKind = rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKind);
  const localBindings = collectLocalBindings(source);
  /** R5 候选：AST 里的 `page_size: <数字字面量>`（注释/字符串里的不算）。 */
  const pageSizeLiterals = [];

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
        ["confirm", "alert", "prompt"].includes(callee.text) &&
        // 同名局部函数/导入不是原生弹窗（例：早期 handleConfirm 叫 confirm）
        !localBindings.has(callee.text)
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
        const allow = allowEntry(rel, RULES.bareTable);
        if (allow) {
          allowed.push({
            rule: RULES.bareTable,
            file: rel,
            line: lineOf(source, node.getStart(source)).line,
            reason: allow.reason,
          });
        } else {
          add(
            node.getStart(source),
            RULES.bareTable,
            "禁止裸 <table>（th scope/空态/分页会各写各的）；请用共享 DataTable",
          );
        }
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

    // ── R5 候选：硬编码 page_size 字面量（AST，注释/字符串不误报）───
    if (ts.isPropertyAssignment(node)) {
      const nameNode = node.name;
      const propName =
        ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode)
          ? nameNode.text
          : null;
      if (propName === "page_size" && ts.isNumericLiteral(node.initializer)) {
        pageSizeLiterals.push({
          offset: node.getStart(source),
          value: node.initializer.text,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  // ── R5 硬编码 page_size 但没接 PaginationBar ─────────────────────
  const hasPaginationBar = /\bPaginationBar\b/.test(text);
  if (!hasPaginationBar && pageSizeLiterals.length > 0) {
    const allow = allowEntry(rel, RULES.pageSizePagination);
    for (const literal of pageSizeLiterals) {
      if (allow) {
        allowed.push({
          rule: RULES.pageSizePagination,
          file: rel,
          line: lineOf(source, literal.offset).line,
          reason: allow.reason,
        });
        continue;
      }
      add(
        literal.offset,
        RULES.pageSizePagination,
        `硬编码 page_size: ${literal.value} 但文件未使用 PaginationBar：列表只能看前 ${literal.value} 条`,
      );
    }
  }

  return { violations, skipped, allowed };
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
  const allowed = [];
  for (const file of files) {
    const rel = toPosix(path.relative(root, file));
    const text = fs.readFileSync(file, "utf8");
    const result = analyzeSource(rel, text);
    violations.push(...result.violations);
    skipped.push(...result.skipped);
    allowed.push(...result.allowed);
  }
  return { root, scannedFiles: files.length, violations, skipped, allowed };
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

  if (result.allowed && result.allowed.length > 0) {
    line(`ℹ 白名单豁免（${result.allowed.length} 处，理由可核对）：`);
    for (const entry of result.allowed.slice(0, 50)) {
      line(`  - [${entry.rule}] ${entry.file}:${entry.line ?? "?"} ${entry.reason}`);
    }
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
  ALLOWLIST,
  analyzeSource,
  checkTree,
};

if (require.main === module) main(process.argv.slice(2));
