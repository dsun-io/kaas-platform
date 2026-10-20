/**
 * MSW 覆盖率门禁（防漂移，P1 机制）
 *
 * 为什么需要：`frontend/src/mocks/handlers.ts` 是**增量补丁**式维护的
 * （每个 handler 上方写着消费方 file:line），UI 重构后没有任何机制提醒补 mock。
 * 2026-10-20 审计实测：58 个 handler vs 172 条归一化前端调用 ⇒ 121 条未覆盖，
 * 而 `msw-provider.tsx` 的策略是 `onUnhandledRequest:"warn"`（放行到网络）⇒
 * mock 模式下这些请求挂起/失败，页面静默空白（`.tmp/align-report.md` §2-3、§3）。
 *
 * 做法（与审计脚本同口径，保证数字可对账）：
 *   1. 从 `frontend/src/**`（排除 `__tests__` / `*.test.*` / `*.spec.*`）抽
 *      `apiClient.<method>("…")` 与原生 `fetch("…")` 的字面量路径；
 *   2. 从 `handlers.ts` 抽 `http.<method>("…")` 的路径；
 *   3. 两边归一化（`${...}` / `{...}` / `:param` → `*`，剥 query，补 `/api/v1` 前缀）；
 *   4. 输出「FE 有、mock 无」与「mock 有、FE 无」两张清单。
 *
 * 退出码：
 *   · 默认（只警告）：发现未覆盖缺口 **不**失败 —— 存量缺口是已知的、需要排期；
 *   · `--strict`：任何未覆盖缺口都非零退出（给 CI 用）；
 *   · **P1 组（P1_REQUIRED）缺失一律非零退出，与 --strict 无关** ——
 *     这是本门禁的意义：已经补过、且在审计里被点名的端点不能再漂回去。
 *     其中 3 条（`GET /teams/:id/members|invites|subscriptions`）在静态抽取里
 *     **看不到**（`use-team-admin.ts:160` 用 path 变量），所以必须硬编码钉住。
 *
 * 已知静态盲区：首参是运行时变量的调用（`apiClient.get(path, …)`）抽不到。
 * 审计报告 §0 已逐个人工核对过，只有上述 3 条 team 列表 + 报价计算 2 处。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const API_CALL_RE =
  /apiClient\s*\.\s*(get|post|put|patch|delete)[\s\S]{0,300}?\(\s*([`'"])([^`'"]+?)\2/g;
const FETCH_RE = /(?<![\w.])fetch\s*\(\s*([`'"])([^`'"]+?)\1/g;
const MSW_RE = /http\s*\.\s*(get|post|put|patch|delete)\(\s*(["'])([^"']+?)\2/g;
const EXCLUDED_RE = /(__tests__\/|\.test\.|\.spec\.)/;

/** 已补过、且在审计里被点名的 P1 组端点（丢失即失败）。 */
const P1_REQUIRED: readonly string[] = [
  // 客户 · 联系人与询盘
  "GET /api/v1/customers/*/inquiries",
  "GET /api/v1/inquiries/*/stage-log",
  "PATCH /api/v1/inquiries/*",
  "PATCH /api/v1/customers/*/contacts/*",
  "DELETE /api/v1/customers/*/contacts/*",
  // 产品 / 产品图 / 文件对象
  "GET /api/v1/products",
  "GET /api/v1/products/*/profile",
  "PUT /api/v1/products/*/profile",
  "GET /api/v1/products/*/media",
  "POST /api/v1/products/*/media",
  "POST /api/v1/file-objects/presign",
  "POST /api/v1/file-objects/register",
  "GET /api/v1/file-objects/*/content",
  "GET /api/v1/file-objects/*/url",
  "PATCH /api/v1/file-objects/*",
  "DELETE /api/v1/file-objects/*",
  // 单证 · 文件 / 对账 / 上游刷新
  "GET /api/v1/trade-docs/*/files",
  "POST /api/v1/trade-docs/*/files/upload",
  "DELETE /api/v1/trade-docs/*/files/*",
  "POST /api/v1/trade-docs/*/refresh-sources",
  "GET /api/v1/trade-docs/*/render-fingerprint-check",
  // 租户产品定义
  "GET /api/v1/tenant-products",
  "POST /api/v1/tenant-products",
  "PUT /api/v1/tenant-products/*",
  "DELETE /api/v1/tenant-products/*",
  "GET /api/v1/tenant-product-status",
  "POST /api/v1/tenant-product-status",
  // 团队（前 3 条是静态抽取盲区，必须硬编码）
  "GET /api/v1/teams/*/members",
  "GET /api/v1/teams/*/invites",
  "GET /api/v1/teams/*/subscriptions",
  "POST /api/v1/teams",
  "POST /api/v1/teams/join",
  "POST /api/v1/teams/*/transfer",
  "DELETE /api/v1/teams/*/members/*",
  "PUT /api/v1/teams/*/members/*/console-access",
  "POST /api/v1/teams/*/invites",
  "DELETE /api/v1/teams/*/invites/*",
  "PUT /api/v1/teams/*/subscriptions/*",
  "DELETE /api/v1/teams/*/subscriptions/*",
  // 税档
  "GET /api/v1/tax-archives",
  "POST /api/v1/tax-archives",
  "PATCH /api/v1/tax-archives/*",
  "GET /api/v1/product-tax-rates",
  "POST /api/v1/product-tax-rates",
  "PATCH /api/v1/product-tax-rates/*",
  "DELETE /api/v1/product-tax-rates/*",
  // 企业信息 / 公章
  "GET /api/v1/tenant/company-profile",
  "PUT /api/v1/tenant/company-profile",
  "GET /api/v1/tenant/company-seals",
  "POST /api/v1/tenant/company-seals",
  "GET /api/v1/tenant/company-seals/*/image",
  "PUT /api/v1/tenant/company-seals/*/default",
  "DELETE /api/v1/tenant/company-seals/*",
  // 产品工位「复制系统产品」底稿
  "GET /api/v1/export-quote/products/*/spec",
];

