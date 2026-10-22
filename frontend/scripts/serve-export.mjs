#!/usr/bin/env node
/**
 * 导出态 e2e 用的静态服务器（2026-10-22）
 *
 * 目的：让 e2e 跑在**真实静态导出产物**上（`frontend/out`），而不是 `next dev`。
 * 语义尽量贴近 Cloudflare Workers Assets（`backend/ts-worker/wrangler.jsonc`）：
 *   · 精确文件命中 → 直接返回；
 *   · 无扩展名 / 目录 → 试 `<path>.html`、`<path>/index.html`；
 *   · 仍未命中且请求 `Accept: text/html`（= 浏览器导航）→ 回退 `index.html`（SPA），
 *     否则 404（对应 Workers Assets 只对导航请求回退 SPA 的行为 —— 这也是为什么
 *     逐段预取 `.txt` 取不到时会真 404，而不是被 index.html 伪装成 200）。
 *
 * 用法：node scripts/serve-export.mjs [port]   （默认 4173，目录固定为 ../out 相对本文件）
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// 默认伺服 frontend/out；`E2E_EXPORT_DIR` 可指向别的产物目录（用于门禁的阳性对照/排障）
const root = process.env.E2E_EXPORT_DIR
  ? path.resolve(process.env.E2E_EXPORT_DIR)
  : path.resolve(here, "..", "out");
const port = Number(process.argv[2] || process.env.E2E_EXPORT_PORT || 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=UTF-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json",
};

if (!fs.existsSync(root)) {
  console.error(`[serve-export] 找不到导出产物：${root}`);
  console.error("  先构建：pnpm e2e:export（会自动构建）或 NEXT_EXPORT=1 pnpm build");
  process.exit(1);
}

const send = (res, status, body, type) => {
  res.writeHead(status, {
    "content-type": type || "text/plain; charset=UTF-8",
    // e2e 期间禁缓存：避免重建产物后仍拿到上一轮的文件
    "cache-control": "no-store",
  });
  res.end(body);
};

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, "method not allowed");
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", `http://127.0.0.1:${port}`).pathname);
  } catch {
    return send(res, 400, "bad request");
  }
  if (pathname.endsWith("/")) pathname += "index.html";

  const file = path.join(root, pathname);
  const hit = isFile(file) ? file : isFile(file + ".html") ? file + ".html" : isFile(path.join(file, "index.html")) ? path.join(file, "index.html") : null;

  if (hit) {
    const body = fs.readFileSync(hit);
    return send(res, 200, body, MIME[path.extname(hit).toLowerCase()] || "application/octet-stream");
  }

  const acceptsHtml = String(req.headers.accept || "").includes("text/html");
  if (acceptsHtml) {
    const index = path.join(root, "index.html");
    if (isFile(index)) return send(res, 200, fs.readFileSync(index), MIME[".html"]);
  }
  return send(res, 404, "404 Not Found");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[serve-export] serving ${root} on http://localhost:${port}`);
});
