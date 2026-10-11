/**
 * 离线渲染单证（系统能力，不是一次性脚本）
 * ─────────────────────────────────────────
 * 用途：拿一份业务数据 JSON，用**单证工位自己的渲染器**算出可打印的 HTML。
 * 与 `scripts/gen-trade-doc-fixtures.ts` 同一套路（tsx 跑 TS、复用
 * `frontend/src/lib/trade-doc/render`），区别是面向真实单据而不是回归基线。
 *
 * 为什么需要它：单证工位在生产是"前端渲染"架构（Worker 不带模板引擎），
 * 因此**离线/批量出单**（对账、补发、批量套打）没有入口；而一次性脚本会把
 * 客户数据硬编码进文件（本任务第一版就是那样，已被要求并入系统）。
 *
 * 用法（仓库根目录）：
 *   node <node> frontend/node_modules/tsx/dist/cli.mjs scripts/render-trade-doc.ts \
 *        --type pi --data artifacts/pi-payload.json --out artifacts/pi.html \
 *        [--assets-dir artifacts/assets] [--quiet]
 *
 * 数据格式：与 `render-data` 接口返回的 `data` 同形（seller/buyer/items/currency…）。
 * 图片字段（`company_stamp` / `product_photos[].image`）可写**本地文件路径**，
 * 由本脚本按扩展名转成 `data:` URI 内联 —— 渲染器只接受 data URI 与 http(s)，
 * 直接传路径会被安全白名单丢弃（那是防注入的设计，不动）。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";

import {
  renderTradeDoc,
  getAvailableTemplates,
  getTemplateFields,
} from "../frontend/src/lib/trade-doc/render";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = "true";
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

/** 本地路径 → data URI（已是 data:/http(s) 的原样返回；转不了的原样返回，让渲染器按白名单丢弃） */
function toDataUri(value: unknown, assetsDir: string): unknown {
  if (typeof value !== "string") return value;
  const raw = value.trim();
  if (/^(data:|https?:\/\/)/i.test(raw)) return raw;
  const abs = isAbsolute(raw) ? raw : resolve(assetsDir, raw);
  const mime = MIME_BY_EXT[extname(abs).toLowerCase()];
  if (!mime || !existsSync(abs)) return raw;
  return `data:${mime};base64,${readFileSync(abs).toString("base64")}`;
}

/** 把数据里所有图片位（顶层图片字段 + 产品照片列表）的本地路径转成 data URI */
function inlineImages(data: Record<string, unknown>, assetsDir: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  if ("company_stamp" in out) out.company_stamp = toDataUri(out.company_stamp, assetsDir);
  if (Array.isArray(out.product_photos)) {
    out.product_photos = (out.product_photos as Record<string, unknown>[]).map((photo) => {
      if (typeof photo !== "object" || photo === null) return photo;
      const next: Record<string, unknown> = { ...photo };
      if ("image" in next) next.image = toDataUri(next.image, assetsDir);
      if ("src" in next) next.src = toDataUri(next.src, assetsDir);
      return next;
    });
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const docType = args.type ?? "";
const dataPath = args.data ?? "";
if (!docType || !dataPath) {
  console.error(
    "用法: render-trade-doc.ts --type <docType> --data <payload.json> [--out <out.html>] [--assets-dir <dir>]\n" +
      "可用类型: " +
      getAvailableTemplates()
        .map((t) => t.doc_type)
        .join(", "),
  );
  process.exit(2);
}
if (!getTemplateFields(docType)) {
  console.error(`不支持的单证类型: ${docType}`);
  process.exit(2);
}

const assetsDir = args["assets-dir"] ? resolve(args["assets-dir"]) : resolve(".");
const payload = JSON.parse(readFileSync(resolve(dataPath), "utf-8")) as Record<string, unknown>;
const html = renderTradeDoc(docType, inlineImages(payload, assetsDir));

const outPath = args.out ? resolve(args.out) : join(resolve("."), `${docType}.html`);
writeFileSync(outPath, html, "utf-8");

if (args.quiet !== "true") {
  console.log(
    JSON.stringify({
      doc_type: docType,
      out: outPath,
      bytes: Buffer.byteLength(html, "utf-8"),
      assets_dir: assetsDir,
      leftover_placeholder: /\$[A-Za-z_]/.test(html),
      has_stamp: html.includes("stamp-img"),
      photo_blocks: (html.match(/class="photos"/g) ?? []).length,
    }),
  );
}