/** 有 mock 但前端**抽取不到**调用（path 变量 / 测试钩子）——只提示，不算漂移。 */
const STATIC_BLIND_SPOTS: readonly string[] = [
  "GET /api/v1/teams/*/members",
  "GET /api/v1/teams/*/invites",
  "GET /api/v1/teams/*/subscriptions",
  "POST /api/v1/__test/override-quote-status",
];

function resolveFrontendRoot(): string {
  const candidates = [process.cwd(), resolve(process.cwd(), "frontend")];
  for (const candidate of candidates) {
    try {
      if (statSync(join(candidate, "src", "mocks", "handlers.ts")).isFile()) {
        return candidate;
      }
    } catch {
      // 下一个候选
    }
  }
  throw new Error(
    "找不到 frontend/src/mocks/handlers.ts —— 请在 frontend/（pnpm mocks:check）或仓库根运行",
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".next")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** 归一化：与审计脚本 `.tmp/mswdiff.ps1` 的 `Norm-Path` 同口径。 */
function normalizePath(input: string): string | null {
  let path = input.trim();
  if (!path) return null;
  if (/^https?:\/\//.test(path)) return null;
  const base = "${EXPORT_QUOTE_BASE}";
  if (path.startsWith(base)) {
    path = "/export-quote" + path.slice(base.length);
  } else if (path.startsWith("${")) {
    // 首参以运行时拼接开头：静态抽取判断不了（见文件头「已知静态盲区」）
    return null;
  }
  path = path.replace(/\$\{[^}]*\}/g, "*");
  // 嵌套模板（`` `/x${q ? `?${q}` : ""}` ``）会让字面量在第一个内层反引号处被截断，
  // 留下半截 `${`：从那里截掉 —— 其余部分本来就是 query 构造。
  const leftoverVariable = path.indexOf("${");
  if (leftoverVariable >= 0) {
    path = path.slice(0, leftoverVariable);
    if (path.endsWith("/")) path += "*";
  }
  const query = path.indexOf("?");
  if (query >= 0) path = path.slice(0, query);
  path = path.replace(/\{[^}]*\}/g, "*");
  path = path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "*");
  if (!path.startsWith("/api/v1")) path = "/api/v1" + path;
  path = path.replace(/\/+$/, "");
  return path || "/api/v1";
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

interface CallSite {
  key: string;
  file: string;
  line: number;
}

const frontendRoot = resolveFrontendRoot();
const srcRoot = join(frontendRoot, "src");

// ── 门槛：C18 起把未覆盖数**收紧到 ≤20**（默认失败，不再只是警告）────────────
// 背景：对齐 B 批把 121 → 72；C18 补齐长尾域后应接近 0。留 20 的余量是给
// "新页面先上、mock 后补"的正常节奏，但任何**存量回涨**都会让 `pnpm mocks:check` 变红。
const MAX_MISSING = 20;
const maxMissingArg = process.argv.find((arg) => arg.startsWith("--max-missing="));
const maxMissing = maxMissingArg
  ? Number(maxMissingArg.split("=")[1])
  : MAX_MISSING;
