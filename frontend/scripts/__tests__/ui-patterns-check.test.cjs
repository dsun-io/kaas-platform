"use strict";
/**
 * ui:patterns 门禁自测（node:test）——用 fixture 覆盖每条规则的正例/反例，
 * 以及 shadow / --strict 的退出码契约（默认不能拦存量，转强制后才拦）。
 *
 * 运行：pnpm ui:patterns:test（或 node --test scripts/__tests__/ui-patterns-check.test.cjs）
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { RULES, analyzeSource } = require("../ui-patterns-check.cjs");

const SCRIPT = path.join(__dirname, "..", "ui-patterns-check.cjs");

function rulesOf(rel, text) {
  return analyzeSource(rel, text).violations.map((v) => v.rule);
}

/** 建一个临时 frontend 根（src/app 结构），用于端到端跑 CLI。 */
function makeRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ui-patterns-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return root;
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
  });
}

test("R1 no-native-dialog：window.confirm/alert/prompt 与裸全局调用都算违规", () => {
  assert.deepEqual(
    rulesOf("src/app/x/page.tsx", 'export function P(){ window.confirm("删？"); }'),
    [RULES.nativeDialog],
  );
  assert.deepEqual(
    rulesOf("src/app/x/page.tsx", 'export function P(){ window.alert("失败"); }'),
    [RULES.nativeDialog],
  );
  assert.deepEqual(
    rulesOf("src/app/x/page.tsx", 'export function P(){ window.prompt("收件人"); }'),
    [RULES.nativeDialog],
  );
  assert.deepEqual(
    rulesOf("src/app/x/page.tsx", 'export function P(){ confirm("删？"); }'),
    [RULES.nativeDialog],
  );
});

test("R1 反例：字符串里的 window.confirm、类名 onConfirm 不应误报", () => {
  assert.deepEqual(
    rulesOf("src/app/x/page.tsx", 'const tip = "window.confirm(1) 已废弃"; export default tip;'),
    [],
  );
  assert.deepEqual(
    rulesOf("src/app/x/page.tsx", "export function P(){ onConfirm(); return null; }"),
    [],
  );
  // 同名局部函数/导入不是原生弹窗（task-27：handleConfirm 早期就叫 confirm 导致误报）
  assert.deepEqual(
    rulesOf(
      "src/app/x/page.tsx",
      "const confirm = async () => {}; export function P(){ void confirm(); }",
    ),
    [],
  );
  assert.deepEqual(
    rulesOf(
      "src/app/x/page.tsx",
      "import { confirm } from './confirm-helper'; export function P(){ confirm(); }",
    ),
    [],
  );
});

test("R2 no-bare-table：原生 <table> 违规，共享 <Table> 与 ui/table.tsx 白名单不报", () => {
  assert.deepEqual(
    rulesOf(
      "src/app/x/page.tsx",
      "export function P(){ return <table><tbody><tr><td /></tr></tbody></table>; }",
    ),
    [RULES.bareTable],
  );
  assert.deepEqual(
    rulesOf(
      "src/app/x/page.tsx",
      "import { Table } from '@/components/ui/table'; export function P(){ return <Table><tbody /></Table>; }",
    ),
    [],
  );
  assert.deepEqual(
    rulesOf(
      "src/components/ui/table.tsx",
      "export function Table(){ return <table><tbody /></table>; }",
    ),
    [],
  );
});

test("R3 no-plain-text-state：裸文案命中，EmptyState 用法与说明性长句不报", () => {
  assert.deepEqual(
    rulesOf("src/app/x/page.tsx", "export function P(){ return <div>加载中…</div>; }"),
    [RULES.plainTextState],
  );
  assert.deepEqual(
    rulesOf(
      "src/app/x/page.tsx",
      "export function P(){ return <div>加载失败，请稍后重试</div>; }",
    ),
    [RULES.plainTextState],
  );
  assert.deepEqual(
    rulesOf(
      "src/app/x/page.tsx",
      "import { EmptyState } from '@/components/shared'; export function P(){ return <EmptyState title=\"暂无数据\" />; }",
    ),
    [],
  );
  assert.deepEqual(
    rulesOf(
      "src/app/x/page.tsx",
      "export function P(){ return <p>这一段是说明文字，顺带提到暂无数据，避免用户误会，不是状态占位。</p>; }",
    ),
    [],
  );
});

