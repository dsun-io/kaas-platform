#!/usr/bin/env python3
"""S5-b/S5-c ensure：为某个 PR 建预览资源（幂等）。

链路：PR open/synchronize → 本脚本 →
  1. Neon：``preview-pr-<num>`` 分支（不存在则从**根分支**派生；已存在则复用）
  2. Neon：取该分支直连连接串（给 CI 跑 alembic upgrade head 用）
  3. CF Hyperdrive：``kaas-preview-<num>`` config（不存在则创建并指向该分支；已存在则复用）

输出（打印 + GITHUB_OUTPUT）：
  PR_SLUG / NEON_BRANCH_NAME / NEON_BRANCH_ID / PREVIEW_DATABASE_URL / HYPERDRIVE_ID / PREVIEW_URL

用法（CI）：
  python3 scripts/preview/ensure.py --pr ${{ github.event.pull_request.number }}
环境变量（CI 由 secrets/variables 注入）：
  NEON_API_KEY  NEON_PROJECT_ID  CLOUDFLARE_API_TOKEN  CLOUDFLARE_ACCOUNT_ID

本机 dry-run（不发任何写请求）：
  $env:NEON_API_KEY="..."; ...; python scripts/preview/ensure.py --pr 123 --dry-run
"""
from __future__ import annotations

import argparse
import sys
import urllib.parse

sys.path.insert(0, __file__.rsplit("\\", 1)[0] if "\\" in __file__
                else __file__.rsplit("/", 1)[0])

from preview_lib import (  # noqa: E402
    CloudflareClient, NeonClient, PreviewError, Runner, evidence, github_output,
    log, parse_postgres_uri, parse_pr_slug, require_env, resolve_preview_database, step,
)


