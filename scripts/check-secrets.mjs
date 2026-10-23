#!/usr/bin/env node
/**
 * 明文凭据扫描门禁（2026-10-23，STRUCTURAL_DEBT.md §6.4「防再犯」第 1/2 项）
 *
 * 为什么不用 gitleaks：
 *   · 本机未安装（winget 安装需联网，本轮环境不允许把门禁依赖在"装没装"上）；
 *   · CI 引第三方 Action / 二进制会给 public 仓库增加供应链面，且需要额外权限；
 *   · 本项目要防的泄漏类型很窄（固定前缀 + 一条高熵启发式），零依赖 Node 20+ 就能做到
 *     确定性、可自测（node --test）、毫秒级，失败信息还能直接给中文修复指引。
 * 口径：只扫当前树 / 暂存区，不扫 git 历史（全历史扫描是 §6.2 的独立事项，待用户授权）。
 *
 * 三种模式：
 *   node scripts/check-secrets.mjs                 # 默认：全部 git 跟踪文本文件（git ls-files -z）
 *   node scripts/check-secrets.mjs --staged        # 只扫暂存区（内容取 index blob，不是工作树）
 *   node scripts/check-secrets.mjs --files a,b,c   # 显式文件（自测 / CI 分片）
 *
 * --staged 为什么读 index blob：pre-commit 那一刻，"要提交的内容"是 index 里的版本；
 * 工作树可能还有未暂存的干净版本（或相反）。读工作树会漏掉"暂存了密钥、随后又把工作树改干净"
 * 的场景，所以一律用 git show :<path>。
 *
 * 检测规则（类型 id 与 allowlist 里写的规则名一致）：
 *   private-key      PEM 私钥块（RSA/EC/DSA/OPENSSH/PGP/ENCRYPTED/PKCS#8）
 *   aws-access-key   AWS Access Key ID（AKIA + 12~16 位大写字母数字）
 *   github-pat       GitHub PAT：ghp_* / github_pat_*
 *   notion-token     Notion 集成 token：ntn_*
 *   neon-token       Neon API key：npg_*
 *   postgres-dsn     带口令的 PostgreSQL DSN（<user>:<pass>@<host> 模板、pass/changeme 占位自动放行；
 *                     host 为 localhost/127.0.0.1/docker 服务名(postgres/db) 时视为本地开发固定凭据，不报）
 *   resend-key       Resend API key：re_*
 *   openai-key       OpenAI API key：sk-*（含 sk-proj- / sk-svcacct- / sk-admin-）
 *   slack-token      Slack token：xox[baprs]-*
 *   generic-secret   键名含 api_key / secret / token，赋值 16+ 位且高熵（启发式）
 *
 * 输出纪律：只打印 文件:行 + 类型，绝不回显命中值（值一律不回显、不打码片段）；
 *   命中（allowlist 之外）⇒ exit 1；干净 ⇒ exit 0；用法/配置错误 ⇒ exit 2。
 *
 * allowlist：scripts/secret-scan-allowlist.txt，格式 <glob> <规则|*> # 原因
 *   · 纪律同 ui:patterns 的 ALLOWLIST：按「规则 + 文件」豁免、每条必须写理由、
 *     报告里单独打印命中条数与理由（不静默）；通配规则 * 只应给自测文件用；
 *   · 无理由 / 未知规则名 ⇒ exit 2（fail closed，不放行"先豁免后补理由"）。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ALLOWLIST_REL = path.join("scripts", "secret-scan-allowlist.txt");
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB：跟踪文件最大 ~600KB，留足余量同时防病理输入
const SCRIPT_PATH = fileURLToPath(import.meta.url);

/** 构建/依赖产物目录：git 跟踪的文件本不该在里面，但 --files 可能误传，兜底跳过。 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".next-build",
  ".next-verify",
  ".turbo",
  "out",
  "dist",
  "build",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".cache",
  "minio_data",
]);

/** 明确二进制扩展名（NUL 检测之外的第二道保险；文本型 lock/json 仍会被扫描）。 */
const SKIP_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp", ".tif", ".tiff", ".avif",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pdf", ".zip", ".gz", ".tgz", ".7z", ".rar", ".jar",
  ".xlsx", ".xls", ".docx", ".doc", ".pptx", ".ppt",
  ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg",
  ".pyc", ".pyo", ".so", ".dll", ".exe", ".wasm", ".class", ".bin", ".dat", ".db", ".sqlite3",
]);

