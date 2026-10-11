"""三方比对 —— 前端调用面 vs orchestrator（开发版） vs Worker（线上版）。

产出三类结论：
  【线上坏】前端在调、开发版有、线上没有   → 用户点进去就是 404/500
  【幽灵接口】前端在调、两边后端都没有      → 前端调了不存在的接口
  【反向漂移】线上有、开发版没有            → 代码只存在于 worker，不在版本控制主线

用法（仓库根执行）：python scripts/route-parity-audit.py

与 scripts/route-parity.py 的分工
--------------------------------
route-parity.py 是 **CI 门禁（棘轮）**：只比 orchestrator ↔ worker 的路由面，必须全绿。
本脚本是**取证工具**：多带一个「前端到底在调什么」的维度，用来回答
「这些缺口里哪些是用户真的会踩到的」。两者共用同一套解析口径。

⚠️ 2026-10-11 修复：本脚本原先只读 `worker/src/main.py` 一个文件。
worker 后来拆成 14 个模块（ws_*.py / chain.py / quote_api.py …），于是脚本
漏掉一百多条线上路由，把**其实已经实现**的路由（teams/me、me/workstations、
tenant-products、customers/{id}/records …）全报成【线上坏】——62 条假警报，
整份漂移报告因此失去可信度。现改为扫整个 `worker/src/`，
并补上 `@app.api_route(methods=[...])` 这种注册写法（原先也漏）。
"""
import re
import sys
from pathlib import Path

# 与 scripts/route-parity.py 同一处理：Windows 默认 stdout 是 GBK，
# 本脚本打印中文结论会变成乱码（route-parity.py 更会直接 UnicodeEncodeError 崩掉）。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
ORCH_API = ROOT / "backend" / "orchestrator" / "app" / "api"
ORCH_MAIN = ROOT / "backend" / "orchestrator" / "app" / "main.py"
WORKER_SRC = ROOT / "backend" / "worker" / "src"
FE_SRC = ROOT / "frontend" / "src"

METHODS = ("get", "post", "put", "patch", "delete", "head", "options")

PREFIX_RE = re.compile(r'APIRouter\(\s*prefix\s*=\s*"([^"]*)"')
# 装饰器允许换行（@router.post(\n  "/x",\n) 这种写法）
DECORATOR_RE = re.compile(
    r'@(?:router|app)\.(' + "|".join(METHODS) + r')\(\s*[fr]?["\']([^"\']*)["\']'
)
# 多方法注册：@app.api_route("/x", methods=["GET", "POST", ...])
API_ROUTE_RE = re.compile(
    r'@(?:router|app)\.api_route\(\s*[fr]?["\']([^"\']*)["\'][^)]*?methods\s*=\s*\[([^\]]*)\]',
    re.DOTALL,
)
# 前端：apiClient.get("/x") / apiClient.post<T>(`/x/${id}`)
FE_RE = re.compile(
    r"apiClient\.(get|post|patch|put|delete)\s*(?:<[^>]*>)?\s*\(\s*[`\"']([^`\"']+)[`\"']"
)


def norm(path: str) -> str:
    path = path.split("?")[0]
    path = re.sub(r"\$\{[^}]*\}", "{}", path)   # 前端模板串
    path = re.sub(r"\{[^}]*\}", "{}", path)      # 后端路径参数
    return re.sub(r"/+$", "", path.rstrip("/")) or "/"


def routes_in(source: str, prefix: str) -> set[tuple[str, str]]:
    """从一个源文件里抽出 (method, path)，覆盖装饰器与 api_route 两种写法。"""
    out: set[tuple[str, str]] = set()
    for method, route in DECORATOR_RE.findall(source):
        out.add((method.lower(), norm(prefix + route)))
    for route, methods in API_ROUTE_RE.findall(source):
        for m in re.findall(r'["\'](\w+)["\']', methods):
            out.add((m.lower(), norm(prefix + route)))
    return out


def orch_routes() -> dict[str, set[str]]:
    routes: dict[str, set[str]] = {}
    for src_file in sorted(ORCH_API.glob("*.py")) + [ORCH_MAIN]:
        if not src_file.exists():
            continue
        src = src_file.read_text(encoding="utf-8", errors="ignore")
        m = PREFIX_RE.search(src)
        prefix = m.group(1) if m else ""
        for method, path in routes_in(src, prefix):
            routes.setdefault(method, set()).add(path)
    return routes


def worker_routes() -> dict[str, set[str]]:
    """扫**整个** worker/src/，而不是只读 main.py。"""
    routes: dict[str, set[str]] = {}
    for src_file in sorted(WORKER_SRC.glob("*.py")):
        src = src_file.read_text(encoding="utf-8", errors="ignore")
        for method, path in routes_in(src, ""):
            routes.setdefault(method, set()).add(path)
    return routes


def fe_calls() -> dict[str, set[str]]:
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
    print(f"扫描口径：orchestrator api/*.py + main.py；worker/src/*.py "
          f"{len(list(WORKER_SRC.glob('*.py')))} 个文件（含 api_route 多方法注册）")

    print(f"\n【线上坏】前端在调 / 开发版有 / 线上没有 —— {len(broken)} 个")
    print("  （用户点进去就是 404 或 500）\n")
    for line in broken:
        print("   ", line)

    print(f"\n【幽灵接口】前端在调 / 两个后端都没有 —— {len(ghost)} 个\n")
    for line in ghost:
        print("   ", line)

    print(f"\n【反向漂移】线上有 / 开发版没有 —— {len(rev)} 个")
    print("  （代码只在 worker 侧，主线没有：用 orchestrator 重新生成 worker 会丢功能）\n")
    for line in rev:
        print("   ", line)

    print(f"\n【正常】前端调用且线上有 —— {len(ok)} 个（省略明细）")


if __name__ == "__main__":
    main()
