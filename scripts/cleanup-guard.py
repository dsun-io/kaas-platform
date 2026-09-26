"""清理门禁 —— 保护业务功能不被误删。

设计背景
--------
用户的核心诉求：「必须保证新业务逻辑不会被改掉」。
因此任何删除 / 归档动作，都必须先通过双重检查：

  1) **零引用检查** —— 由 `scripts/dead-code-audit.py` 负责（先找出"孤儿"文件）
  2) **白名单校验** —— 由本脚本负责（命中保护清单则**中止**）

清单定义在 `scripts/protected-paths.json`，分四类：

  protected        不可动（业务功能载体）
  pending_reuse    已写好但尚未引用的基建（P2 会复用，**不是垃圾**）
  pending_removal  已批准摘除（允许归档，但不得物理删除）
  known_junk       已确认垃圾（允许清理）

关键设计：**双向包含检查**
  只检查"待删路径是否在保护项之下"是不够的。
  若有人要删 `frontend/src/app/(app)`，它本身不在清单里，
  却会连带删掉下面所有受保护的工位 —— 所以还要反查"保护项是否在待删路径之下"。

用法
----
  python scripts/cleanup-guard.py --list                # 打印清单摘要
  python scripts/cleanup-guard.py --self-check          # 校验清单自身一致性
  python scripts/cleanup-guard.py <path> [<path>...]    # 校验待清理路径
  python scripts/cleanup-guard.py --from-file list.txt  # 从文件读路径（每行一个）

退出码
------
  0 = 允许清理      1 = 命中保护清单（中止）      2 = 用法错误 / 清单缺失
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "scripts" / "protected-paths.json"


# ─────────────────────────────────────────────────────────────────────────────
# 路径规范化
# ─────────────────────────────────────────────────────────────────────────────
def norm(p: str | Path) -> str:
    """统一为「仓库相对、正斜杠、无首尾斜杠」形式，保证跨平台可比较。"""
    s = str(p).replace("\\", "/").strip()
    # 若给的是绝对路径，尝试转成仓库相对路径
    try:
        abs_p = Path(s)
        if abs_p.is_absolute():
            s = abs_p.resolve().relative_to(ROOT).as_posix()
    except (ValueError, OSError):
        pass  # 不在仓库内，保持原样（后续匹配不上即视为不保护）
    while s.startswith("./"):
        s = s[2:]
    return s.strip("/")


def related(a: str, b: str) -> bool:
    """a 与 b 是否存在包含关系：相等 / a 在 b 之下 / b 在 a 之下。

    第三个分支就是上面说的"反查"——防止用父目录把受保护的子项一起删掉。
    """
    if not a or not b:
        return False
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")


# ─────────────────────────────────────────────────────────────────────────────
# 清单读取
# ─────────────────────────────────────────────────────────────────────────────
def load_registry() -> dict:
    if not REGISTRY.exists():
        print(f"[FATAL] 保护清单不存在：{REGISTRY}", file=sys.stderr)
        sys.exit(2)
    return json.loads(REGISTRY.read_text(encoding="utf-8"))


def flatten(block: dict, default_cat: str = "flat") -> list[tuple[str, str]]:
    """展平为 [(路径, 类别名)]，兼容两种写法：

    · 嵌套：{'类名': {'desc': ..., 'paths': [...]}}   例：protected
    · 扁平：{'desc': ..., 'paths': [...]}             例：known_junk

    （早期只支持嵌套，导致扁平写法的三块清单全部静默失效 —— 已修正）
    """
    out: list[tuple[str, str]] = []
    if not isinstance(block, dict):
        return out
    if "paths" in block:  # 扁平写法
        return [(norm(p), default_cat) for p in block.get("paths", [])]
    for cat, spec in block.items():  # 嵌套写法
        if isinstance(spec, dict):
            out.extend((norm(p), cat) for p in spec.get("paths", []))
    return out


def section_lines(block: dict, default_cat: str) -> list[str]:
    """把一个清单块渲染成待打印的行，兼容嵌套 / 扁平两种写法。

    历史 bug：`--list` 曾自己写了一套只认嵌套写法的循环，于是三块扁平清单
    （pending_reuse / pending_removal / known_junk）**一条都打不出来**，
    而 `--self-check` 走 flatten() 却报告 4/11/5 项 —— 两份并行实现互相矛盾。
    现在摘要与校验共用 flatten()，并在 self_check 里强制二者条数一致。
    """
    lines: list[str] = []
    if not isinstance(block, dict):
        return lines
    if "paths" in block:  # 扁平写法：desc 描述整块
        lines.append(f"   [{default_cat}] {block.get('desc', '')}")
        lines.extend(f"      {norm(p)}" for p in block.get("paths", []))
        return lines
    for cat, spec in block.items():  # 嵌套写法：每个类别自带 desc
        if not isinstance(spec, dict):
            continue
        lines.append(f"   [{cat}] {spec.get('desc', '')}")
        lines.extend(f"      {norm(p)}" for p in spec.get("paths", []))
    return lines


# 四个清单块的 (标题, JSON 键, 图标, 扁平写法下的默认类别名)
SECTIONS = (
    ("不可动", "protected", "🔒", "protected"),
    ("待复用（不是垃圾）", "pending_reuse", "♻", "pending_reuse"),
    ("已批准摘除（可归档不可删）", "pending_removal", "📦", "pending_removal"),
    ("已确认垃圾（可清理）", "known_junk", "🗑", "known_junk"),
)


# ─────────────────────────────────────────────────────────────────────────────
# 校验
# ─────────────────────────────────────────────────────────────────────────────
def check_paths(paths: list[str], reg: dict) -> tuple[list, list, list]:
    """返回 (被拦截项, 归档提醒项, 已知垃圾项)，每项为 (待检路径, 命中项, 类别)。

    判定顺序（重要）：
      1. `known_junk` —— **精确匹配**，命中即放行。
         刻意用精确而非包含匹配：避免一个 junk 目录项绕过保护、批量删掉整片。
         这也解决了「受保护工位目录里恰好有要清的垃圾文件」的矛盾。
      2. `protected` / `pending_reuse` —— 包含关系（双向反查），命中即拦截。
      3. `pending_removal` —— 包含关系，提示「可归档、不可物理删除」。
    """
    protected = flatten(reg.get("protected", {}))
    reuse = flatten(reg.get("pending_reuse", {}), "pending_reuse")
    removal = flatten(reg.get("pending_removal", {}), "pending_removal")
    junk_exact = {jp for jp, _ in flatten(reg.get("known_junk", {}), "known_junk")}

    blocked, notice_removal, notice_junk = [], [], []

    for raw in paths:
        p = norm(raw)
        if not p:
            continue

        if p in junk_exact:  # ① 已知垃圾（精确命中）
            notice_junk.append((p, "", "known_junk"))
            continue

        hit = next(((g, c) for g, c in protected + reuse if related(p, g)), None)
        if hit:  # ② 受保护 / 待复用
            blocked.append((p, hit[0], hit[1]))
            continue

        if any(related(p, g) for g, _ in removal):  # ③ 已批准摘除
            notice_removal.append((p, "", "pending_removal"))

    return blocked, notice_removal, notice_junk


def self_check(reg: dict) -> int:
    """校验清单自身一致性：同一路径不能既是垃圾又受保护。"""
    protected = flatten(reg.get("protected", {}))
    reuse = flatten(reg.get("pending_reuse", {}), "pending_reuse")
    removal = flatten(reg.get("pending_removal", {}), "pending_removal")
    junk = flatten(reg.get("known_junk", {}), "known_junk")

    problems: list[str] = []
    # junk 采用精确匹配且优先于保护清单，因此落在受保护目录内的 junk 项是【有意例外】，
    # 这里只做提示，不算错误。
    exceptions = [
        jp for jp, _ in junk
        if any(related(jp, gp) for gp, _ in protected + reuse)
    ]
    junk_dirs = [p for p, _ in junk if (ROOT / p).is_dir()]

    missing = [
        p for p, _ in protected + reuse + removal
        if not (ROOT / p).exists()
    ]

    # 打印器与计数器一致性：两者必须给出相同的条数。
    # （历史 bug：两份并行实现，扁平写法下 --list 安静地打成空清单。）
    for title, key, _mark, default_cat in SECTIONS:
        block = reg.get(key, {})
        printed = sum(1 for ln in section_lines(block, default_cat) if ln.startswith("      "))
        counted = len(flatten(block, default_cat))
        if printed != counted:
            problems.append(
                f"{key}：--list 打印 {printed} 项，但清单实际有 {counted} 项（打印器与解析器不一致）"
            )

    print("=" * 74)
    print("保护清单自检")
    print("=" * 74)
    print(f"  protected        {len(protected):>3} 项")
    print(f"  pending_reuse    {len(reuse):>3} 项")
    print(f"  pending_removal  {len(removal):>3} 项")
    print(f"  known_junk       {len(junk):>3} 项")
    if missing:
        print(f"\n  ⚠ 清单中 {len(missing)} 项在磁盘上不存在（可能是待建/已移走）：")
        for m in missing:
            print(f"      {m}")
    if exceptions:
        print(f"\n  ⓘ known_junk 中 {len(exceptions)} 项位于受保护目录内（有意例外，精确匹配优先）：")
        for e in exceptions:
            print(f"      {e}")
    if junk_dirs:
        print(f"\n  ⚠ known_junk 中 {len(junk_dirs)} 项是目录（删目录风险高，建议改成具体文件）：")
        for d in junk_dirs:
            print(f"      {d}")
    if problems:
        print(f"\n  ✗ 发现 {len(problems)} 处结构问题：")
        for p in problems:
            print(f"      {p}")
        return 1
    print("\n  ✓ 清单结构一致")
    return 0


# ─────────────────────────────────────────────────────────────────────────────
# 入口
# ─────────────────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser(description="清理门禁：删除前必须通过的保护清单校验")
    ap.add_argument("paths", nargs="*", help="待清理的路径")
    ap.add_argument("--list", action="store_true", help="打印清单摘要")
    ap.add_argument("--self-check", action="store_true", help="校验清单自身一致性")
    ap.add_argument("--from-file", help="从文件读取路径列表（每行一个，# 开头为注释）")
    args = ap.parse_args()

    reg = load_registry()

    if args.self_check:
        return self_check(reg)

    if args.list:
        print("=" * 74)
        print("业务功能保护清单")
        print("=" * 74)
        for title, key, mark, default_cat in SECTIONS:
            block = reg.get(key, {})
            # 把项数直接写进标题：数量为 0 是危险信号，必须一眼可见
            count = len(flatten(block, default_cat))
            print(f"\n{mark} {title} —— {count} 项")
            for line in section_lines(block, default_cat):
                print(line)
        return 0

    targets = list(args.paths)
    if args.from_file:
        lines = Path(args.from_file).read_text(encoding="utf-8").splitlines()
        targets += [ln.strip() for ln in lines if ln.strip() and not ln.strip().startswith("#")]

    if not targets:
        ap.print_help()
        return 2

    blocked, notice_removal, notice_junk = check_paths(targets, reg)

    print("=" * 74)
    print(f"清理门禁校验：{len(targets)} 个待清理路径")
    print("=" * 74)

    for p, g, cat in notice_junk:
        print(f"  🗑 允许   {p}   （已知垃圾）")
    for p, _, _ in notice_removal:
        print(f"  📦 归档   {p}   （已批准摘除：可移动到归档目录，但不得物理删除）")
    for p, g, cat in blocked:
        print(f"  🔒 拦截   {p}")
        print(f"            命中保护项：{g}   [{cat}]")

    if blocked:
        print(f"\n✗ 中止：{len(blocked)} 个路径受保护。")
        print("  若确需清理，请先取得用户明确指令，并从 protected-paths.json 中移除对应条目（需说明理由）。")
        return 1

    print(f"\n✓ 通过：{len(targets)} 个路径均不在保护清单内。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
