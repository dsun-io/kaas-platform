#!/usr/bin/env node
/**
 * UI 对比度门禁：解析 globals.css 的 :root / .dark 语义 token，
 * 用 OKLCH→sRGB 计算 WCAG 对比度，低于 4.5 直接失败。
 *
 * 用法：pnpm ui:contrast
 */
"use strict";

const fs = require("fs");
const path = require("path");

const cssPath = path.join(__dirname, "..", "src", "app", "globals.css");
const css = fs.readFileSync(cssPath, "utf8");

function extractBlock(selector) {
  const i = css.indexOf(selector);
  if (i < 0) throw new Error(`找不到选择器 ${selector}`);
  const start = css.indexOf("{", i);
  let depth = 0;
  let end = start;
  for (let j = start; j < css.length; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}") {
      depth--;
      if (depth === 0) {
        end = j;
        break;
      }
    }
  }
  return css.slice(start + 1, end);
}

function parseTokens(body) {
  const map = {};
  for (const m of body.matchAll(
    /--([\w-]+):\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*;/g,
  )) {
    map[m[1]] = [+m[2], +m[3], +m[4]];
  }
  return map;
}

function oklchToRgb([L, C, H]) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [r, g, bl].map((v) => {
    const x = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(x * 255)));
  });
}

function luminance([r, g, b]) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const PAIRS = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["primary-foreground", "primary"],
  ["destructive-foreground", "destructive"],
  ["success-muted-foreground", "success-muted"],
  ["warning-muted-foreground", "warning-muted"],
  ["info-muted-foreground", "info-muted"],
  ["destructive-muted-foreground", "destructive-muted"],
  ["accent-foreground", "accent"],
  ["sidebar-foreground", "sidebar"],
];

const light = parseTokens(extractBlock(":root {"));
const dark = parseTokens(extractBlock(".dark {"));

let failed = 0;
for (const [theme, tokens] of [
  ["light", light],
  ["dark", dark],
]) {
  for (const [fg, bg] of PAIRS) {
    if (!tokens[fg] || !tokens[bg]) continue;
    const r = contrast(oklchToRgb(tokens[fg]), oklchToRgb(tokens[bg]));
    const ok = r >= 4.5;
    console.log(
      `${ok ? "PASS" : "FAIL"} ${theme.padEnd(5)} ${fg} on ${bg}: ${r.toFixed(2)}`,
    );
    if (!ok) failed++;
  }
}

if (failed) {
  console.error(`\n对比度门禁失败：${failed} 对低于 4.5`);
  process.exit(1);
}
console.log("\n对比度门禁通过（light/dark，全部 >= 4.5）");
