/**
 * scripts/check-secrets.mjs 的自测（node --test）
 *
 * 覆盖四类断言：
 *   ① 每条规则对「真形状假值」必须命中（真形状 = 结构与真实凭据一致，值本身是测试构造）；
 *   ② 占位符 / 文档示例 / 本地开发 DSN 必须放行（否则门禁会被噪音拖垮）；
 *   ③ allowlist 语义：glob 匹配、按规则收窄、无理由/未知规则 fail closed；
 *   ④ CLI 端到端：--files 命中 exit 1 且**不回显值**、干净 exit 0、--staged 读 index blob
 *      （暂存了密钥但工作树改干净也必须拦住）、--allowlist 生效、用法错误 exit 2。
 *
 * 本文件自己包含真形状假值（正例），因此在 scripts/secret-scan-allowlist.txt 里
 * 以「*」整文件登记并写明理由；这也是 allowlist 纪律允许 * 的唯一场景。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  scanText,
  parseAllowlist,
  matchGlob,
  findAllowlistEntry,
  isPlaceholderPassword,
  isHighEntropyValue,
} from "../check-secrets.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "check-secrets.mjs");
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), "..");
const ALLOWLIST = path.join(REPO_ROOT, "scripts", "secret-scan-allowlist.txt");

const typesOf = (text) => scanText(text, "fixture.txt").map((h) => h.type);

/**
 * 真形状假值：只有结构与真实凭据一致，值全部是测试构造（拼接字面量，避免源码本身
 * 出现连续的可疑串；运行期拼成完整值后喂给 scanText）。仓库内没有对应真实凭据。
 */
const FAKE = {
  pem: "-----BEGIN RSA PRIVATE KEY-----",
  aws: "AKIA" + "Z7X2QW4R9TY6U8IO",
  ghp: "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
  ghpFine: "github_pat_" + "11ABCDEFG0HIJKLMNOPQRSTUVWX_".repeat(2).slice(0, 40),
  notion: "ntn_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0",
  neon: "npg_" + "Q7w8E9r0T1y2U3i4O5p6",
  dsn: "postgresql://neondb_owner:r4nd0mP4ss@ep-cool-branch-123456.us-east-2.aws.neon.tech/neondb",
  resend: "re_" + "a1B2c3D4e5F6g7H8i9J0k1L2",
  openai: "sk-proj-" + "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5z",
  slack: "xoxb-" + "123456789012-123456789012-abcdefghijklmnopqrstuvwx",
  generic: "9f3c2a7e4b1d8f6a5c0e9d3b7a2f4c8e",
};

test("每条规则都能命中真形状假值", () => {
  const cases = [
    ["private-key", FAKE.pem],
    ["aws-access-key", "AWS_ACCESS_KEY=" + FAKE.aws],
    ["github-pat", FAKE.ghp],
    ["github-pat", FAKE.ghpFine],
    ["notion-token", FAKE.notion],
    ["neon-token", FAKE.neon],
    ["postgres-dsn", FAKE.dsn],
    ["resend-key", 'RESEND_API_KEY="' + FAKE.resend + '"'],
    ["openai-key", FAKE.openai],
    ["slack-token", FAKE.slack],
    ["generic-secret", 'api_key: "' + FAKE.generic + '"'],
  ];
  for (const [type, text] of cases) {
    assert.ok(typesOf(text).includes(type), "应命中 " + type + "，实际：" + JSON.stringify(typesOf(text)));
  }
});

test("同一行多类凭据可同时报出（不互相吞掉）", () => {
  const types = typesOf('api_key: "' + FAKE.generic + '", fallback: "' + FAKE.ghp + '"');
  assert.ok(types.includes("generic-secret"));
  assert.ok(types.includes("github-pat"));
});

