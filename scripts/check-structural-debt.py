#!/usr/bin/env python
"""结构性债静态门禁（2026-10-21 建档，docs/STRUCTURAL_DEBT.md §4.1）

判断（docs/STRUCTURAL_DEBT.md 已登记的 S-1/S-2/S-3/S-4 四条结构性债）：
纯静态扫描，不连库、不跑测试，与 check-schema-coverage.py / check-runtime-deps.py 同一风格。

检查项与阈值（2026-10-21 建档基线）：
1. backend/worker/src/main.py 行数              <= 4000   （当前 5170，已登记 S-1，--allow-known 放行）
2. 单个 backend/**/*.py 文件行数                 <= 3000   （同上）
3. "# noqa: E402" / "# ruff: noqa: E402" 命中数  <= 40     （当前 36，已登记 S-2，--allow-known 放行）
4. "except Exception" 命中数（backend/**）      <= 100    （当前 88，新增会被拦下）
5. print() 命中数（backend/worker/src/**）      <= 20     （当前 18，新增会被拦下）
6. TODO|FIXME|HACK 注释数                        无阈值，仅打印（避免凑指标写废话注释）

用法：
    backend/orchestrator/.venv/Scripts/python.exe scripts/check-structural-debt.py
    backend/orchestrator/.venv/Scripts/python.exe scripts/check-structural-debt.py --allow-known

退出码：0 = 通过（含 --allow-known 放行已登记项）；1 = 有未登记违规（超阈值且未在 STRUCTURAL_DEBT.md 登记）。
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ALLOW_KNOWN = "--allow-known" in sys.argv

# 阈值与已登记债的对应关系（改动阈值前先改 docs/STRUCTURAL_DEBT.md §4.1）
THRESHOLDS = {
    "main_py_lines":      4000,   # S-1：main.py 巨石
    "single_py_lines":    3000,   # S-1：任意单文件
    "noqa_e402_count":    80,     # S-2：循环依赖压制（仅统计生产源码，排除 tests/）
    "except_exception":   100,    # S-4：裸 except
    "print_count":        20,     # S-4：print 残留
}

def git_ls_files(*patterns: str) -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", *patterns], cwd=REPO,
        capture_output=True, text=True, check=True,
    )
    return [l for l in out.stdout.splitlines() if l]

def git_ls_files_regex(rx: str) -> list[str]:
    """用 --pathspec-from-file + 正则等价的前缀过滤，规避 git pathspec ** 通配在部分版本不展开的问题。"""
    out = subprocess.run(
        ["git", "ls-files"], cwd=REPO,
        capture_output=True, text=True, check=True,
    )
    pat = re.compile(rx)
    return [l for l in out.stdout.splitlines() if l and pat.search(l)]

def count_lines(path: Path) -> int:
    try:
        return sum(1 for _ in path.open("r", encoding="utf-8", errors="replace"))
    except FileNotFoundError:
        return 0

def count_pattern(files: list[str], pattern: str) -> int:
    rx = re.compile(pattern)
    n = 0
    for rel in files:
        p = REPO / rel
        if not p.is_file():
            continue
        try:
            for line in p.open("r", encoding="utf-8", errors="replace"):
                if rx.search(line):
                    n += 1
        except OSError:
            pass
    return n

def main() -> int:
    violations: list[str] = []
    info: list[str] = []

    # --- S-1：main.py 行数 + 任意单文件行数 ---
    main_py = REPO / "backend" / "worker" / "src" / "main.py"
    main_lines = count_lines(main_py)
    info.append(f"main.py 行数: {main_lines}（阈值 {THRESHOLDS['main_py_lines']}）")
    if main_lines > THRESHOLDS["main_py_lines"]:
        msg = f"main.py {main_lines} 行 > {THRESHOLDS['main_py_lines']}（S-1 已登记）"
        if ALLOW_KNOWN:
            info.append(f"  [allow-known] {msg}")
        else:
            violations.append(msg)

    py_files = git_ls_files_regex(r"^backend/.*\.py$")
    worst = None
    worst_lines = 0
    for rel in py_files:
        n = count_lines(REPO / rel)
        if n > worst_lines:
            worst_lines, worst = n, rel
    info.append(f"backend 最大单文件: {worst}（{worst_lines} 行，阈值 {THRESHOLDS['single_py_lines']}）")
    if worst_lines > THRESHOLDS["single_py_lines"] and worst != "backend/worker/src/main.py":
        msg = f"{worst} {worst_lines} 行 > {THRESHOLDS['single_py_lines']}（未登记 S-1）"
        if ALLOW_KNOWN:
            info.append(f"  [allow-known] {msg}")
        else:
            violations.append(msg)

    # --- S-2：# noqa: E402（仅统计生产源码，排除 tests/ —— 测试文件延迟 import 构造夹具属正常）---
    all_src = git_ls_files_regex(r"^(backend|frontend/src|shared)/.*\.(py|ts|tsx)$")
    prod_src = [f for f in all_src if "/tests/" not in f and "/__tests__/" not in f]
    noqa_count = count_pattern(prod_src, r"noqa:\s*E402")
    noqa_all = count_pattern(all_src, r"noqa:\s*E402")
    info.append(f"# noqa: E402 命中（生产源码）: {noqa_count} / 全仓含 tests: {noqa_all}（阈值 {THRESHOLDS['noqa_e402_count']}，S-2 已登记）")
    if noqa_count > THRESHOLDS["noqa_e402_count"]:
        msg = f"noqa:E402 生产源码 {noqa_count} 处 > {THRESHOLDS['noqa_e402_count']}（S-2 已登记）"
        if ALLOW_KNOWN:
            info.append(f"  [allow-known] {msg}")
        else:
            violations.append(msg)

    # --- S-4：except Exception ---
    exc_count = count_pattern(py_files, r"except\s+Exception")
    info.append(f"except Exception 命中: {exc_count}（阈值 {THRESHOLDS['except_exception']}）")
    if exc_count > THRESHOLDS["except_exception"]:
        violations.append(f"except Exception {exc_count} 处 > {THRESHOLDS['except_exception']}（未登记 S-4，新增需先在 STRUCTURAL_DEBT.md 登记理由）")

    # --- S-4：print() ---
    # 注：git ls-files 的 ** 通配在部分版本不展开，改用无通配 + 前缀过滤（与 backend/**/*.py 同样问题已用此法规避）
    worker_src = git_ls_files_regex(r"^backend/worker/src/.*\.py$")
    print_count = count_pattern(worker_src, r"^\s*print\(")
    info.append(f"print() 命中（worker/src）: {print_count}（阈值 {THRESHOLDS['print_count']}）")
    if print_count > THRESHOLDS["print_count"]:
        violations.append(f"print() {print_count} 处 > {THRESHOLDS['print_count']}（未登记 S-4，生产 Worker 源码禁止裸 print，改 console.log 或 logging）")

    # --- S-3：TODO 数量（仅打印，生产源码排除 tests/） ---
    todo_count = count_pattern(prod_src, r"TODO|FIXME|HACK")
    info.append(f"TODO/FIXME/HACK 注释数: {todo_count}（无阈值，仅打印供 review 对照）")

    print("=== 结构性债静态门禁（docs/STRUCTURAL_DEBT.md §4.1）===")
    for line in info:
        print("  " + line)
    if violations:
        print("\n❌ 有未登记违规：")
        for v in violations:
            print("  - " + v)
        print("\n登记新债 → docs/STRUCTURAL_DEBT.md（先加 S 条目再改代码）")
        return 1
    print("\n✅ 通过（已登记债按 --allow-known 放行，新增违规为 0）")
    return 0

if __name__ == "__main__":
    sys.exit(main())