"""临时工具：前端死代码/孤儿文件检测（判断哪些是遗留实现）。

判定逻辑：从 Next.js 的入口（page/layout/route）出发做可达性分析，
"从未被任何文件 import、且不是框架约定入口"的文件 = 候选遗留。

用法（仓库根执行）：python scripts/_dead_code_audit.py
用完即删（结论会落进 docs/CURRENT_IMPLEMENTATION_MAP.md）。
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "frontend" / "src"

IMPORT_RE = re.compile(r"""from\s+["']([^"']+)["']|import\(["']([^"']+)["']\)""")
# Next.js 约定入口：由框架按目录加载，不需要被 import
ENTRY_PATTERNS = ("page.", "layout.", "route.", "loading.", "error.", "not-found.",
                  "template.", "default.", "global-error.", "instrumentation", "middleware")


def collect_files() -> list[Path]:
    files: list[Path] = []
    for suffix in ("*.ts", "*.tsx"):
        files.extend(f for f in SRC.rglob(suffix) if "node_modules" not in str(f))
    return files


def resolve(spec: str, from_file: Path) -> Path | None:
    """把 import 说明符解析为仓库内文件路径（只处理相对路径与 @/ 别名）。"""
    if spec.startswith("@/"):
        base = SRC / spec[2:]
    elif spec.startswith("."):
        base = (from_file.parent / spec).resolve()
    else:
        return None  # 第三方包
    candidates = [base.with_suffix(".ts"), base.with_suffix(".tsx"),
                  base / "index.ts", base / "index.tsx"]
    for c in candidates:
        if c.exists():
            return c
    return None


def main() -> None:
    files = collect_files()
    referenced: set[Path] = set()

    for f in files:
        text = f.read_text(encoding="utf-8", errors="ignore")
        for m in IMPORT_RE.finditer(text):
            spec = m.group(1) or m.group(2)
            if not spec:
                continue
            target = resolve(spec, f)
            if target:
                referenced.add(target.resolve())

    orphans = []
    for f in files:
        rp = f.resolve()
        if rp in referenced:
            continue
        if any(pat in f.name for pat in ENTRY_PATTERNS):
            continue
        orphans.append(f.relative_to(SRC))

    print("=" * 74)
    print(f"前端文件总数 {len(files)} ｜ 被引用 {len(referenced)} ｜ 候选孤儿 {len(orphans)}")
    print("=" * 74)
    for o in sorted(orphans):
        print(f"  {o}")
    if not orphans:
        print("  （无：所有非入口文件都被引用）")


if __name__ == "__main__":
    main()
