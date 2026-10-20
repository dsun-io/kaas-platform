#!/usr/bin/env python3
"""S5-b/S5-c teardown：PR 关闭时回收该 PR 的预览资源（幂等）。

回收顺序（先摘引用再删数据）：
  1. Hyperdrive config ``kaas-preview-<num>``（CF API，404=已删）
  2. Neon 分支 ``preview-pr-<num>``（404=已删）
  3. 预览 KV：删 ``KAAS_PREVIEW`` namespace 里 ``pr-<num>:`` 前缀的全部键（CF API 分页拉全）
  4. 预览 R2：删 ``kaas-preview-storage`` 里 ``pr-<num>/`` 前缀对象（复用 kaas_common 的
     SigV4 签名直连 S3 兼容 API；**仅在 S3_ACCESS_KEY/S3_SECRET_KEY 可用时执行**，否则
     打印跳过原因与手动清理命令 —— R2 没有"按前缀删"的 REST 端点，诚实降级不假装删了）

⚠️ 红线：只动名字严格等于上面两个的预览资源；生产分支 / kaas-prod-hyperdrive / kaas-files
    一律不碰（名字不匹配自然到不了它们，代码里也不提供任何生产名）。

用法：
  python3 scripts/preview/teardown.py --pr 123 [--dry-run] [--skip-storage]
环境变量：NEON_API_KEY NEON_PROJECT_ID CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
          KAAS_PREVIEW_KV_NAMESPACE_ID（KV 清理必需）
          S3_ACCESS_KEY / S3_SECRET_KEY / S3_ENDPOINT / S3_BUCKET（R2 清理可选）
"""
from __future__ import annotations

import argparse
import os
import sys

_HERE = __file__.rsplit("\\", 1)[0] if "\\" in __file__ else __file__.rsplit("/", 1)[0]
sys.path.insert(0, _HERE)
_REPO_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))

from preview_lib import (  # noqa: E402
    CloudflareClient, NeonClient, PreviewError, Runner, evidence, http_download,
    log, parse_pr_slug, require_env, step,
)


def clean_kv(cf: CloudflareClient, ns_id: str, prefix: str, runner: Runner) -> None:
    step(f"3) 预览 KV 清理（namespace={ns_id[:8]}…, 前缀 {prefix!r}）")
    keys = cf.kv_list_keys(ns_id, prefix)
    evidence("匹配到的键数量", len(keys))
    for item in keys:
        name = item.get("name", "")
        runner.write(f"KV delete {prefix}…{name[len(prefix):]}",
                     lambda n=name: cf.kv_delete_key(ns_id, n))
    if not keys:
        evidence("KV 清理", "无匹配键，无需删除（幂等）")


def clean_r2(slug: str, prefix: str, runner: Runner) -> None:
    step(f"4) 预览 R2 清理（桶 kaas-preview-storage, 前缀 {prefix!r}）")
    access = os.environ.get("S3_ACCESS_KEY")
    secret = os.environ.get("S3_SECRET_KEY")
    endpoint = (os.environ.get("S3_ENDPOINT") or "").rstrip("/")
    bucket = os.environ.get("S3_BUCKET") or "kaas-preview-storage"
    if not (access and secret and endpoint):
        log("⚠ 缺 S3_ACCESS_KEY/S3_SECRET_KEY/S3_ENDPOINT —— 跳过 R2 对象清理（诚实降级）。")
        log("  手动清理：dashboard → R2 → kaas-preview-storage 按前缀 pr-<num>/ 筛选删除；")
        log("  或在 CI secrets 配好上述三个变量后重跑本脚本。")
        return
    sys.path.insert(0, os.path.join(_REPO_ROOT, "backend"))
    from kaas_common.files.s3 import presign_bucket_url, presign_url  # noqa: E402

    # ListObjectsV2（按前缀），分页拉全；再逐对象 DELETE（逐条删除日志更可审计，
    # 预览残留量小，不值得上 DeleteObjects 批量）。
    import xml.etree.ElementTree as ET

    def _list(prefix: str, token: str = ""):
        extra = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
        if token:
            extra["continuation-token"] = token
        url = presign_bucket_url("GET", endpoint, bucket,
                                 access_key=access, secret_key=secret,
                                 region="auto", extra_query=extra)
        return http_download("GET", url)

    token = ""
    total = 0
    while True:
        status, body = _list(prefix, token)
        if status != 200:
            raise PreviewError(f"R2 ListObjectsV2 → HTTP {status}: {body[:300]!r}")
        ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
        root = ET.fromstring(body)
        keys = [k.text or "" for k in root.findall("s3:Contents/s3:Key", ns)]
        for key in keys:
            runner.write(
                f"R2 delete {key}",
                lambda k=key: http_download("DELETE", presign_url(
                    "DELETE", endpoint, bucket, k,
                    access_key=access, secret_key=secret, region="auto")),
            )
            total += 1
        truncated = root.find("s3:IsTruncated", ns)
        token_el = root.find("s3:NextContinuationToken", ns)
        if truncated is None or truncated.text != "true" or token_el is None:
            break
        token = token_el.text or ""
    evidence("匹配到的 R2 对象数量", total)


def main() -> int:
    ap = argparse.ArgumentParser(description="S5 teardown: 回收 PR 预览资源")
    ap.add_argument("--pr", required=True, help="PR 号（= slug，纯数字）")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--skip-storage", action="store_true", help="跳过 KV/R2 前缀清理")
    args = ap.parse_args()

    slug = parse_pr_slug(args.pr)
    branch_name = f"preview-pr-{slug}"
    hyper_name = f"kaas-preview-{slug}"
    worker_name = f"kaas-preview-pr-{slug}"
    kv_prefix = f"pr-{slug}:"
    r2_prefix = f"pr-{slug}/"
    runner = Runner(args.dry_run)

    env = require_env(["NEON_API_KEY", "NEON_PROJECT_ID",
                       "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])
    neon = NeonClient(env["NEON_API_KEY"], env["NEON_PROJECT_ID"])
    cf = CloudflareClient(env["CLOUDFLARE_API_TOKEN"], env["CLOUDFLARE_ACCOUNT_ID"])

    step(f"0) 预览 worker {worker_name}")
    deleted = runner.write(f"CF delete worker {worker_name}",
                           lambda: cf.delete_worker(worker_name))
    if deleted is False:
        evidence("worker", "不存在，无需删除（幂等）")
    elif deleted:
        evidence("worker 已删除", worker_name)

    step(f"1) Hyperdrive config {hyper_name}")
    cfg = cf.hyperdrive_find(hyper_name)
    if cfg:
        runner.write(f"Hyperdrive delete {cfg['id']}",
                     lambda: cf.hyperdrive_delete(cfg["id"]))
    else:
        evidence("Hyperdrive", "不存在，无需删除（幂等）")

    step(f"2) Neon 分支 {branch_name}")
    branch = neon.find_branch(branch_name)
    if branch:
        runner.write(f"Neon delete branch {branch['id']}",
                     lambda: neon.delete_branch(branch["id"]))
    else:
        evidence("Neon 分支", "不存在，无需删除（幂等）")

    if not args.skip_storage:
        ns_id = os.environ.get("KAAS_PREVIEW_KV_NAMESPACE_ID", "")
        if ns_id:
            clean_kv(cf, ns_id, kv_prefix, runner)
        else:
            log("⚠ 未配 KAAS_PREVIEW_KV_NAMESPACE_ID，跳过 KV 清理")
        clean_r2(slug, r2_prefix, runner)

    log("✅ teardown 完成")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except PreviewError as exc:
        log(f"❌ {exc}")
        sys.exit(1)
