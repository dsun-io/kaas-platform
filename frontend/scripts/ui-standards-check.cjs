#!/usr/bin/env node
/**
 * UI 设计规范静态门禁（硬性约束）。
 *
 * 覆盖范围：frontend/src/app 与 frontend/src/components（跳过 ui  primitives 与测试）。
 * 规则：
 *  1. 业务页禁止手写 <h1>（统一 PageHeader）
 *  2. 原生 <th> 必须显式 scope="col"（共享 TableHead 已默认）
 *  3. 业务页/业务组件禁止手写 border-b-2 tab（统一 ui/tabs）
 *  4. 禁止硬编码 red/green/amber/emerald 状态色（统一 semantic tokens）
 *  5. layout viewport 禁止 maximumScale
 *
 * 用法：pnpm ui:standards
 */
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const scanRoots = ["src/app", "src/components"];
const skipDirPatterns = [/node_modules/, /__tests__/, /src[\\/]components[\\/]ui[\\/]/];
const testFilePattern = /\.(test|spec)\.(ts|tsx|js|jsx)$/;

const violations = [];
const counts = {
  h1: 0,
  thScope: 0,
  handTab: 0,
  hardColor: 0,
  maximumScale: 0,
};

function lineOf(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function add(file, text, index, rule, message) {
  counts[rule] += 1;
  const rel = path.relative(root, file);
  violations.push(`${rel}:${lineOf(text, index)} ${message}`);
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirPatterns.some((re) => re.test(full))) continue;
      yield* walk(full);
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      if (testFilePattern.test(entry.name)) continue;
      if (full.includes(`${path.sep}components${path.sep}ui${path.sep}`)) continue;
      yield full;
    }
  }
}

for (const scanRoot of scanRoots) {
  const absRoot = path.join(root, scanRoot);
  if (!fs.existsSync(absRoot)) continue;

  for (const file of walk(absRoot)) {
    const text = fs.readFileSync(file, "utf8");
    const isAppRoute = /src[\\/]app[\\/]\(app\)[\\/]/.test(file);

    // 1) 业务页禁止手写 h1（PageHeader 是唯一 h1 来源）
    if (isAppRoute) {
      for (const m of text.matchAll(/<h1\b/g)) {
        add(file, text, m.index, "h1", "业务页禁止手写 <h1>；请使用 PageHeader");
      }
    }

    // 2) 原生 th 必须显式 scope
    for (const m of text.matchAll(/<th\b[^>]*>/g)) {
      if (!/\bscope=/.test(m[0])) {
        add(file, text, m.index, "thScope", "原生 <th> 缺少 scope=\"col\"");
      }
    }

    // 3) 禁止手写 border-b-2 tab（ui/tabs 是唯一 tab 实现）
    for (const m of text.matchAll(/border-b-2/g)) {
      add(file, text, m.index, "handTab", "禁止手写 border-b-2 tab；请使用 ui/tabs");
    }

    // 4) 禁止硬编码状态色（semantic tokens 见 docs/UI_STANDARDS.md）
    for (const m of text.matchAll(/(?:text|bg|border)-(red|green|amber|emerald)-/g)) {
      add(file, text, m.index, "hardColor", `禁止硬编码状态色 ${m[0]}；请改用 success/warning/destructive token`);
    }
  }
}

// 5) viewport 禁止禁缩放
const layout = path.join(root, "src/app/layout.tsx");
if (fs.existsSync(layout)) {
  const text = fs.readFileSync(layout, "utf8");
  for (const m of text.matchAll(/maximumScale/g)) {
    add(layout, text, m.index, "maximumScale", "viewport 不得出现 maximumScale；不要禁用用户缩放");
  }
}

if (violations.length > 0) {
  console.error(`UI 标准门禁失败：${violations.length} 处违规\n`);
  for (const v of violations.slice(0, 200)) console.error(`FAIL ${v}`);
  if (violations.length > 200) console.error(`... 其余 ${violations.length - 200} 处省略`);
  console.error("\n规范见 docs/UI_STANDARDS.md");
  process.exit(1);
}

console.log("UI 标准门禁通过：h1 / 原生th scope / 手写tab / 硬编码状态色 / viewport缩放 全部合规");
