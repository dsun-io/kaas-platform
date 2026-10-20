#!/usr/bin/env python3
"""S5 辅助：输出预览分支的**直连** DSN（只给 CI 迁移 job 用）。

为什么单独一个脚本（2026-10-20 实测定案）：
  GitHub Actions 会**静默丢弃**看起来像 secret 的 job output —— 实测日志：
    `##[warning]Skip output 'PREVIEW_DATABASE_URL' since it may contain secret.`
  ⇒ 通过 `needs.ensure.outputs.*` 传含密码的 DSN 时下游拿到空串，alembic 报
  "Could not parse SQLAlchemy URL from given URL string"。改为迁移 job **自己取**，
  用 `$(python3 ...)` 写进 `$GITHUB_ENV`（env 不做 secret 丢弃，日志里也不回显）。

stdout 只输出 DSN 一行；所有提示走 stderr（避免污染命令替换）。

用法:
  python3 scripts/preview/db-url.py --pr 424242
环境变量: NEON_API_KEY / NEON_PROJECT_ID
"""
from __future__ import annotations

import argparse
import os
import sys
import urllib.parse

_HERE = __file__.rsplit("\\", 1)[0] if "\\" in __file__ else __file__.rsplit("/", 1)[0]
sys.path.insert(0, _HERE)

from preview_lib import (  # noqa: E402
    CloudflareClient, NeonClient, PreviewError, parse_postgres_uri, parse_pr_slug,
    require_env, resolve_preview_database,
)


def err(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="输出预览分支的直连 DSN（stdout 仅 DSN）")
    ap.add_argument("--pr", required=True, help="PR 号（= slug，纯数字）")
    args = ap.parse_args()

    # preview_lib 的 evidence()/log() 都写 stdout；本脚本的 stdout 必须是**纯 DSN**
    # （调用方用 $(...) 捕获）。故把整个进程的 stdout 临时重定向到 stderr，
    # 只在最后把 DSN 写给真实 stdout。
    real_stdout = sys.stdout
    sys.stdout = sys.stderr

    slug = parse_pr_slug(args.pr)
    env = require_env(["NEON_API_KEY", "NEON_PROJECT_ID"])
    neon = NeonClient(env["NEON_API_KEY"], env["NEON_PROJECT_ID"])

    branch_name = f"preview-pr-{slug}"
    branch = neon.find_branch(branch_name)
    if not branch:
        raise PreviewError(f"分支 {branch_name} 不存在 —— 请先跑 ensure.py --pr {slug}")
    branch_id = branch["id"]
    err(f"[db-url] 分支 {branch_name} (id={branch_id})")

    roles = neon.list_roles(branch_id)
    if not roles:
        raise PreviewError(f"分支 {branch_id} 没有可用 role")
    role = next((r for r in roles if "owner" in (r.get("name") or "")), roles[0])

    databases = neon.list_databases(branch_id)
    if not databases:
        raise PreviewError(f"分支 {branch_id} 没有可用 database")
    # 与 ensure.py 同口径：跟生产 worker 同库（分支里有多个库，取 [0] 会连空库）
    cf = None
    if os.environ.get("CLOUDFLARE_API_TOKEN") and os.environ.get("CLOUDFLARE_ACCOUNT_ID"):
        cf = CloudflareClient(os.environ["CLOUDFLARE_API_TOKEN"],
                              os.environ["CLOUDFLARE_ACCOUNT_ID"])
    db_name = resolve_preview_database(cf, databases)
    database = next(d for d in databases if d.get("name") == db_name)

    uri = neon.connection_uri(branch_id, role["name"], database["name"], pooled=False)
    parsed = parse_postgres_uri(uri)

    # Neon 的 connection_uri 现一律回 pooler 主机（pooled=False 被忽略，实测）；
    # alembic 走 DDL ⇒ 用 endpoint 的直连主机拼直连串（与 ensure.py 同口径）。
    endpoints = neon.list_endpoints(branch_id)
    direct_host = next((e.get("host") for e in endpoints
                        if e.get("type") == "read_write" and e.get("host")), "")
    if direct_host:
        dsn = (f"postgresql://{urllib.parse.quote(parsed['user'])}:"
               f"{urllib.parse.quote(parsed['password'])}@{direct_host}"
               f"/{parsed['database']}?sslmode=require")
        err(f"[db-url] 直连主机 {direct_host}（Hyperdrive 仍走 pooler）")
    else:
        dsn = uri
        err("[db-url] ⚠ 拿不到直连主机，退回 Neon 返回的串")

    real_stdout.write(dsn + "\n")
    real_stdout.flush()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except PreviewError as exc:
        err(f"[db-url] ❌ {exc}")
        sys.exit(1)