test("占位符 / 文档示例 / 本地开发 DSN 必须放行", () => {
  const clean = [
    "postgresql://<user>:<pass>@<host>/<db>",
    "postgresql://user:pass@localhost:5432/db",
    "postgresql://kaas:kaas_dev@127.0.0.1:5432/kaas_dev",
    "postgres+asyncpg://kaas:kaas_test_pw@postgres:5432/kaas_v2_test",
    "postgresql://neondb_owner:<REDACTED>@host/db",
    "postgresql://neondb_owner:...@ep-x.neon.tech/neondb",
    'api_key = "your-api-key-here"',
    'api_key = "your_api_key_1234567890"',
    'secret = "changeme"',
    'token: "$env:JWT_SECRET"',
    'secret = "%DB_PASSWORD%"',
    "-----BEGIN PUBLIC KEY-----",
    "AKIA 是 AWS Access Key 的前缀（文档说明，不是 key）",
    "sk-learn 是 Python 库名（不是 OpenAI key）",
  ];
  for (const line of clean) assert.deepEqual(typesOf(line), [], "不应命中：" + line);
});

test("占位口令与高熵启发式的边界", () => {
  for (const pw of ["pass", "password", "<REDACTED>", "$env:JWT_SECRET", "%DB_PASSWORD%", "xxx", "changeme", "…"]) {
    assert.equal(isPlaceholderPassword(pw), true, pw);
  }
  assert.equal(isPlaceholderPassword("r4nd0mP4ss"), false);
  assert.equal(isHighEntropyValue(FAKE.generic), true);
  assert.equal(isHighEntropyValue("your-api-key-here"), false);
  assert.equal(isHighEntropyValue("aaaaaaaaaaaaaaaaaaaa"), false);
  assert.equal(isHighEntropyValue("abcdefghijklmnop"), false);
});

test("allowlist glob：** 跨目录、* 不跨目录、? 单字符", () => {
  assert.equal(matchGlob("scripts/__tests__/*.test.mjs", "scripts/__tests__/check-secrets.test.mjs"), true);
  assert.equal(matchGlob("**/tests/*.py", "backend/worker/tests/x.py"), true);
  assert.equal(matchGlob("scripts/*.mjs", "scripts/sub/x.mjs"), false);
  assert.equal(matchGlob("scripts/check-secrets.mjs", "scripts/check-secrets.mjs"), true);
  assert.equal(matchGlob("docs/a?.md", "docs/ab.md"), true);
  assert.equal(matchGlob("docs/a?.md", "docs/abc.md"), false);
});

test("allowlist 解析：按规则收窄、无理由/未知规则/格式错误都 fail closed", () => {
  const entries = parseAllowlist("scripts/fixture.txt generic-secret # 测试假值\n\n# 整行注释\n", "fixture");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].rule, "generic-secret");
  assert.equal(entries[0].reason, "测试假值");
  assert.equal(findAllowlistEntry(entries, "scripts/fixture.txt", "generic-secret")?.reason, "测试假值");
  assert.equal(findAllowlistEntry(entries, "scripts/fixture.txt", "github-pat"), null);
  assert.equal(findAllowlistEntry(entries, "other.txt", "generic-secret"), null);
  assert.throws(() => parseAllowlist("scripts/fixture.txt generic-secret\n", "fixture"), /缺少原因/);
  assert.throws(() => parseAllowlist("scripts/fixture.txt no-such-rule # 原因\n", "fixture"), /未知规则名/);
  assert.throws(() => parseAllowlist("scripts/fixture.txt # 原因\n", "fixture"), /格式错误/);
});

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaas-secret-scan-test-"));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function removeTempRepo(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows 上偶发占用（杀软/索引服务），残留临时目录不影响断言，交给系统清理。
  }
}

/** 起 CLI；默认清掉 GIT_INDEX_FILE，避免外层私有索引干扰（本测试自己造临时仓库）。 */
function runCli(args, cwd, extraEnv = {}) {
  const env = { ...process.env };
  delete env.GIT_INDEX_FILE;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: "utf8" });
}

test("CLI --files：命中 exit 1，只报 文件:行 + 类型，不回显值", () => {
  const dir = makeTempRepo();
  try {
    const file = path.join(dir, "leaky.txt");
    fs.writeFileSync(file, "ok\n" + 'token = "' + FAKE.ghp + '"\n');
    const res = runCli(["--files", "leaky.txt"], dir);
    assert.equal(res.status, 1);
    const out = res.stdout + res.stderr;
    assert.match(out, /leaky\.txt:2/);
    assert.match(out, /\[github-pat\]/);
    assert.doesNotMatch(out, /ghp_/, "输出不得回显命中值");
    console.log("--files 命中输出（脱敏验证）：\n" + out.trim());
  } finally {
    removeTempRepo(dir);
  }
});

