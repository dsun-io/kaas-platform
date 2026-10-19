#!/usr/bin/env python
"""运行时依赖断言（方案 B 阶段二 S1 / 阶段三静态门禁之一）

判据（README §3.1、PLAN_B §5 #9）：
生产 Worker 运行时不得依赖 sqlalchemy / alembic / greenlet / psycopg2，
否则要么打不进 Worker 包，要么冷启动超线（POC 实测 +1854ms）。

检查对象：
1. `backend/kaas_common/**/*.py` —— 共享内核（会被镜像进 Worker）；
2. `backend/worker/src/**/*.py`（跳过镜像目录 `kaas_common/`）—— Worker 运行时；
3. `backend/worker/pyproject.toml` 的运行时依赖清单。

用法：`python scripts/check-runtime-deps.py`（本机用 orchestrator venv 解释器）
退出码：0 = PASS；1 = 有违规（打印文件:行号与模块名）。
"""
from __future__ import annotations

import ast
import sys
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FORBIDDEN = {"sqlalchemy", "alembic", "greenlet", "psycopg2", "psycopg"}

TARGET_DIRS = [
    REPO / "backend" / "kaas_common",
    REPO / "backend" / "worker" / "src",
]
# 镜像目录由 sync-shared.ps1 生成，内容与源一致，跳过避免重复报告
SKIP_DIR_NAMES = {"kaas_common", "__pycache__"}


def _imported_roots(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                roots.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level:  # 相对 import，不是第三方依赖
                continue
            if node.module:
                roots.add(node.module.split(".")[0])
    return roots


def scan_python() -> list[str]:
    violations: list[str] = []
    for base in TARGET_DIRS:
        if not base.exists():
            continue
        for path in sorted(base.rglob("*.py")):
            rel_parts = path.relative_to(base).parts
            if any(part in SKIP_DIR_NAMES for part in rel_parts[:-1]):
                continue
            for root in sorted(_imported_roots(path) & FORBIDDEN):
                violations.append(f"{path.relative_to(REPO)}: import {root}")
    return violations


def scan_worker_deps() -> list[str]:
    pyproject = REPO / "backend" / "worker" / "pyproject.toml"
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    deps = data.get("project", {}).get("dependencies", [])
    violations = []
    for dep in deps:
        name = dep.split(">")[0].split("<")[0].split("=")[0].split("[")[0].strip().lower()
        if name in FORBIDDEN:
            violations.append(f"backend/worker/pyproject.toml: dependency {name}")
    return violations


def main() -> int:
    violations = scan_python() + scan_worker_deps()
    if violations:
        print("FAIL: 运行时依赖断言不通过（禁止 sqlalchemy/alembic/greenlet/psycopg2）:")
        for item in violations:
            print(f"  - {item}")
        return 1
    files = sum(len(list(d.rglob("*.py"))) for d in TARGET_DIRS if d.exists())
    print(f"PASS: 运行时依赖干净（扫描 {files} 个 Python 文件 + worker pyproject）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
