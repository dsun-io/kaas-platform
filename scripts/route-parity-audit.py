"""临时工具：三方比对 —— 前端调用面 vs orchestrator（开发版） vs Worker（线上版）。

产出三类结论：
  【线上坏】前端在调、开发版有、线上没有   → 用户点进去就是 404/500
  【幽灵接口】前端在调、两边后端都没有      → 前端调了不存在的接口
  【反向漂移】线上有、开发版没有            → 代码只存在于 worker，不在版本控制主线

用法（仓库根执行）：python scripts/_drift_audit.py
用完即删。
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ORCH_API = ROOT / "backend" / "orchestrator" / "app" / "api"
WORKER_MAIN = ROOT / "backend" / "worker" / "src" / "main.py"
FE_SRC = ROOT / "frontend" / "src"

ORCH_RE = re.compile(r"@router\.(get|post|patch|put|delete)\(\s*[\"']([^\"']+)[\"']")
WORKER_RE = re.compile(r"@app\.(get|post|patch|put|delete)\(\s*[\"']([^\"']+)[\"']")
PREFIX_RE = re.compile(r"APIRouter\([\s\S]{0,300}?prefix\s*=\s*[\"']([^\"']*)[\"']")
# 前端：apiClient.get("/x") / apiClient.post<T>(`/x/${id}`)
FE_RE = re.compile(
    r"apiClient\.(get|post|patch|put|delete)\s*(?:<[^>]*>)?\s*\(\s*[`\"']([^`\"']+)[`\"']"
)


def norm(path: str) -> str:
    path = path.split("?")[0]
    path = re.sub(r"\$\{[^}]*\}", "{}", path)   # 前端模板串
    path = re.sub(r"\{[^}]*\}", "{}", path)      # 后端路径参数
    return re.sub(r"/+$", "", path.rstrip("/")) or "/"


def orch_routes() -> dict[str, set[str]]:
    routes: dict[str, set[str]] = {}
    for src_file in sorted(ORCH_API.glob("*.py")):
        src = src_file.read_text(encoding="utf-8", errors="ignore")
        m = PREFIX_RE.search(src)
        prefix = m.group(1) if m else ""
        for mm in ORCH_RE.finditer(src):
            routes.setdefault(f"{mm.group(1).lower()}", set()).add(norm(prefix + mm.group(2)))
    return routes


def worker_routes() -> dict[str, set[str]]:
    src = WORKER_MAIN.read_text(encoding="utf-8", errors="ignore")
    routes: dict[str, set[str]] = {}
    for mm in WORKER_RE.finditer(src):
        routes.setdefault(f"{mm.group(1).lower()}", set()).add(norm(mm.group(2)))
    return routes


def fe_calls() -> dict[str, set[set[str]]]:
    calls: dict[str, set[str]] = {}
    for suffix in ("*.ts", "*.tsx"):
        for f in FE_SRC.rglob(suffix):
            if "node_modules" in str(f):
                continue
            src = f.read_text(encoding="utf-8", errors="ignore")
            for mm in FE_RE.finditer(src):
                path = norm("/api/v1" + mm.group(2))
                calls.setdefault(mm.group(1).lower(), set()).add(path)
    return calls


def has(routes: dict[str, set[str]], method: str, path: str) -> bool:
    return path in routes.get(method, set())


def main() -> None:
    orch, work, fe = orch_routes(), worker_routes(), fe_calls()

    o_total = sum(len(v) for v in orch.values())
    w_total = sum(len(v) for v in work.values())

    broken, ghost, ok = [], [], []
    for method, paths in sorted(fe.items()):
        for path in sorted(paths):
            if has(orch, method, path) and not has(work, method, path):
                broken.append(f"{method.upper():6s} {path}")
            elif not has(orch, method, path) and not has(work, method, path):
                ghost.append(f"{method.upper():6s} {path}")
            else:
                ok.append(f"{method.upper():6s} {path}")

    rev = []
    for method, paths in sorted(work.items()):
        for path in sorted(paths):
            if not has(orch, method, path):
                rev.append(f"{method.upper():6s} {path}")

    print("=" * 76)
    print(f"开发版接口 {o_total} 个 | 线上接口 {w_total} 个 | 前端调用点 {sum(len(v) for v in fe.values())} 个")
    print("=" * 76)

    print(f"\n【线上坏】前端在调 / 开发版有 / 线上没有 —— {len(broken)} 个")
    print("  （用户点进去就是 404 或 500）\n")
    for line in broken:
        print("   ", line)

    print(f"\n【幽灵接口】前端在调 / 两个后端都没有 —— {len(ghost)} 个\n")
    for line in ghost:
        print("   ", line)

    print(f"\n【反向漂移】线上有 / 开发版没有 —— {len(rev)} 个")
    print("  （代码只存在于 worker 单文件，不在版本控制主线）\n")
    for line in rev:
        print("   ", line)

    print(f"\n【正常】前端调用且线上有 —— {len(ok)} 个（省略明细）")


if __name__ == "__main__":
    main()
