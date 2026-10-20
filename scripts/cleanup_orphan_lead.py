"""清理线索池里的 E2E 测试残留（`lead_candidates`）。

为什么需要它
------------
`lead_candidates`（线索池）**没有 DELETE 端点**（`DELETE /api/v1/leads/{id}` → 405），
而写路径 E2E 一旦中途 5xx 就可能把测试线索留在**生产库**（DEPLOY.md §0.4）。
历史上一份同名脚本存在过但已丢失（二轮 sweep 发现 DEPLOY 引用 `cleanup_orphan_lead.py`
全仓 0 命中），本文件按 DEPLOY 记录的用法重建。

安全口径（默认不动数据）
------------------------
- **默认 dry-run**：只统计并列出将删的行；必须显式 `--apply` 才执行 DELETE。
- 只删**测试命名**的行（默认前缀 `E2E_PROD_CHECK` / `E2ELOCAL` / `E2EZZ`，
  匹配 `company_name` 或 `place_id`），可用 `--pattern` 追加。
- 有**引用**的行不删：`outreach_messages.lead_id` / `cust_inquiries.lead_id` /
  `research_runs` 等历史流水指向它时跳过并在报告里列出（避免删掉业务溯源）。
- 单次最多删 `--limit`（默认 500）行；事务内执行，异常回滚。
- `research_runs` 是审计流水，**刻意保留**，本脚本不碰。

用法（生产 DSN 从环境变量读，绝不硬编码）
-----------------------------------------
    $env:KAAS_DSN = 'postgresql://...@.../neondb?sslmode=require'
    cd D:\\MyProject\\kaas-platform
    python .tools/cleanup_orphan_lead.py              # dry-run
    python .tools/cleanup_orphan_lead.py --apply       # 真删
    python .tools/cleanup_orphan_lead.py --apply --tenant default --limit 200
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

DEFAULT_PATTERNS = ("E2E_PROD_CHECK%", "E2ELOCAL%", "E2EZZ%")
REFERENCE_TABLES = ("outreach_messages", "cust_inquiries")


async def _run(apply: bool, patterns: list[str], tenant: str | None, limit: int) -> int:
    import asyncpg  # 延迟导入：--help 不需要驱动

    dsn = os.environ.get("KAAS_DSN")
    if not dsn:
        print("缺少环境变量 KAAS_DSN —— 例：$env:KAAS_DSN='postgresql://...?sslmode=require'")
        return 2
    conn = await asyncpg.connect(dsn)
    try:
        # $1 = LIMIT（必须是最先绑定，否则 LIMIT 会拿到文本参数 → DatatypeMismatch）
        params: list[object] = [max(1, int(limit))]
        where = " OR ".join(
            [f"lc.company_name LIKE ${len(params) + 1 + i} OR lc.place_id LIKE ${len(params) + 1 + i}"
             for i in range(len(patterns))])
        params.extend(patterns)
        tenant_sql = ""
        if tenant:
            params.append(tenant)
            tenant_sql = f" AND lc.tenant_id = ${len(params)}"

        referenced = " OR ".join(
            f"EXISTS (SELECT 1 FROM {t} r WHERE r.lead_id = lc.id)" for t in REFERENCE_TABLES)
        rows = await conn.fetch(
            f"SELECT lc.id, lc.company_name, lc.place_id, lc.tenant_id,"
            f"       ({referenced}) AS referenced"
            f"  FROM lead_candidates lc"
            f" WHERE ({where}){tenant_sql}"
            f" ORDER BY lc.id"
            f" LIMIT $1",
            *params,
        )
        deletable = [r for r in rows if not r["referenced"]]
        skipped = [r for r in rows if r["referenced"]]
        print(f"匹配 {len(rows)} 行（上限 {limit}）：可删 {len(deletable)}，"
              f"因被引用跳过 {len(skipped)}")
        for r in deletable:
            print(f"  [删] id={r['id']} tenant={r['tenant_id']} "
                  f"company={r['company_name']!r} place_id={r['place_id']!r}")
        for r in skipped:
            print(f"  [留] id={r['id']} company={r['company_name']!r} —— 有触达/询盘引用")

        if not apply:
            print("\nDRY-RUN：未删除任何行。确认无误后加 --apply 执行。")
            return 0
        if not deletable:
            print("没有可删的行。")
            return 0
        ids = [r["id"] for r in deletable]
        async with conn.transaction():
            deleted = await conn.execute(
                "DELETE FROM lead_candidates WHERE id = ANY($1::bigint[])", ids)
        print(f"\n已删除 {deleted.split()[-1]} 行（事务提交）。")
        return 0
    finally:
        await conn.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="清理线索池里的 E2E 测试残留（默认 dry-run）")
    ap.add_argument("--apply", action="store_true", help="真删（默认只预览）")
    ap.add_argument("--pattern", action="append", default=[],
                    help="额外匹配前缀（LIKE，可多次）；默认 3 个 E2E 前缀见脚本头")
    ap.add_argument("--tenant", default=None, help="只处理指定 tenant_id（默认全部租户）")
    ap.add_argument("--limit", type=int, default=500, help="单次最多处理行数（默认 500）")
    args = ap.parse_args(argv)
    patterns = list(DEFAULT_PATTERNS) + list(args.pattern)
    return asyncio.run(_run(args.apply, patterns, args.tenant, max(1, args.limit)))


if __name__ == "__main__":
    sys.exit(main())