test("CLI --files：干净文件 exit 0", () => {
  const dir = makeTempRepo();
  try {
    fs.writeFileSync(path.join(dir, "clean.txt"), "hello\npostgresql://user:pass@localhost:5432/db\n");
    const res = runCli(["--files", "clean.txt"], dir);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /PASS/);
  } finally {
    removeTempRepo(dir);
  }
});

test("CLI --staged：扫 index blob（暂存密钥后把工作树改干净也必须拦住）", () => {
  const dir = makeTempRepo();
  try {
    fs.writeFileSync(path.join(dir, "clean.txt"), "hello\n");
    execFileSync("git", ["add", "clean.txt"], { cwd: dir, stdio: "ignore" });

    let res = runCli(["--staged"], dir);
    assert.equal(res.status, 0, "干净暂存区应 exit 0：" + res.stdout + res.stderr);

    fs.writeFileSync(path.join(dir, "leaky.txt"), 'token = "' + FAKE.ghp + '"\n');
    execFileSync("git", ["add", "leaky.txt"], { cwd: dir, stdio: "ignore" });
    // 关键取证：暂存后再把工作树改成干净，--staged 仍须按 index 拦下。
    fs.writeFileSync(path.join(dir, "leaky.txt"), "已删掉的明文\n");

    res = runCli(["--staged"], dir);
    assert.equal(res.status, 1, "--staged 必须扫 index blob：" + res.stdout + res.stderr);
    assert.match(res.stderr, /leaky\.txt:1/);
    assert.match(res.stderr, /\[github-pat\]/);
    assert.doesNotMatch(res.stdout + res.stderr, /ghp_/);

    // 工作树是干净的（密钥只在 index）⇒ 默认 tree 模式此时不应报它。
    res = runCli([], dir);
    assert.equal(res.status, 0, "tree 模式读工作树，应干净：" + res.stdout + res.stderr);
  } finally {
    removeTempRepo(dir);
  }
});

test("CLI --allowlist：登记后 exit 0，并打印命中理由（不静默）", () => {
  const dir = makeTempRepo();
  try {
    fs.writeFileSync(path.join(dir, "fixture.txt"), 'api_key: "' + FAKE.generic + '"\n');
    fs.writeFileSync(
      path.join(dir, "allow.txt"),
      "fixture.txt generic-secret # 自测假值，仅本测试使用\n"
    );
    const res = runCli(["--files", "fixture.txt", "--allowlist", "allow.txt"], dir);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /allowlist 命中 1 条/);
    assert.match(res.stdout, /自测假值/);
  } finally {
    removeTempRepo(dir);
  }
});

test("CLI 用法错误 exit 2（未知参数 / --staged 与 --files 互斥 / allowlist 文件不存在）", () => {
  const dir = makeTempRepo();
  try {
    fs.writeFileSync(path.join(dir, "x.txt"), "hi\n");
    assert.equal(runCli(["--nope"], dir).status, 2);
    assert.equal(runCli(["--staged", "--files", "x.txt"], dir).status, 2);
    assert.equal(runCli(["--files", "x.txt", "--allowlist", "no-such-allowlist.txt"], dir).status, 2);
    assert.equal(runCli(["--help"], dir).status, 0);
  } finally {
    removeTempRepo(dir);
  }
});

test("仓库自身：扫描器 / allowlist / 自测文件都不自伤（test 文件靠 * 登记放行）", () => {
  const res = runCli(
    [
      "--files",
      "scripts/check-secrets.mjs,scripts/secret-scan-allowlist.txt,scripts/__tests__/check-secrets.test.mjs",
      "--allowlist",
      ALLOWLIST,
    ],
    REPO_ROOT
  );
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /allowlist 命中/);
  assert.match(res.stdout, /check-secrets\.test\.mjs/);
});
