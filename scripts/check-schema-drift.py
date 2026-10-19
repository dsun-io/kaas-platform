#!/usr/bin/env python
"""生产 schema「列级」漂移门禁（方案 B S6 补充，2026-10-19）

为什么需要第二个门禁
--------------------
`check-schema-coverage.py` 只比**表集合**：worker 查的表 ∈ metadata。它发现不了：

- 生产表有、模型漏建的**列**（空库快径缺列 ⇒ 新环境该端点 500）；
- 唯一索引形状漂移（生产是 `COALESCE(team_id,0)` 函数索引，模型写成裸列 ⇒ 约束失效）。

2026-10-19 本地冒烟实测两个真实现场：
1. `tenant_workstation_products.team_id` 生产有（迁移 202610110019），模型漏建
   ⇒ `GET /api/v1/export-quote/products` 在全新空库直接 500；
2. `trade_docs.owner_id/owner_scope`、`market_ports.created_at/updated_at` 同样漏建。

做法
----
1. 快照：`scripts/prod-schema-columns.json`（生产 information_schema 的 表→列，只读导出；
   重生成命令见 `scripts/dump-prod-schema-columns.py`）。
2. 判据：
   - 快照里每张**非 allowlist** 表的每一列，都必须出现在 `Base.metadata` 对应表里；
   - 生产有、模型没有的**表**必须登记到 `scripts/schema-drift-allowlist.txt`（写清原因）；
   - 模型多出来、生产没有的表只打警告（空库多建空表不影响现网，可能是有意新增）。
3. 允许的差异全部要留痕（allowlist 一行 `表名 # 原因`），与 route-parity / schema-coverage 同一纪律。

用法：orchestrator venv 解释器
    python scripts/check-schema-drift.py
退出码：0 = 通过；1 = 有未登记的表/列漂移。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SNAPSHOT = REPO / "scripts" / "prod-schema-columns.json"
ALLOWLIST = REPO / "scripts" / "schema-drift-allowlist.txt"
ORCH = REPO / "backend" / "orchestrator"


def metadata_columns() -> dict[str, list[str]]:
    sys.path.insert(0, str(ORCH))
    sys.path.insert(0, str(REPO / "backend"))
    from app.db.base import Base  # noqa: PLC0415

    # 与 alembic/env.py、check-schema-coverage.py 保持同一份模型清单
    from app.db import (  # noqa: F401, PLC0415
        actual_cost,
        external_docs,
        legacy_models,
        market_models,
        models,
        tax_models,
        workstation_links,
        workstation_models,
    )

    return {name: [c.name for c in t.c] for name, t in Base.metadata.tables.items()}


def load_allowlist() -> dict[str, str]:
    allowed: dict[str, str] = {}
    if not ALLOWLIST.exists():
        return allowed
    for line in ALLOWLIST.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        table, _, reason = line.partition("#")
        allowed[table.strip()] = reason.strip() or "（未写原因）"
    return allowed


def main() -> int:
    if not SNAPSHOT.exists():
        print(f"FAIL: 缺生产列快照 {SNAPSHOT.relative_to(REPO)}；"
              f"用 scripts/dump-prod-schema-columns.py 生成")
        return 1
    prod = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    meta = metadata_columns()
    allowed = load_allowlist()

    prod_only = sorted(set(prod) - set(meta))
    unregistered_tables = [t for t in prod_only if t not in allowed]

    col_drift: list[tuple[str, list[str]]] = []
    for table in sorted(set(prod) & set(meta)):
        missing = [c for c in prod[table] if c not in meta[table]]
        if missing:
            col_drift.append((table, missing))

    meta_only = sorted(set(meta) - set(prod))
    stale = [t for t in allowed if t in meta]
    unused = [t for t in allowed if t not in prod]

    print(f"生产表 {len(prod)} / 模型表 {len(meta)}；"
          f"生产独有 {len(prod_only)}（已登记 {len(prod_only) - len(unregistered_tables)}）；"
          f"列漂移 {len(col_drift)} 张表")
    if stale:
        print(f"⚠️ allowlist 里的表已在模型中出现（可删登记）: {', '.join(sorted(stale))}")
    if unused:
        print(f"⚠️ allowlist 里生产也没有的表（可删登记）: {', '.join(sorted(unused))}")
    if meta_only:
        print(f"⚠️ 模型多出、生产没有的表（只警告）: {', '.join(meta_only)}")

    if unregistered_tables or col_drift:
        if unregistered_tables:
            print("FAIL: 生产有、空库快径不会创建的表（新环境必 500）:")
            for table in unregistered_tables:
                print(f"  - {table}")
        if col_drift:
            print("FAIL: 生产有、模型漏建的列（新环境必 500）:")
            for table, missing in col_drift:
                print(f"  - {table}: {', '.join(missing)}")
        print(f"\n历史遗留差异登记到 {ALLOWLIST.relative_to(REPO)}（表名 # 原因）。")
        return 1

    print("PASS: 模型覆盖生产全部表/列（或已登记为历史遗留）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