test("R4 use-mutation-on-error：缺 onError 报；有 onError / spread / 非字面量参数不误报", () => {
  assert.deepEqual(
    rulesOf(
      "src/app/x/page.tsx",
      "export function P(){ return useMutation({ mutationFn: save }); }",
    ),
    [RULES.mutationOnError],
  );
  assert.deepEqual(
    rulesOf(
      "src/app/x/page.tsx",
      "export function P(){ return useMutation({ mutationFn: save, onError: handle }); }",
    ),
    [],
  );
  const spread = analyzeSource(
    "src/app/x/page.tsx",
    "export function P(){ return useMutation({ ...base, mutationFn: save }); }",
  );
  assert.deepEqual(spread.violations.map((v) => v.rule), []);
  assert.equal(spread.skipped.length, 1);

  const notLiteral = analyzeSource(
    "src/app/x/page.tsx",
    "export function P(){ return useMutation(options); }",
  );
  assert.deepEqual(notLiteral.violations.map((v) => v.rule), []);
  assert.equal(notLiteral.skipped.length, 1);
});

test("R5 page-size-without-pagination：硬编码 page_size 且无 PaginationBar 才报", () => {
  assert.deepEqual(
    rulesOf(
      "src/app/x/page.tsx",
      "export const q = { page: 1, page_size: 50 };",
    ),
    [RULES.pageSizePagination],
  );
  assert.deepEqual(
    rulesOf(
      "src/app/x/page.tsx",
      "import { PaginationBar } from '@/components/shared'; export const q = { page_size: 50 };",
    ),
    [],
  );
  assert.deepEqual(
    rulesOf(
      "src/app/x/page.tsx",
      "export const q = { page_size: pageSize };",
    ),
    [],
  );
  // 注释/字符串里的 page_size 不是配置（task-27：orders hook 的注释曾误报）
  assert.deepEqual(
    rulesOf(
      "src/app/x/page.tsx",
      "// 历史写法固定 page_size: 100，现在走标准分页\nexport const x = 1;",
    ),
    [],
  );
  assert.deepEqual(
    rulesOf(
      "src/app/x/page.tsx",
      'export const q = { page_size: "50" };',
    ),
    [],
  );
  // 显式白名单：语义误报（选择器取数上限）不再计入违规，但进入 allowed 可核对
  const allowlisted = analyzeSource(
    "src/app/(app)/quotes/views/batch-quote-view.tsx",
    "export const q = { page_size: 100 };",
  );
  assert.deepEqual(allowlisted.violations.map((v) => v.rule), []);
  assert.equal(allowlisted.allowed.length, 1);
  assert.equal(allowlisted.allowed[0].rule, RULES.pageSizePagination);
  assert.match(allowlisted.allowed[0].reason, /选择器/);
});

test("CLI shadow 模式：有违规也退出 0，并打印转强制时间点", (t) => {
  const root = makeRoot({
    "src/app/bad/page.tsx": 'export function P(){ window.confirm("删？"); }',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = runCli(["--root", root], root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /shadow 模式/);
  assert.match(result.stdout, /2026-10-30/);
  assert.match(result.stdout, /no-native-dialog/);
});

test("CLI --strict：有违规退出 1，干净目录退出 0", (t) => {
  const dirty = makeRoot({
    "src/app/bad/page.tsx": 'export function P(){ window.alert("x"); }',
  });
  t.after(() => fs.rmSync(dirty, { recursive: true, force: true }));
  const failed = runCli(["--root", dirty, "--strict"], dirty);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /--strict/);

  const clean = makeRoot({
    "src/app/ok/page.tsx": "export function P(){ return <div data-ok />; }",
  });
  t.after(() => fs.rmSync(clean, { recursive: true, force: true }));
  const passed = runCli(["--root", clean, "--strict"], clean);
  assert.equal(passed.status, 0);
});

test("CLI --json：输出可解析的违规清单（含 rule/file/line）", (t) => {
  const root = makeRoot({
    "src/app/bad/page.tsx": 'export function P(){ window.confirm("x"); }',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = runCli(["--root", root, "--json"], root);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.violations.length, 1);
  assert.equal(parsed.violations[0].rule, RULES.nativeDialog);
  assert.equal(parsed.violations[0].file, "src/app/bad/page.tsx");
  assert.equal(parsed.violations[0].line, 1);
  assert.equal(parsed.scannedFiles, 1);
});
