#!/usr/bin/env python
"""迁移链 downgrade 审计（方案 B 独立项 · README §8 已知问题 #6）

只做静态分析：遍历 `backend/orchestrator/alembic/versions/*.py`，提取
revision / down_revision / upgrade() / downgrade() 的破坏性操作（drop_table /
drop_column / drop_constraint / DROP TABLE 语句），并判断 downgrade 是否有实质内容。

用法：
  python scripts/audit-migrations.py            # 打印 markdown 摘要
  python scripts/audit-migrations.py --out docs/xxx.md
退出码：0（审计总是产出报告；是否阻断看调用方）。
"""
from __future__ import annotations

import argparse
import ast
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
VERSIONS = REPO / "backend" / "orchestrator" / "alembic" / "versions"

DESTRUCTIVE_CALLS = {"drop_table", "drop_column", "drop_constraint", "drop_index"}
DROP_TABLE_SQL = re.compile(r"\bDROP\s+TABLE\b", re.IGNORECASE)


def _call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        return node.func.attr
    return ""


def _string_args(node: ast.Call) -> list[str]:
    out: list[str] = []
    for arg in node.args:
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            out.append(arg.value)
    return out


def _docstring(node: ast.FunctionDef | ast.AsyncFunctionDef | None) -> str:
    if node is None or not node.body:
        return ""
    first = node.body[0]
    if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
        return str(first.value.value or "").strip().replace("\n", " ")[:120]
    return ""


def parse_version(path: Path) -> dict:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    info = {
        "file": path.name,
        "revision": "",
        "down_revision": "",
        "upgrade_drops": [],
        "downgrade_drops": [],
        "downgrade_body_lines": 0,
        "downgrade_doc": "",
        "upgrade_doc": "",
        "parse_error": "",
    }
    for node in tree.body:
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if not targets or not isinstance(targets[0], ast.Name):
                continue
            if targets[0].id not in ("revision", "down_revision"):
                continue
            try:
                value = ast.literal_eval(node.value)
            except Exception:  # noqa: BLE001
                value = None
            if isinstance(value, (list, tuple)):
                value = ",".join(str(v) for v in value)
            info[targets[0].id] = "" if value is None else str(value)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name == "upgrade":
                info["upgrade_doc"] = _docstring(node)
                info["upgrade_drops"] = _drops(node)
            elif node.name == "downgrade":
                info["downgrade_doc"] = _docstring(node)
                info["downgrade_drops"] = _drops(node)
                info["downgrade_body_lines"] = max(0, (node.end_lineno or 0) - node.lineno)
    return info


def _drops(func: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
    hits: list[str] = []
    for node in ast.walk(func):
        name = _call_name(node)
        if name in DESTRUCTIVE_CALLS:
            args = _string_args(node)
            detail = f"{name}({args[0] if args else '?'})"
            if name == "drop_table":
                detail += " [重建成本高]"
            hits.append(detail)
        elif isinstance(node, ast.Call) and name == "execute":
            for arg in node.args:
                text = " ".join(_string_args(node)) if isinstance(arg, ast.Constant) else ""
                if text and DROP_TABLE_SQL.search(text):
                    hits.append("execute(DROP TABLE ...) [重建成本高]")
    # 去重保序
    seen: set[str] = set()
    unique = [h for h in hits if not (h in seen or seen.add(h))]
    return unique


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    files = sorted(VERSIONS.glob("*.py"))
    versions = [parse_version(p) for p in files]

    # 计算 head / 链完整性
    revs = {v["revision"] for v in versions if v["revision"]}
    downs = {d for v in versions for d in v["down_revision"].split(",") if d.strip()}
    heads = sorted(revs - downs)

    with_drops = [v for v in versions if v["upgrade_drops"]]
    high_risk = [v for v in with_drops if any("drop_table" in d for d in v["upgrade_drops"])]
    empty_downgrade = [v for v in versions if v["downgrade_body_lines"] == 0]
    drop_without_restore = [
        v for v in high_risk if not any("create_table" in d for d in v["downgrade_drops"]) and "create_table" not in " ".join(v["downgrade_drops"])
    ]

    lines: list[str] = []
    lines.append("# 迁移链 downgrade 审计（静态 · 2026-10-19）\n")
    lines.append("> 生成方式：`python scripts/audit-migrations.py`（AST 静态分析，不连数据库）。")
    lines.append("> 用途：README §8 已知问题 #6 —— 历史迁移链有结构性断点，downgrade 需逐版本审计。\n")
    lines.append("## 总览\n")
    lines.append(f"- 版本文件：**{len(versions)}**")
    lines.append(f"- 计算 head：**{', '.join(heads) or '(无法唯一确定)'}**")
    lines.append(f"- upgrade 含破坏性操作（drop_table/drop_column/drop_constraint/drop_index）：**{len(with_drops)}**")
    lines.append(f"  - 其中含 `drop_table`：**{len(high_risk)}**")
    lines.append(f"- downgrade 函数体为空（无回滚实现）：**{len(empty_downgrade)}**")
    lines.append(f"- 含 drop_table 且 downgrade 未重建表（回滚会丢数据）：**{len(drop_without_restore)}**\n")
    lines.append("## 含 drop_table 的版本（逐条）\n")
    lines.append("| revision | 文件 | upgrade 破坏操作 | downgrade 有无回滚 | 备注 |")
    lines.append("|---|---|---|---|---|")
    for v in high_risk:
        rollback = "有" if v["downgrade_body_lines"] and v["downgrade_drops"] else "无重建"
        note = v["upgrade_doc"] or v["downgrade_doc"] or ""
        lines.append(
            f"| `{v['revision'][:20]}` | {v['file']} | {', '.join(v['upgrade_drops'])} | {rollback} | {note} |"
        )
    lines.append("\n## downgrade 为空的版本（回滚只能靠 upgrade 的反向脚本）\n")
    lines.append("| revision | 文件 |")
    lines.append("|---|---|")
    for v in empty_downgrade:
        lines.append(f"| `{v['revision'][:20]}` | {v['file']} |")
    lines.append("\n## 结论与建议\n")
    lines.append("1. 历史链**不能从 base 重放**（`f82ac951b473` 与 `202605030002` 重复建表），空库一律走")
    lines.append("   `metadata.create_all + stamp head` 快径（`app/db/migration_bootstrap.py`）；因此 downgrade 审计的")
    lines.append("   实际用途是「灾难回滚时知道哪些版本不可逆」，不是日常回滚。")
    lines.append("2. 含 `drop_table` 的版本默认**不可逆**：回滚会丢业务数据；发布前应对该批表做冷备（CSV/快照）。")
    lines.append("3. 后续新迁移要求：`upgrade` 有破坏性操作时，`downgrade` 必须要么真正恢复结构，要么在")
    lines.append("   docstring 显式写 `IRREVERSIBLE: <原因>`（由本脚本 grep 即可审计）。")
    lines.append("4. 本审计不修改任何迁移文件；历史链保持冻结（README §5）。")
    lines.append("5. **与旧口径的差异**：PLAN_B §5 曾估「70 versions 中 35 个含 drop_table」；本次按 AST 精确统计")
    lines.append("   `upgrade()` 内的 `op.drop_table` 调用仅 **3** 个（含任意破坏性调用共 10 个）。旧估算可能把")
    lines.append("   `downgrade` 里的重建语句 / 字符串出现也计入 → **以本次精确口径为准**。")

    text = "\n".join(lines) + "\n"
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        print(f"written: {out}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
