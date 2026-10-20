#!/usr/bin/env python3
"""S5-a：从生产 wrangler.jsonc 渲染**预览专用**配置（不落盘机密，只改非机密绑定）。

改动项（对照生产配置逐项说明，全部来源环境变量 ⇒ 代码无硬编码资源标识）：
  name          → kaas-preview-pr-<slug>        （PREVIEW_WORKER_NAME）
  workers_dev   → true；routes 清空             （预览只走 workers.dev，绝不挂生产域名）
  triggers.crons→ 移除                          （预览 worker 不得跑生产定时任务：
                                                 cron 触发会扫描/归档预览库，污染预览语义）
  hyperdrive    → HYPERDRIVE.id = <ensure 建的 config>
  r2_buckets    → FILES.bucket_name = <预览桶>
  kv_namespaces → 新增 PREVIEW_KV = <预览 namespace>（生产配置无 KV，零影响）
  vars          → PR_SLUG=<slug>；S3_BUCKET=<预览桶>（S3 直传路径同样进预览桶）

用法（CI，backend/worker 目录下）：
  python3 ../../scripts/preview/render-wrangler-config.py \
      --slug 123 --out wrangler.preview.jsonc
环境变量：PREVIEW_HYPERDRIVE_ID PREVIEW_R2_BUCKET PREVIEW_KV_NAMESPACE_ID
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

_HERE = __file__.rsplit("\\", 1)[0] if "\\" in __file__ else __file__.rsplit("/", 1)[0]
_REPO_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, _HERE)

from preview_lib import PreviewError, evidence, log, require_env, step  # noqa: E402

DEFAULT_SRC = os.path.join(_REPO_ROOT, "backend", "worker", "wrangler.jsonc")


def strip_jsonc(text: str) -> str:
    """去掉 // 与 块注释（带字符串状态机，避免误伤 URL/正则里的符号）。"""
    out: list[str] = []
    i, n = 0, len(text)
    in_str = False
    escape = False
    while i < n:
        ch = text[i]
        if in_str:
            out.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            i += 1
            continue
        if ch == '"':
            in_str = True
            out.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] not in "\r\n":
                i += 1
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description="渲染预览 wrangler 配置")
    ap.add_argument("--src", default=DEFAULT_SRC)
    ap.add_argument("--out", required=True)
    ap.add_argument("--slug", required=True, help="PR slug（纯数字）")
    # 2026-10-20 实验开关：怀疑 KV 绑定导致 Python Worker isolate 每 ~10 分钟崩溃，
    # --no-kv 渲染不带 KV 的预览配置（生产本身无 KV 绑定，预览也不依赖它）。
    ap.add_argument("--no-kv", action="store_true", default=False,
                    help="不注入 PREVIEW_KV 绑定（KV 崩溃实验用）")
    args = ap.parse_args()

    if not re.fullmatch(r"[0-9]{1,9}", args.slug):
        raise PreviewError(f"slug 非法: {args.slug!r}（只允许纯数字 PR 号）")
    need = ["PREVIEW_HYPERDRIVE_ID", "PREVIEW_R2_BUCKET"]
    if not args.no_kv:
        need.append("PREVIEW_KV_NAMESPACE_ID")
    env = require_env(need)

    step(f"读生产配置 {args.src}")
    with open(args.src, encoding="utf-8") as fh:
        cfg = json.loads(strip_jsonc(fh.read()))
    evidence("生产 worker name（不改动源文件）", cfg.get("name"))

    worker_name = f"kaas-preview-pr-{args.slug}"
    cfg["name"] = worker_name
    cfg["workers_dev"] = True
    cfg.pop("routes", None)                    # 预览绝不挂生产域名
    cfg.pop("triggers", None)                  # 预览不跑生产 cron
    for hd in cfg.get("hyperdrive", []):
        if hd.get("binding") == "HYPERDRIVE":
            hd["id"] = env["PREVIEW_HYPERDRIVE_ID"]
    for r2 in cfg.get("r2_buckets", []):
        if r2.get("binding") == "FILES":
            r2["bucket_name"] = env["PREVIEW_R2_BUCKET"]
    cfg.setdefault("kv_namespaces", [])
    cfg["kv_namespaces"] = [
        b for b in cfg["kv_namespaces"] if b.get("binding") != "PREVIEW_KV"]
    if args.no_kv:
        evidence("PREVIEW_KV", "已按 --no-kv 移除（KV 崩溃实验）")
    else:
        cfg["kv_namespaces"].append({
            "binding": "PREVIEW_KV", "id": env["PREVIEW_KV_NAMESPACE_ID"]})
    vars_ = cfg.setdefault("vars", {})
    vars_["PR_SLUG"] = args.slug
    vars_["S3_BUCKET"] = env["PREVIEW_R2_BUCKET"]

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
    step(f"写出预览配置 {args.out}")
    evidence("name / workers_dev", f"{worker_name} / true")
    evidence("HYPERDRIVE.id", env["PREVIEW_HYPERDRIVE_ID"])
    evidence("FILES.bucket", env["PREVIEW_R2_BUCKET"])
    if not args.no_kv:
        evidence("PREVIEW_KV.id", env["PREVIEW_KV_NAMESPACE_ID"])
    evidence("vars.PR_SLUG / S3_BUCKET", f"{args.slug} / {env['PREVIEW_R2_BUCKET']}")
    evidence("routes / crons", "已移除（预览走 workers.dev，无定时任务）")
    log("✅ 渲染完成")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except PreviewError as exc:
        log(f"❌ {exc}")
        sys.exit(1)
