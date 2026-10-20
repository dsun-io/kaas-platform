#!/usr/bin/env python3
"""S5-d 防污染断言：核对**已部署** Worker 的真实绑定（README §2.3 规则 9，任一失败即中止）。

不读静态配置文件（那只能证明"我们想配什么"），而是调 CF API 拉线上 script settings，
断言**实际绑定**指向正确的环境资源，且生产/预览值互异。

两种模式：
  --mode preview（preview.yml 部署前/后跑）：
      R2  binding FILES        == $EXPECT_R2_BUCKET（= kaas-preview-storage 变量）
      KV  binding PREVIEW_KV   == $EXPECT_KV_ID（= KAAS_PREVIEW namespace 变量）
      HD  binding HYPERDRIVE   == $EXPECT_HYPERDRIVE_ID（ensure 步骤输出）
      var PR_SLUG（--config 渲染产物核对）== --slug
      禁用：R2 不得等于 $FORBIDDEN_R2_BUCKETS（含生产桶 kaas-files）
            HD 不得等于 $FORBIDDEN_HYPERDRIVE_IDS（含生产 f53fed49… 变量注入）
  --mode production（deploy.yml 部署后跑）：
      R2  binding FILES        == $EXPECT_PROD_R2_BUCKET（变量，当前 kaas-files）
      HD  binding HYPERDRIVE   == $EXPECT_PROD_HYPERDRIVE_ID（变量）
      KV  不得存在任何等于预览 namespace id 的绑定（生产暂无 KV 绑定 ⇒ 断言通过）
      var PR_SLUG 必须未注入（生产零影响）

期望/禁用值一律环境变量注入（CI 用 repo variables/secrets），脚本不硬编码资源标识。
"""
from __future__ import annotations

import argparse
import json
import os
import sys

_HERE = __file__.rsplit("\\", 1)[0] if "\\" in __file__ else __file__.rsplit("/", 1)[0]
sys.path.insert(0, _HERE)

from preview_lib import (  # noqa: E402
    CloudflareClient, PreviewError, evidence, http_json, log, require_env, step,
)


def deployed_settings(cf: CloudflareClient, script: str) -> dict:
    """GET /workers/scripts/{script}/settings → result（bindings 等）。"""
    _, body = http_json("GET", cf._acct(f"/workers/scripts/{script}/settings"),
                        headers=cf.headers)
    result = (body or {}).get("result", {})  # type: ignore[union-attr]
    if not result:
        raise PreviewError(f"取不到 {script} 的线上 settings（脚本不存在？）")
    return result


def bindings_by_type(settings: dict, btype: str) -> list[dict]:
    return [b for b in settings.get("bindings", []) or [] if b.get("type") == btype]


def check_equal(label: str, actual, expected) -> list[str]:
    if actual != expected:
        return [f"{label}: 实际 {actual!r} ≠ 期望 {expected!r}"]
    evidence(label, actual)
    return []


def check_not_in(label: str, actual, forbidden: list[str]) -> list[str]:
    if actual in forbidden:
        return [f"{label}: 实际 {actual!r} 命中禁用值（防污染）"]
    return []


def comma_env(name: str) -> list[str]:
    return [x.strip() for x in (os.environ.get(name) or "").split(",") if x.strip()]


