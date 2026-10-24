# -*- coding: utf-8 -*-
"""内核 DB/鉴权使用门禁（P3 收尾防回潮，2026-10-24）。

背景（docs/P3_PASSTHROUGH_DISPOSITION_2026-10-24.md §7）：
迁移完成后，内核不应再新增「自己连库」的端点 —— 已迁移的端点要么走门面直连、
要么走 /api/v1/internal/engine/* 纯算 RPC；只有**例外清单**里的端点可以继续用 DB。

本脚本用「基线快照 + 只减不增」的规则防止回潮：
1. **新增违规**：基线里没有的模块出现 _acquire / db.fetch* / db.execute ⇒ 红；
2. **数量回涨**：某模块的 DB 调用数**多于**基线 ⇒ 红（少于/等于都允许，鼓励继续删）；
3. **例外清单**：backend/worker/src/kernel_db_allowlist.txt 列出「允许长期使用 DB 的模块」及原因。

用法：
  python scripts/check-kernel-db-allowlist.py            # 门禁（CI 用）
  python scripts/check-kernel-db-allowlist.py --update   # 迁移后刷新基线（需 review diff）
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER_SRC = ROOT / "backend" / "worker" / "src"
BASELINE = ROOT / "scripts" / "kernel-db-baseline.json"
ALLOWLIST = WORKER_SRC / "kernel_db_allowlist.txt"

# 与 P2 §2 盘点用的同一组模式：只统计「端点自己连库/查库」的调用。
DB_PATTERNS = (
    re.compile(r"\b_acquire\s*\("),
    re.compile(r"\bdb\.(fetch|fetchrow|fetchval|execute)\s*\("),
)


def count_db_calls(text: str) -> int:
    n = 0
    for pat in DB_PATTERNS:
        n += len(pat.findall(text))
    return n


def collect() -> dict[str, int]:
    counts: dict[str, int] = {}
    for path in sorted(WORKER_SRC.rglob("*.py")):
        rel = path.relative_to(ROOT).as_posix()
        # 共享内核镜像由 scripts/sync-shared.ps1 生成，不是真源，跳过
        if "/kaas_common/" in rel:
            continue
        n = count_db_calls(path.read_text(encoding="utf-8", errors="replace"))
        if n:
            counts[rel] = n
    return counts


def read_allowlist() -> dict[str, str]:
    """返回 {模块相对路径: 原因}（# 后为原因；空行忽略）。"""
    if not ALLOWLIST.exists():
        return {}
    out: dict[str, str] = {}
    for raw in ALLOWLIST.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        path, _, reason = line.partition("#")
        out[path.strip()] = reason.strip()
    return out


def main() -> int:
    update = "--update" in sys.argv
    current = collect()

    if update:
        BASELINE.write_text(json.dumps(current, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"基线已更新：{len(current)} 个模块，共 {sum(current.values())} 处 DB 调用")
        return 0

    if not BASELINE.exists():
        print(f"FAIL: 缺基线文件 {BASELINE.relative_to(ROOT)}（先跑 --update 并 review）")
        return 1

    baseline: dict[str, int] = json.loads(BASELINE.read_text(encoding="utf-8"))
    allow = read_allowlist()
    problems: list[str] = []

    for path, n in sorted(current.items()):
        if path not in baseline:
            if path in allow:
                continue  # 例外清单内的新模块（需同时登记原因）
            problems.append(
                f"新增 DB 使用：{path}（{n} 处）—— 内核不应再新增连库端点；确需保留请登记 kernel_db_allowlist.txt 并说明原因")
            continue
        if n > baseline[path]:
            problems.append(f"DB 调用回涨：{path} 基线 {baseline[path]} → 现在 {n}（迁移方向应只减不增）")

    gone = [p for p in baseline if p not in current]
    total_now = sum(current.values())
    total_base = sum(baseline.values())
    print(f"内核 DB 调用：基线 {total_base}（{len(baseline)} 模块） → 现在 {total_now}（{len(current)} 模块）")
    if gone:
        print(f"已归零（可执行 --update 清理基线）：{', '.join(sorted(gone))}")

    if problems:
        print("\n".join("FAIL: " + p for p in problems))
        print(f"\n共 {len(problems)} 项违规。")
        return 1
    print("PASS: 内核 DB 使用未回潮（只在基线/例外清单范围内）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
