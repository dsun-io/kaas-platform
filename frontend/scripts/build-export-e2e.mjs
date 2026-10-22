#!/usr/bin/env node
/**
 * 为「导出态 e2e」构建静态导出产物（2026-10-22）
 *
 * 与生产构建的唯一差异都在 env 里（都是构建期内联的常量）：
 *   · NEXT_PUBLIC_API_MODE=mock        → 页面里跑 MSW（假数据层即"后端"，无需真实 API/DB）
 *   · NEXT_PUBLIC_API_BASE_URL=http://localhost:4173
 *     → 必须与静态服务器同源，否则 MSW 的相对路径 handler 匹配不上（历史踩坑，见 src/mocks/handlers.ts 注释）
 *
 * 其余保持与生产一致（NEXT_EXPORT=1 → output:"export"），因为 e2e 要验证的正是**导出态本身**
 * （客户端路由 / RSC .txt 导航 / 逐段预取 / SPA 回退）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(here, "..");
const outDir = path.join(frontendDir, "out");

const nextBin = require.resolve("next/dist/bin/next");

// 先清 out/：避免上一轮（可能是 Windows 构建）的残留文件混进来，让 e2e 测到假象
fs.rmSync(outDir, { recursive: true, force: true });

console.log("[e2e:export] 构建静态导出（mock API，baseURL=http://localhost:4173）…");
const started = Date.now();
const result = spawnSync(process.execPath, [nextBin, "build"], {
  cwd: frontendDir,
  stdio: "inherit",
  env: {
    ...process.env,
    NEXT_EXPORT: "1",
    NEXT_PUBLIC_API_MODE: "mock",
    NEXT_PUBLIC_API_BASE_URL: "http://localhost:4173",
    NEXT_TELEMETRY_DISABLED: "1",
    // e2e 不需要 Sentry 上传
    SENTRY_AUTH_TOKEN: "",
  },
});

if (result.status !== 0) {
  console.error(`[e2e:export] 构建失败（exit=${result.status}）`);
  process.exit(result.status ?? 1);
}

if (!fs.existsSync(path.join(outDir, "index.html"))) {
  console.error("[e2e:export] 构建完成但 out/index.html 不存在 —— 静态导出未产出，检查 next.config.mjs 的 output 分支");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows 兜底：把逐段预取文件拍平成 Linux 构建的形态
//
// Next 的导出侧用 `path.relative()` 拼段路径、再只把 `/` 换成 `.`。Windows 上 relative()
// 返回反斜杠 ⇒ 文件被写成**目录**：`out/products/__next.!KGFwcCk/products/__PAGE__.txt`；
// 而客户端请求的是 `out/products/__next.!KGFwcCk.products.__PAGE__.txt` ⇒ 全站预取 404。
// 这是「Windows 构建不得直接 deploy」那条硬约束的成因（2026-10-22 线上事故 P1）。
//
// e2e 要验证的是**导出态行为**，产物形态应与 CI/生产（ubuntu 构建）一致，所以这里做等价拍平：
//   · Linux/CI 上跑：out 里没有 `__next.*` 目录 ⇒ 本函数是 no-op（CI nightly 走这条）；
//   · Windows 上跑：拍平后与 Linux 产物同形，本地也能验证（不影响 assets:check 对真实 Windows 构建说不）。
function flattenExportSegmentNames(dir) {
  let moved = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      const relParts = path.relative(outDir, abs).split(path.sep);
      const idx = relParts.findIndex((part) => part.startsWith("__next."));
      if (idx < 0 || idx === relParts.length - 1) continue;
      const targetRel = [...relParts.slice(0, idx), relParts.slice(idx).join(".")].join(path.sep);
      const target = path.join(outDir, targetRel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(abs, target);
      moved++;
    }
  };
  walk(outDir);

  // 清掉拍平后残留的空目录（`__next.!KGFwcCk/` 之类）
  const prune = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const abs = path.join(current, entry.name);
      prune(abs);
      if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
    }
  };
  prune(outDir);
  return moved;
}

const flattened = flattenExportSegmentNames(outDir);
if (flattened > 0) {
  console.log(
    `[e2e:export] 注意：Windows 构建把 ${flattened} 个逐段预取文件写成了目录，已拍平成 Linux 形态（CI 上不会发生）`,
  );
}

const files = fs.readdirSync(outDir, { recursive: true }).length;
console.log(`[e2e:export] 构建完成：${files} 个条目，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