const strict = process.argv.includes("--strict");

const feCalls = new Map<string, CallSite[]>();
for (const file of walk(srcRoot)) {
  const rel = relative(frontendRoot, file).split(sep).join("/");
  if (EXCLUDED_RE.test(rel)) continue;
  const text = readFileSync(file, "utf8");
  const record = (method: string, raw: string, index: number) => {
    const normalized = normalizePath(raw);
    if (!normalized) return;
    const key = `${method.toUpperCase()} ${normalized}`;
    const sites = feCalls.get(key) ?? [];
    sites.push({ key, file: rel, line: lineOf(text, index) });
    feCalls.set(key, sites);
  };
  for (const match of text.matchAll(API_CALL_RE)) {
    record(match[1] ?? "get", match[3] ?? "", match.index ?? 0);
  }
  for (const match of text.matchAll(FETCH_RE)) {
    record("get", match[2] ?? "", match.index ?? 0);
  }
}

// MSW handler 现在分布在 `src/mocks/**`（handlers.ts + P1 组 + C18 长尾模块），
// 因此扫描整个 mocks 目录（排除测试文件）——只扫 handlers.ts 会把长尾覆盖漏掉。
const mocksRoot = join(srcRoot, "mocks");
const mswKeys = new Map<string, { file: string; line: number }>();
for (const file of walk(mocksRoot)) {
  const rel = relative(frontendRoot, file).split(sep).join("/");
  if (EXCLUDED_RE.test(rel)) continue;
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(MSW_RE)) {
    const normalized = normalizePath(match[3] ?? "");
    if (!normalized) continue;
    mswKeys.set(`${(match[1] ?? "get").toUpperCase()} ${normalized}`, {
      file: rel,
      line: lineOf(text, match.index ?? 0),
    });
  }
}

const feKeys = [...feCalls.keys()].sort();
const mswKeyList = [...mswKeys.keys()].sort();
const notMocked = feKeys.filter((key) => !mswKeys.has(key));
const unusedMsw = mswKeyList.filter(
  (key) => !feCalls.has(key) && !STATIC_BLIND_SPOTS.includes(key),
);
const p1Missing = P1_REQUIRED.filter((key) => !mswKeys.has(key));

const line = (text = "") => process.stdout.write(`${text}\n`);

line("── MSW 覆盖率（frontend/src/** ↔ src/mocks/**）──");
line(`前端调用（归一化唯一路径）：${feKeys.length}`);
line(`MSW handler：${mswKeyList.length}`);
line(
  `未覆盖：${notMocked.length}（门槛 ≤${maxMissing}）    mock 有但前端未调用：${unusedMsw.length}`,
);
line(`P1 组：${P1_REQUIRED.length - p1Missing.length}/${P1_REQUIRED.length} 覆盖`);
line();

if (notMocked.length > 0) {
  line(`⚠ 未覆盖（${notMocked.length}）—— mock 模式下会放行到网络：`);
  for (const key of notMocked) {
    const sites = feCalls.get(key) ?? [];
    const first = sites[0];
    line(`  - ${key}${first ? `   (${first.file}:${first.line})` : ""}`);
  }
  line();
}

if (unusedMsw.length > 0) {
  line(`ℹ mock 有但前端未调用（${unusedMsw.length}，信息项）：`);
  for (const key of unusedMsw) {
    const where = mswKeys.get(key);
    line(`  - ${key}   (${where ? `${where.file}:${where.line}` : "?"})`);
  }
  line();
}

let failed = false;

if (p1Missing.length > 0) {
  line(`✗ P1 组缺失（${p1Missing.length}）—— 这些端点在审计里已点名补过，不能再丢：`);
  for (const key of p1Missing) line(`  - ${key}`);
  failed = true;
}

const overBudget = Number.isFinite(maxMissing)
  ? notMocked.length > maxMissing
  : false;
if (overBudget) {
  line(
    `✗ 未覆盖 ${notMocked.length} 条 > 门槛 ${maxMissing}（C18 收紧的门禁）：` +
      "新页面请同时补 mock；确属后端缺接口的，先在报告里登记，不要加 handler 假装有。",
  );
  failed = true;
}

if (strict && notMocked.length > 0) {
  line("✗ --strict：存在未覆盖的前端调用");
  failed = true;
}

if (failed) process.exit(1);

line(
  `✓ MSW 覆盖门禁通过（P1 组无缺失；未覆盖 ${notMocked.length} ≤ ${maxMissing}）`,
);