def main() -> int:
    ap = argparse.ArgumentParser(description="S5-d 防污染绑定断言")
    ap.add_argument("--mode", choices=["preview", "production"], required=True)
    ap.add_argument("--script", required=True, help="线上 worker 名（kaas / kaas-preview-pr-<n>）")
    ap.add_argument("--slug", default="", help="preview 模式的 PR slug")
    ap.add_argument("--config", default="",
                    help="渲染产物 json 路径（preview 模式核 PR_SLUG var 用）")
    ap.add_argument("--pre-deploy", action="store_true",
                    help="只核渲染产物，不拉线上 settings（首次部署脚本尚不存在时用；"
                         "部署后必须再跑一次不带此 flag 的完整断言）")
    args = ap.parse_args()

    env = require_env(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])
    cf = CloudflareClient(env["CLOUDFLARE_API_TOKEN"], env["CLOUDFLARE_ACCOUNT_ID"])

    if args.pre_deploy:
        settings = {"bindings": [], "vars": {}}
        log("pre-deploy 模式：跳过线上 settings，只核渲染产物")
    else:
        step(f"拉取线上绑定: script={args.script}")
        settings = deployed_settings(cf, args.script)
    errors: list[str] = []

    r2s = {b.get("name"): b.get("bucket_name") for b in bindings_by_type(settings, "r2_bucket")}
    kvs = {b.get("name"): b.get("namespace_id") for b in bindings_by_type(settings, "kv_namespace")}
    hds = {b.get("name"): b.get("id") for b in bindings_by_type(settings, "hyperdrive")}
    if not args.pre_deploy:
        evidence("线上 R2 绑定", json.dumps(r2s, ensure_ascii=False))
        evidence("线上 KV 绑定", json.dumps(kvs, ensure_ascii=False))
        evidence("线上 Hyperdrive 绑定", json.dumps(hds, ensure_ascii=False))

    if args.mode == "preview":
        expect = require_env(["EXPECT_R2_BUCKET", "EXPECT_KV_ID", "EXPECT_HYPERDRIVE_ID"])
        slug = args.slug or os.environ.get("PR_SLUG", "")
        if not slug:
            raise PreviewError("preview 断言必须给 --slug 或 PR_SLUG")
        if not args.pre_deploy:
            errors += check_equal("R2 FILES.bucket", r2s.get("FILES"), expect["EXPECT_R2_BUCKET"])
            errors += check_equal("KV PREVIEW_KV.id", kvs.get("PREVIEW_KV"), expect["EXPECT_KV_ID"])
            errors += check_equal("HYPERDRIVE.id", hds.get("HYPERDRIVE"), expect["EXPECT_HYPERDRIVE_ID"])
            errors += check_not_in("R2 FILES.bucket", r2s.get("FILES"), comma_env("FORBIDDEN_R2_BUCKETS"))
            errors += check_not_in("HYPERDRIVE.id", hds.get("HYPERDRIVE"),
                                   comma_env("FORBIDDEN_HYPERDRIVE_IDS"))
            for name, ns in kvs.items():
                errors += check_not_in(f"KV {name}.id", ns, comma_env("FORBIDDEN_KV_IDS"))
            for route in settings.get("routes") or []:
                if "powervoy.com" in json.dumps(route):
                    errors.append(f"预览 worker 挂了生产域名（防污染）: {route}")
        # PR_SLUG var：查渲染产物（部署前拦截）
        if args.config:
            with open(args.config, encoding="utf-8") as fh:
                cfg = json.load(fh)
            var_slug = (cfg.get("vars") or {}).get("PR_SLUG", "")
            errors += check_equal("vars.PR_SLUG（渲染产物）", var_slug, slug)
            # 渲染产物里的绑定也一并核（渲染错误部署前就拦）
            rend_r2 = {b.get("binding"): b.get("bucket_name")
                       for b in cfg.get("r2_buckets", [])}
            rend_kv = {b.get("binding"): b.get("id") for b in cfg.get("kv_namespaces", [])}
            rend_hd = {b.get("binding"): b.get("id") for b in cfg.get("hyperdrive", [])}
            errors += check_equal("渲染 R2 FILES.bucket", rend_r2.get("FILES"),
                                  expect["EXPECT_R2_BUCKET"])
            errors += check_equal("渲染 KV PREVIEW_KV.id", rend_kv.get("PREVIEW_KV"),
                                  expect["EXPECT_KV_ID"])
            errors += check_equal("渲染 HYPERDRIVE.id", rend_hd.get("HYPERDRIVE"),
                                  expect["EXPECT_HYPERDRIVE_ID"])
        if not args.pre_deploy \
                and (settings.get("vars") or {}).get("PR_SLUG") not in (None, "", slug):
            errors.append(f"线上 vars.PR_SLUG 异常: {(settings.get('vars') or {}).get('PR_SLUG')!r}")
    else:
        expect = require_env(["EXPECT_PROD_R2_BUCKET", "EXPECT_PROD_HYPERDRIVE_ID"])
        errors += check_equal("R2 FILES.bucket", r2s.get("FILES"), expect["EXPECT_PROD_R2_BUCKET"])
        errors += check_equal("HYPERDRIVE.id", hds.get("HYPERDRIVE"),
                              expect["EXPECT_PROD_HYPERDRIVE_ID"])
        errors += check_not_in("R2 FILES.bucket", r2s.get("FILES"), comma_env("FORBIDDEN_R2_BUCKETS"))
        errors += check_not_in("HYPERDRIVE.id", hds.get("HYPERDRIVE"),
                               comma_env("FORBIDDEN_HYPERDRIVE_IDS"))
        for name, ns in kvs.items():
            errors += check_not_in(f"KV {name}.id", ns, comma_env("FORBIDDEN_KV_IDS"))
        # 预览 Hyperdrive 是每 PR 动态建的（kaas-preview-<num>），静态禁用列表盖不全；
        # 直接查 CF：生产绑定的 config 若名字命中预览命名前缀 ⇒ 污染。
        prefix = os.environ.get("PREVIEW_HYPERDRIVE_NAME_PREFIX", "kaas-preview-")
        prod_hd = hds.get("HYPERDRIVE")
        for cfg in cf.hyperdrive_list():
            if cfg.get("id") == prod_hd and str(cfg.get("name", "")).startswith(prefix):
                errors.append(
                    f"生产 HYPERDRIVE 绑到了预览 config {cfg.get('name')!r}（防污染）")
        if (settings.get("vars") or {}).get("PR_SLUG"):
            errors.append("生产 worker 被注入了 PR_SLUG（生产零影响被破坏）")

    if errors:
        for err in errors:
            log(f"❌ {err}")
        log("防污染断言失败 ⇒ 中止（检查 ensure 输出与 variables 配置）")
        return 1
    log(f"✅ 防污染断言通过（mode={args.mode}, script={args.script}）")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except PreviewError as exc:
        log(f"❌ {exc}")
        sys.exit(1)