/** 占位口令词（DSN / 高熵值共用）：出现这些词说明是模板或示例，不是真实口令。 */
const PLACEHOLDER_WORDS =
  /^(?:change[_-]?me|example|placeholder|dummy|sample|fake|test|tests|redacted|pass|passwd|password|pwd|secret|dev|local|todo)$/i;

/** 占位值前缀（your-api-key、replace-me、insert-token 之类）。 */
const PLACEHOLDER_PREFIX = /^(?:your|my|change|replace|insert|example|sample|dummy|fake|test|dev|local|redacted)[-_ ]?/i;

function shannonEntropy(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** DSN 口令是否为占位/模板（模板变量、省略号、占位词、星号）。 */
export function isPlaceholderPassword(pw) {
  if (!pw) return true;
  if (/[<>]/.test(pw)) return true; // <pass> / <REDACTED>
  if (/\$\{|\$env|%[A-Za-z_]+%/.test(pw)) return true; // 模板变量 / $env:VAR / %VAR%
  if (/[^\x21-\x7e]/.test(pw)) return true; // 省略号 …、中文等（文档里被截断的值）
  if (PLACEHOLDER_WORDS.test(pw)) return true;
  if (PLACEHOLDER_PREFIX.test(pw)) return true;
  if (/^[x*.#·-]+$/i.test(pw)) return true; // xxx / ***
  return false;
}

/**
 * generic-secret 的高熵判定：长度 16+、字母与数字都有、熵 ≥ 3.5 bit/char，
 * 且不是"your_api_key"这类占位、不是 URL/路径片段。
 */
export function isHighEntropyValue(value) {
  if (value.length < 16) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  if (PLACEHOLDER_WORDS.test(value) || PLACEHOLDER_PREFIX.test(value)) return false;
  if (/^[a-z]+(?:[\/._-][a-z0-9]+)+$/i.test(value) && !/[0-9]{2}/.test(value)) return false; // 纯路径/URL 片段
  return shannonEntropy(value) >= 3.5;
}

/**
 * DSN 主机是否"本地开发"：localhost/127.0.0.1/::1/0.0.0.0，或 docker-compose 服务名
 * （postgres/db/database/host.docker.internal）。这些连接串在 .env.example、docker-compose、
 * 本地运行手册里是**公开的固定开发凭据**（例如 kaas:kaas_dev@localhost），不是泄漏；
 * 真实生产 DSN 的主机是 ep-xxx.neon.tech 之类，仍会被本规则拦下。
 * 含省略号/尖括号的主机（文档里被截断）也视为占位。
 */
const LOCAL_DSN_HOST =
  /^(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|postgres|db|database|host\.docker\.internal)(?::\d+)?(?:[\/?#]|$)/i;

function isLocalDsnHost(host) {
  if (!host) return true;
  if (/[^\x21-\x7e]/.test(host)) return true; // 省略号 … 等非 ASCII
  if (/[<>]/.test(host)) return true; // <host>
  return LOCAL_DSN_HOST.test(host);
}

function detectPostgresDsn(line) {
  // 只认 postgres:// / postgresql://（可带 +driver），必须有 user:pass@host 三段。
  // 口令里出现 < > 视为模板，交给 isPlaceholderPassword 兜底（这里先允许捕获，便于统一判定）。
  const re = /postgres(?:ql)?(?:\+[a-z0-9]+)?:\/\/([^\s:@\/'"]+):([^\s@\/'"]+)@([^\s\/'"]+)/gi;
  let m;
  while ((m = re.exec(line))) {
    if (isPlaceholderPassword(m[2])) continue;
    if (isLocalDsnHost(m[3])) continue;
    return true;
  }
  return false;
}

function detectGeneric(line) {
  const re =
    /(?:api[_-]?key|access[_-]?key|client[_-]?secret|secret|token)\s*["']?\s*[:=]\s*["']?([A-Za-z0-9_\-+.\/=]{16,})/gi;
  let m;
  while ((m = re.exec(line))) {
    // shell 默认值写法 ${VAR:-local-dev-...} 会把开头的 :/- 带进捕获组，先剥掉再判熵。
    const candidate = m[1].replace(/^[-+./=]+/, "");
    if (isHighEntropyValue(candidate)) return true;
  }
  return false;
}

/** 检测规则表（id 供 allowlist 引用；detect 只看单行，返回 boolean）。 */
export const RULES = [
  {
    id: "private-key",
    label: "PEM 私钥块",
    detect: (line) => /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----/.test(line),
  },
  {
    id: "aws-access-key",
    label: "AWS Access Key ID",
    detect: (line) => /(?<![A-Za-z0-9])AKIA[0-9A-Z]{12,16}(?![A-Za-z0-9])/.test(line),
  },
  {
    id: "github-pat",
    label: "GitHub PAT",
    detect: (line) => /(?<![A-Za-z0-9])(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/.test(line),
  },
  {
    id: "notion-token",
    label: "Notion 集成 token",
    detect: (line) => /(?<![A-Za-z0-9])ntn_[A-Za-z0-9]{30,}/.test(line),
  },
  {
    id: "neon-token",
    label: "Neon API key",
    detect: (line) => /(?<![A-Za-z0-9])npg_[A-Za-z0-9]{10,}/.test(line),
  },
  {
    id: "postgres-dsn",
    label: "带口令的 PostgreSQL DSN",
    detect: detectPostgresDsn,
  },
  {
    id: "resend-key",
    label: "Resend API key",
    detect: (line) => /(?<![A-Za-z0-9])re_[A-Za-z0-9]{16,}/.test(line),
  },
  {
    id: "openai-key",
    label: "OpenAI API key",
    detect: (line) => /(?<![A-Za-z0-9])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/.test(line),
  },
  {
    id: "slack-token",
    label: "Slack token",
    detect: (line) => /xox[baprs]-[A-Za-z0-9-]{10,}/.test(line),
  },
  {
    id: "generic-secret",
    label: "疑似高熵密钥（api_key / secret / token 赋值）",
    detect: detectGeneric,
  },
];

const RULE_IDS = new Set(RULES.map((r) => r.id));

/**
 * 扫描一段文本。返回 [{ file, line, type, label }]；值不回传（只回类型与位置）。
 * 导出供 node --test 直接断言，不必每次都起子进程。
 */
export function scanText(text, file = "<text>") {
  const hits = [];
  const seen = new Set();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const rule of RULES) {
      if (!rule.detect(lines[i])) continue;
      const key = rule.id + ":" + (i + 1);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ file: toPosix(file), line: i + 1, type: rule.id, label: rule.label });
    }
  }
  return hits;
}

/** 路径分隔符统一成 /（allowlist glob 与输出都用这个口径）。 */
export function toPosix(p) {
  return String(p).replace(/\\/g, "/");
}

/**
 * glob → 正则：** 跨目录、* 不跨目录、? 单字符。
 * 仓库路径无空格，allowlist 每行只有两个字段，解析时不会歧义。
 */
export function matchGlob(glob, file) {
  const g = toPosix(glob).replace(/^\.\//, "");
  const f = toPosix(file).replace(/^\.\//, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
        if (g[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$").test(f);
}

/**
 * 解析 allowlist 文本。
 * 格式：<glob> <规则|*> # 原因（'#' 之后是原因，必须非空；空行与整行注释忽略）。
 * 无理由或规则名非法 ⇒ 抛错（调用方 exit 2），避免"静默豁免"。
 */
export function parseAllowlist(text, source = ALLOWLIST_REL) {
  const entries = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const hash = trimmed.indexOf("#");
    const body = (hash >= 0 ? trimmed.slice(0, hash) : trimmed).trim();
    const reason = hash >= 0 ? trimmed.slice(hash + 1).trim() : "";
    const where = source + ":" + (index + 1);
    if (!reason) throw new Error(where + " 缺少原因（格式：<glob> <规则|*> # 原因）");
    const parts = body.split(/\s+/).filter(Boolean);
    if (parts.length !== 2) {
      throw new Error(where + " 格式错误（应为两个字段：<glob> <规则|*>，再用 # 写原因）");
    }
    const glob = parts[0];
    const rule = parts[1];
    if (rule !== "*" && !RULE_IDS.has(rule)) {
      throw new Error(where + " 未知规则名 '" + rule + "'（可用：" + Array.from(RULE_IDS).join(" / ") + " / *）");
    }
    entries.push({ glob, rule, reason, source, line: index + 1 });
  });
  return entries;
}

/** 命中是否被 allowlist 覆盖（按 规则 + 路径 glob 匹配，first match wins）。 */
export function findAllowlistEntry(entries, file, type) {
  for (const entry of entries) {
    if (entry.rule !== "*" && entry.rule !== type) continue;
    if (matchGlob(entry.glob, file)) return entry;
  }
  return null;
}

function isBinary(buf) {
  const probe = buf.subarray(0, 8192);
  for (let i = 0; i < probe.length; i++) if (probe[i] === 0) return true;
  return false;
}

function skipPathReason(rel) {
  const posix = toPosix(rel);
  for (const seg of posix.split("/")) if (SKIP_DIRS.has(seg)) return "构建/依赖目录";
  if (SKIP_EXTS.has(path.extname(posix).toLowerCase())) return "二进制扩展名";
  return null;
}

function gitList(args, cwd) {
  const out = execFileSync("git", args, {
    cwd,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.toString("utf8").split("\0").filter(Boolean);
}

function gitShowIndexBlob(rel, cwd) {
  return execFileSync("git", ["show", ":" + toPosix(rel)], {
    cwd,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
}

function displayPath(root, abs) {
  let rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    // Windows 8.3 短路径（TEMP 常是 河北慷~1...）与 git 返回的长路径不同名，
    // 用 realpath 归一后再试一次，避免 --files 的展示路径退化成绝对路径、导致 allowlist 匹配不上。
    try {
      rel = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(abs));
    } catch {
      // 忽略：realpath 失败时按绝对路径展示（不参与 allowlist 匹配）。
    }
  }
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return toPosix(abs);
  return toPosix(rel);
}

function readWorktreeOrIndex(rel, abs, root) {
  try {
    return fs.readFileSync(abs);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    // 工作树删了但 index 还有（git rm 前/未暂存删除）：退回 index 版本，避免静默漏扫。
    // 注意 cwd 必须传 root：git show :<path> 的 path 是相对 cwd 的，传子目录会解析失败。
    return gitShowIndexBlob(rel, root);
  }
}

class UsageError extends Error {}

const USAGE = [
  "用法：node scripts/check-secrets.mjs [--staged | --files <a,b,...>] [--allowlist <file>]",
  "",
  "  （无参数）        扫描全部 git 跟踪文本文件（git ls-files -z）",
  "  --staged          只扫暂存区（git diff --cached --diff-filter=ACM；内容取 index blob）",
  "  --files <a,b>     显式文件列表（逗号分隔；供自测 / CI 分片）",
  "  --allowlist <f>   指定 allowlist（默认 scripts/secret-scan-allowlist.txt）",
  "  -h, --help        打印本帮助",
  "",
  "allowlist 格式：<glob> <规则|*> # 原因（每条必须写理由；规则见脚本头注释）",
  "退出码：0 = 干净；1 = 命中明文凭据；2 = 用法/配置错误",
].join("\n");

export function parseArgs(argv) {
  const args = { mode: "tree", files: null, allowlist: null, help: false };
  let staged = false;
  let files = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--staged") {
      staged = true;
    } else if (a === "--files") {
      const v = argv[++i];
      if (!v) throw new UsageError("--files 需要一个逗号分隔的文件列表");
      files = v;
    } else if (a.startsWith("--files=")) {
      files = a.slice("--files=".length);
    } else if (a === "--allowlist") {
      args.allowlist = argv[++i];
      if (!args.allowlist) throw new UsageError("--allowlist 需要一个文件路径");
    } else if (a.startsWith("--allowlist=")) {
      args.allowlist = a.slice("--allowlist=".length);
    } else {
      throw new UsageError("未知参数：" + a);
    }
  }
  if (staged && files) throw new UsageError("--staged 与 --files 不能同时使用");
  if (staged) args.mode = "staged";
  if (files) {
    args.mode = "files";
    args.files = files.split(",").map((s) => s.trim()).filter(Boolean);
    if (!args.files.length) throw new UsageError("--files 列表为空");
  }
  if (args.allowlist === "") throw new UsageError("--allowlist 路径为空");
  return args;
}

/** 收集待扫描目标：[{ rel, read() }]；读失败/超大/二进制在扫描阶段计入"跳过"。 */
function collectTargets(root, args) {
  const cwd = process.cwd();
  const targets = [];
  if (args.mode === "staged") {
    for (const rel of gitList(["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"], root)) {
      targets.push({ rel: toPosix(rel), read: () => gitShowIndexBlob(rel, root) });
    }
  } else if (args.mode === "files") {
    for (const raw of args.files) {
      const abs = path.resolve(cwd, raw);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        throw new UsageError("--files 指定的文件不存在或不是普通文件：" + raw);
      }
      targets.push({ rel: displayPath(root, abs), read: () => fs.readFileSync(abs) });
    }
  } else {
    for (const rel of gitList(["ls-files", "-z"], root)) {
      const abs = path.join(root, rel);
      targets.push({ rel: toPosix(rel), read: () => readWorktreeOrIndex(rel, abs, root) });
    }
  }
  return targets;
}

export function main(argv = process.argv.slice(2)) {
  const started = Date.now();
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const root = gitRoot();
  const cwd = process.cwd();
  const allowlistPath = args.allowlist ? path.resolve(cwd, args.allowlist) : path.join(root, ALLOWLIST_REL);
  let allowEntries = [];
  if (fs.existsSync(allowlistPath)) {
    allowEntries = parseAllowlist(fs.readFileSync(allowlistPath, "utf8"), displayPath(root, allowlistPath));
  } else if (args.allowlist) {
    throw new UsageError("--allowlist 指定的文件不存在：" + allowlistPath);
  }

  const targets = collectTargets(root, args);
  const hits = [];
  let scanned = 0;
  const skipped = [];

  for (const target of targets) {
    const skipReason = skipPathReason(target.rel);
    if (skipReason) {
      skipped.push(target.rel + "（" + skipReason + "）");
      continue;
    }
    let buf;
    try {
      buf = target.read();
    } catch (err) {
      skipped.push(target.rel + "（读取失败：" + (err.code || err.message) + "）");
      continue;
    }
    if (buf.length > MAX_FILE_BYTES) {
      skipped.push(target.rel + "（>" + MAX_FILE_BYTES + " bytes）");
      continue;
    }
    if (isBinary(buf)) {
      skipped.push(target.rel + "（二进制）");
      continue;
    }
    const text = buf.toString("utf8");
    hits.push(...scanText(text, target.rel));
    scanned++;
  }

  const allowed = [];
  const failing = [];
  for (const hit of hits) {
    const entry = findAllowlistEntry(allowEntries, hit.file, hit.type);
    if (entry) allowed.push({ hit, entry });
    else failing.push(hit);
  }
  const usedEntries = new Set(allowed.map((a) => a.entry));
  const modeLabel =
    args.mode === "staged" ? "staged（暂存区 index blob）" : args.mode === "files" ? "files（显式文件）" : "tree（git 跟踪文件）";

  console.log(
    "[secret:scan] 模式=" + modeLabel + " 扫描=" + scanned + " 跳过=" + skipped.length +
      " 规则=" + RULES.length + " allowlist=" +
      (fs.existsSync(allowlistPath) ? displayPath(root, allowlistPath) : "未提供（0 条）") +
      "（" + allowEntries.length + " 条）"
  );

  if (allowed.length) {
    console.log("allowlist 命中 " + allowed.length + " 条（按登记豁免，未计入失败；仅报位置与类型）：");
    for (const { hit, entry } of allowed) {
      console.log(
        "  · " + hit.file + ":" + hit.line + " [" + hit.type + "] — " + entry.reason + "（登记行 " + entry.line + "）"
      );
    }
  }

  if (failing.length) {
    console.error("[secret:scan] FAIL：命中 " + failing.length + " 条明文凭据（只报 文件:行 + 类型，值不回显）");
    failing.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.type.localeCompare(b.type));
    for (const hit of failing.slice(0, 200)) {
      console.error("  ✗ " + hit.file + ":" + hit.line + " [" + hit.type + "] " + hit.label);
    }
    if (failing.length > 200) console.error("  …（仅显示前 200 条）");
    console.error(
      "  修复：从代码里删除明文，改环境变量 / CI secrets（AGENTS.md §0 密钥铁律，DSH-Admin 只做用户级环境变量）；\n" +
        "  确属文档示例 / 测试假值 ⇒ 在 scripts/secret-scan-allowlist.txt 登记（<glob> <规则|*> # 原因），禁止绕道。"
    );
    return 1;
  }

  console.log("[secret:scan] PASS：未发现明文凭据（耗时 " + (Date.now() - started) + "ms）");
  if (args.mode === "tree" && allowEntries.length) {
    const unused = allowEntries.filter((e) => !usedEntries.has(e));
    if (unused.length) {
      console.log(
        "提示：allowlist 有 " + unused.length + " 条本次未命中（tree 模式会点名；--staged/--files 子集下未命中属正常）"
      );
    }
  }
  return 0;
}

function isInvokedDirectly() {
  if (!process.argv[1]) return false;
  const a = path.resolve(process.argv[1]);
  const b = path.resolve(SCRIPT_PATH);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (isInvokedDirectly()) {
  try {
    const code = main();
    process.exitCode = code;
  } catch (err) {
    if (err instanceof UsageError) console.error("[secret:scan] ERROR：" + err.message + "\n\n" + USAGE);
    else console.error("[secret:scan] ERROR：" + (err && err.stack ? err.stack : err));
    process.exitCode = 2;
  }
}
