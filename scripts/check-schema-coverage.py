#!/usr/bin/env python
"""Schema 完备性门禁（方案 B 阶段二 S2）

判据（README §8 已知问题 #1）：
空库快径 = `Base.metadata.create_all()` + stamp head。worker 的全部 SQL 查询
涉及的表必须都在这个 metadata 里，否则新环境（预览/全新生产）必然 500。

做法（静态，不连数据库）：
1. 从 `backend/worker/src/*.py` 提取 SQL 里出现的表名（大写 SQL 关键字后的标识符）；
2. 从 `backend/orchestrator/app/db` 的 SQLAlchemy models 取 `Base.metadata.tables`；
3. 差集 = 缺失表。已登记的历史遗留表放 `scripts/schema-coverage-allowlist.txt`
   （每行 `表名 # 原因`），登记理由必须写清（与 route-parity 同一纪律）。

用法：orchestrator venv 解释器执行
`python scripts/check-schema-coverage.py`
退出码：0 = 通过；1 = 有未登记缺失表。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WORKER_SRC = REPO / "backend" / "worker" / "src"
ORCH = REPO / "backend" / "orchestrator"
ALLOWLIST = REPO / "scripts" / "schema-coverage-allowlist.txt"

# 只认大写 SQL 关键字，避免把 Python 的 `from x import y` 当表名
SQL_TABLE_RE = re.compile(
    r"\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)",
)
# SQL 里 FROM 后面可能跟子查询/关键字，不是表名
NON_TABLE = {
    "select", "unnest", "generate_series", "lateral", "values", "jsonb_array_elements",
    "jsonb_array_elements_text", "json_array_elements", "jsonb_each", "jsonb_each_text",
    "json_each", "json_each_text",
    "regexp_split_to_table", "string_to_array", "only",
}


def worker_table_refs() -> dict[str, set[str]]:
    refs: dict[str, set[str]] = {}
    for path in sorted(WORKER_SRC.glob("*.py")):
        text = path.read_text(encoding="utf-8")
        for match in SQL_TABLE_RE.finditer(text):
            table = match.group(1)
            if not table.islower() or table in NON_TABLE:
                continue
            refs.setdefault(table, set()).add(path.name)
    return refs


def metadata_tables() -> set[str]:
    sys.path.insert(0, str(ORCH))
    sys.path.insert(0, str(REPO / "backend"))
    from app.db.base import Base  # noqa: PLC0415

    # 与 alembic/env.py 保持同一份模型清单（漏 import = 空库缺表）
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

    return set(Base.metadata.tables)


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
    if not WORKER_SRC.exists() or not ORCH.exists():
        print("FAIL: 找不到 worker/src 或 orchestrator 目录（确认在仓库根执行）")
        return 1
    refs = worker_table_refs()
    tables = metadata_tables()
    allowed = load_allowlist()

    missing = {t: files for t, files in refs.items() if t not in tables}
    unregistered = {t: files for t, files in missing.items() if t not in allowed}
    stale = [t for t in allowed if t in tables]
    unused = [t for t in allowed if t not in refs]

    print(f"worker SQL 引用表 {len(refs)} 个；metadata 表 {len(tables)} 个；"
          f"缺失 {len(missing)}（已登记 {len(missing) - len(unregistered)} / 未登记 {len(unregistered)}）")
    if stale:
        print(f"⚠️ allowlist 里已存在的表（可删登记）: {', '.join(sorted(stale))}")
    if unused:
        print(f"⚠️ allowlist 里 worker 未引用的表: {', '.join(sorted(unused))}")
    if unregistered:
        print("FAIL: 以下表被 worker 查询但空库快径不会创建（新环境必 500）:")
        for table in sorted(unregistered):
            print(f"  - {table}  <- {', '.join(sorted(unregistered[table]))}")
        print(f"\n如为历史遗留表，登记到 {ALLOWLIST.relative_to(REPO)} 并写清原因。")
        return 1
    print("PASS: worker 查询涉及的表全部可由空库快径创建（或已登记为遗留表）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
