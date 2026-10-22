#!/usr/bin/env node
/**
 * 静态导出产物门禁（2026-10-22，P2 防复发）
 *
 * 为什么要有它：2026-10-21/22 生产出过两个真实缺陷，都属于"构建产物类型"的问题，
 * 单测/e2e 抓不到（e2e 跑 dev server，dev 不产出静态导出）：
 *
 *  ① 侧边栏点击不跳转：`sidebar.tsx` 里显式 `prefetch={true}` + 静态导出 ⇒ 点击导航永久挂死
 *     （linkClicked 先 preventDefault，随后等 prefetch 永不 resolve；30s 零请求零报错）。
 *  ② 全站逐段预取 404：**Windows 本机构建**时 `path.relative()` 返回反斜杠，而 Next 只把 `/` 换成 `.`，
 *     逐段文件被写成目录（`__next.X\Y.txt`），客户端请求的点号名（`__next.X.Y.txt`）永远 404。
 *
 * 本门禁做四件事（全部确定性、毫秒级）：
 *   A. `out/` 里**不允许**出现名字含反斜杠的文件（Windows 构建特征）；
 *   B. `out/` 里**不允许**出现以 `__next.` 开头的**目录**（②的目录形态）；
 *   C. `out/` 的 html/txt 里引用的 `/_next/static/*` 必须全部能在 `out/` 里解析到（产物完整性）；
 *   D. `frontend/src` 里**不允许**出现 `prefetch={true}`（①的根因；目前只应出现在文档/测试里）。
 *
 * 用法：`cd frontend && pnpm assets:check`（默认检查 ./out）
 *       `node scripts/check-export-assets.mjs --dir <out目录> [--src <frontend/src>]`
 * 退出码：0 = 通过；1 = 有违规（会逐条打印 + 给修复指引）。
 */
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { dir: null, src: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--dir") args.dir = argv[++i];
    else if (argv[i] === "--src") args.src = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv);
const outDir = path.resolve(args.dir || path.join(process.cwd(), "out"));
const srcDir = path.resolve(args.src || path.join(process.cwd(), "src"));

const problems = [];
const stats = { files: 0, htmlTxt: 0, refs: 0, badNames: 0, nextDirs: 0, missingRefs: 0, prefetchHits: 0 };

const HINT = [
  "修复指引：",
  "  · 含反斜杠的文件名 / __next.* 目录 ⇒ 别用 Windows 本机构建，改用 CI（ubuntu）或 Docker node:22 容器构建；",
  "  · /_next/static/* 引用缺失 ⇒ 产物不完整（并发构建覆盖了 .next？），工作区静止后重建；",
  "  · prefetch={true} ⇒ 静态导出下会挂死点击导航，改成 prefetch={false}。",
  "  背景与取证：docs/HANDOVER_2026-10-21_NAV_STUCK.md",
].join("\n");

if (!fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory()) {
  console.error(`[assets:check] FAIL  找不到导出产物：${outDir}`);
  console.error("  先构建：cd frontend; $env:NEXT_EXPORT='1'; pnpm build");
  process.exit(1);
}

const REF_RE = /\/_next\/static\/(?:chunks|media|css)\/[A-Za-z0-9._!\/-]+\.(?:js|css|woff2|png|svg)/g;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith("__next.")) {
        stats.nextDirs++;
        if (problems.length < 200) problems.push(`[B] __next.* 目录（应为扁平文件）：${path.relative(outDir, abs)}`);
      }
      walk(abs);
      continue;
    }
    stats.files++;
    if (entry.name.includes("\\")) {
      stats.badNames++;
      if (problems.length < 200) problems.push(`[A] 文件名含反斜杠：${path.relative(outDir, abs)}`);
    }
    if (/\.(html|txt)$/.test(entry.name)) {
      stats.htmlTxt++;
      const text = fs.readFileSync(abs, "utf8");
      for (const m of text.match(REF_RE) || []) {
        stats.refs++;
        const target = path.join(outDir, m.replace(/^\//, ""));
        if (!fs.existsSync(target)) {
          stats.missingRefs++;
          if (problems.length < 200) problems.push(`[C] 引用不存在：${m}（来自 ${path.relative(outDir, abs)}）`);
        }
      }
    }
  }
}
walk(outDir);

if (fs.existsSync(srcDir)) {
  const stack = [srcDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!/\.(tsx?|jsx?)$/.test(entry.name)) continue;
      const text = fs.readFileSync(abs, "utf8");
      const lines = text.split("\n");
      let inBlockComment = false;
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        // 注释里提到 prefetch={true} 是**文档**（正是本门禁要让人读懂的地方），不能当成违规：
        // 实测踩过 —— sidebar.tsx 修复时把原因写在注释里，第一版门禁把注释判成了违规。
        if (inBlockComment) {
          if (trimmed.includes("*/")) inBlockComment = false;
          return;
        }
        if (trimmed.startsWith("/*")) {
          if (!trimmed.includes("*/")) inBlockComment = true;
          return;
        }
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (/prefetch\s*=\s*\{\s*true\s*\}/.test(line)) {
          stats.prefetchHits++;
          if (problems.length < 200) {
            problems.push(`[D] prefetch={true}（静态导出下会挂死点击导航）：${path.relative(path.resolve(srcDir, ".."), abs)}:${i + 1}`);
          }
        }
      });
    }
  }
}

const summary = [
  `[assets:check] dir=${outDir}`,
  `  files=${stats.files} html/txt=${stats.htmlTxt} refs=${stats.refs}`,
  `  违规：badNames=${stats.badNames} nextDirs=${stats.nextDirs} missingRefs=${stats.missingRefs} prefetchTrue=${stats.prefetchHits}`,
].join("\n");
console.log(summary);

if (problems.length > 0) {
  console.error("\n[assets:check] FAIL");
  for (const p of problems) console.error("  " + p);
  if (problems.length >= 200) console.error("  …（仅显示前 200 条）");
  console.error("\n" + HINT);
  process.exit(1);
}

console.log("[assets:check] PASS（产物形态与引用均正常）");