def main() -> int:
    ap = argparse.ArgumentParser(description="S5 ensure: 为 PR 建 Neon 分支 + Hyperdrive config")
    ap.add_argument("--pr", required=True, help="PR 号（= slug，纯数字）")
    ap.add_argument("--dry-run", action="store_true", help="只打印将执行的动作，不发写请求")
    args = ap.parse_args()

    slug = parse_pr_slug(args.pr)
    branch_name = f"preview-pr-{slug}"
    hyper_name = f"kaas-preview-{slug}"
    worker_name = f"kaas-preview-pr-{slug}"
    runner = Runner(args.dry_run)

    env = require_env(["NEON_API_KEY", "NEON_PROJECT_ID",
                       "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])
    neon = NeonClient(env["NEON_API_KEY"], env["NEON_PROJECT_ID"])
    cf = CloudflareClient(env["CLOUDFLARE_API_TOKEN"], env["CLOUDFLARE_ACCOUNT_ID"])

    step(f"1) Neon 项目与根分支（project={env['NEON_PROJECT_ID']}）")
    project = neon.get_project()
    evidence("项目名", project.get("name"))
    branches = neon.list_branches()
    roots = [b for b in branches if not b.get("parent_id")]
    if not roots:
        raise PreviewError(" Neon 项目里没有根分支（parent_id 为空），无法派生预览分支")
    root = roots[0]
    evidence("根分支（派生源，严禁改动它）", f"{root.get('name')} (id={root.get('id')})")

    step(f"2) Neon 分支 {branch_name}")
    branch = neon.find_branch(branch_name)
    if branch:
        evidence("复用已存在分支", f"{branch.get('name')} (id={branch.get('id')})")
    else:
        branch = runner.write(
            f"Neon create branch {branch_name} parent={root['id']}",
            lambda: neon.create_branch(branch_name, root["id"]),
        )
        if branch:
            evidence("新建分支", f"{branch.get('name')} (id={branch.get('id')})")
    branch_id = (branch or {}).get("id")
    if not branch_id:
        log("dry-run：跳过连接串获取（分支尚未真实创建）")
        github_output({"PR_SLUG": slug, "NEON_BRANCH_NAME": branch_name,
                       "NEON_BRANCH_ID": "<dry-run>", "PREVIEW_DATABASE_URL": "<dry-run>",
                       "HYPERDRIVE_ID": "<dry-run>"})
        return 0

    step("3) Neon 读写 endpoint（无则补建；刚建的分支要十几秒就绪）")
    endpoints = neon.list_endpoints(branch_id)
    rw = [e for e in endpoints if e.get("type") == "read_write"]
    if rw:
        evidence("复用已存在 endpoint",
                 f"{rw[0].get('id')} ({rw[0].get('current_state')})")
    else:
        created = runner.write(
            f"Neon create read_write endpoint for {branch_id}",
            lambda: neon.create_endpoint(branch_id))
        if created:
            evidence("新建 endpoint", created.get("id"))
    if not args.dry_run:
        active = neon.wait_endpoint_active(branch_id)
        evidence("endpoint 就绪",
                 f"{active.get('id')} state={active.get('current_state')}")

    step("4) Neon 连接串（直连，给 alembic 迁移用；不落盘、不打印）")
    roles = neon.list_roles(branch_id)
    if not roles:
        raise PreviewError(f"分支 {branch_id} 没有可用 role")
    role = next((r for r in roles if "owner" in (r.get("name") or "")),
                roles[0])
    databases = neon.list_databases(branch_id)
    if not databases:
        raise PreviewError(f"分支 {branch_id} 没有可用 database")
    # 2026-10-20 实测定案：分支里有多个库（kaas_v2_test / neondb），**必须跟生产 worker 同库**
    # （生产 Hyperdrive origin.database = neondb），取 databases[0] 会连到空库 ⇒ 预览数据不是生产快照。
    db_name = resolve_preview_database(cf, databases)
    database = next(d for d in databases if d.get("name") == db_name)
    evidence("role / database", f"{role.get('name')} / {database.get('name')}")
    uri = neon.connection_uri(branch_id, role["name"], database["name"], pooled=False)
    parsed = parse_postgres_uri(uri)
    # Neon 的 connection_uri 现在一律回 pooler 主机（pooler=false 被忽略，实测）。
    # alembic 走 DDL，绕开 pgbouncer：用 endpoint 的直连主机拼直连串。
    endpoints = neon.list_endpoints(branch_id)
    direct_host = next((e.get("host") for e in endpoints
                        if e.get("type") == "read_write" and e.get("host")), "")
    if direct_host:
        direct_uri = (f"postgresql://{urllib.parse.quote(parsed['user'])}:"
                      f"{urllib.parse.quote(parsed['password'])}@{direct_host}"
                      f"/{parsed['database']}?sslmode=require")
        evidence("直连主机（给迁移用）", f"{direct_host} （Hyperdrive 仍走 pooler）")
    else:
        direct_uri = uri
        log("⚠ 拿不到直连主机，PREVIEW_DATABASE_URL 退回 Neon 返回的串")
    parsed_direct = parse_postgres_uri(direct_uri)
    evidence("连接目标（不回显密码）",
             f"{parsed['user']}@<REDACTED_SECRET> {parsed_direct['database']}")

    step(f"5) Hyperdrive config {hyper_name}")
    cfg = cf.hyperdrive_find(hyper_name)
    if cfg:
        origin = (cfg.get("origin") or {})
        host_mismatch = bool(origin.get("host")) and origin["host"] != parsed["host"]
        db_mismatch = bool(origin.get("database")) and origin["database"] != parsed["database"]
        if host_mismatch or db_mismatch:
            log(f"⚠ 已有 config 指向 {origin.get('host')}/{origin.get('database')}，与当前分支"
                f" {parsed['host']}/{parsed['database']} 不一致 —— 删旧 config 并按新目标重建")
            runner.write(f"Hyperdrive delete {cfg['id']}（指向过期目标）",
                         lambda: cf.hyperdrive_delete(cfg["id"]))
            cfg = None
    if not cfg:
        cfg = runner.write(
            f"Hyperdrive create {hyper_name} → {parsed['host']}:{parsed['port']}/{parsed['database']}",
            lambda: cf.hyperdrive_create(
                hyper_name, host=parsed["host"], port=parsed["port"],
                user=parsed["user"], password=parsed["password"],
                database=parsed["database"]),
        )
        if cfg:
            evidence("新建 config", f"{cfg.get('name')} (id={cfg.get('id')})")
    hyper_id = (cfg or {}).get("id", "<dry-run>")

    step("6) 预览 URL 与输出")
    subdomain = cf.workers_subdomain()
    preview_url = f"https://{worker_name}.{subdomain}.workers.dev" if subdomain else ""
    if preview_url:
        evidence("预览 URL", preview_url)
    else:
        log("⚠ 拿不到 workers.dev 子域，PREVIEW_URL 留空（不影响部署，URL 可从 dashboard 查）")

    github_output({
        "PR_SLUG": slug,
        "NEON_BRANCH_NAME": branch_name,
        "NEON_BRANCH_ID": branch_id,
        "PREVIEW_DATABASE_URL": direct_uri,
        "HYPERDRIVE_ID": hyper_id,
        "PREVIEW_URL": preview_url,
    })
    log("✅ ensure 完成（幂等：重跑会复用以上资源）")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except PreviewError as exc:
        log(f"❌ {exc}")
        sys.exit(1)
