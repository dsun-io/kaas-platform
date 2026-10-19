#!/usr/bin/env python
"""路由对等检查 —— 防「orchestrator 开发 → Worker 手工同步」再次漂移。

背景
----
orchestrator（本地开发）与 worker（生产 Cloudflare Workers）是两套代码。
历史教训：`fx-rates` / `actual-costs` / `external-docs` / `tenant-products` /
`workstation-products` / `company-seals` 都曾在 orchestrator 有、worker 没有，
前端一上生产就是 404。`sync-shared.ps1 -Check` 只保证**共享内核**一致，
管不到**路由面**——本脚本补上这一环。

判定规则（棘轮，ratchet）
-------------------------
1. **缺失**：orchestrator 有、worker 没有，且**未**登记在允许清单里 → FAIL。
   这是真正的漂移：本地能开、线上 404。
2. **过期登记**：允许清单里的路由其实 worker 已经有了 → FAIL（清单要删干净，
   否则棘轮会漏掉下一次漂移）。
3. **Worker 独有**：只提示，不算失败 —— 它表示 worker 跑在前面，
   需要在 orchestrator 侧补齐（属于另一类问题）。

允许清单
--------
`scripts/archive/route-parity-allowlist.txt`，每行 `METHOD /path`。
登记 = 明确承认「这条路由线上故意不做」，必须写清原因（行尾 `# 原因`）。

用法
----
    python scripts/route-parity.py            # 校验（CI 用，不一致退出码 1）
    python scripts/route-parity.py --update   # 按当前状态重写允许清单（需人工复核）
    python scripts/route-parity.py --list     # 只打印差异，不改任何东西
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# Windows 的默认 stdout 编码是 GBK，而本脚本会打印 ℹ️ / ✅ / ❌ ——
# 判定其实已经算完，却会在收尾打印时 `UnicodeEncodeError: 'gbk' codec can't
# encode character '\u2139'` 崩掉，看不到结论（本仓库在 Windows 上开发）。
# CI（ubuntu，UTF-8）不受影响；这里统一成 UTF-8，让两边行为一致。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

REPO_ROOT = Path(__file__).resolve().parents[1]
ORCH_API_DIR = REPO_ROOT / "backend" / "orchestrator" / "app" / "api"
ORCH_MAIN = REPO_ROOT / "backend" / "orchestrator" / "app" / "main.py"
WORKER_SRC_DIR = REPO_ROOT / "backend" / "worker" / "src"
ALLOWLIST = REPO_ROOT / "scripts" / "archive" / "route-parity-allowlist.txt"

METHODS = ("get", "post", "put", "patch", "delete", "head", "options")

_PREFIX_RE = re.compile(r'APIRouter\(\s*prefix\s*=\s*"([^"]*)"')
# 装饰器允许换行（@router.post(\n  "/x",\n) 这种写法）
_DECORATOR_RE = re.compile(
    r'@(?:router|app)\.(' + "|".join(METHODS) + r')\(\s*[fr]?["\']([^"\']*)["\']'
)
# 多方法注册：@app.api_route("/x", methods=["GET", "POST", ...])
# （漏掉这种写法会让检查器「看不见」路由 —— 既可能误报缺口，也可能掩盖真漂移）
_API_ROUTE_RE = re.compile(
    r'@(?:router|app)\.api_route\(\s*[fr]?["\']([^"\']*)["\'][^)]*?methods\s*=\s*\[([^\]]*)\]',
    re.DOTALL,
)
_HEADER_RE = re.compile(r"^\s*#")


def _normalize(path: str) -> str:
    """统一尾斜杠与重复斜杠，避免 /a/ 与 /a 被判成两条。"""
    path = re.sub(r"/{2,}", "/", path)
    if len(path) > 1:
        path = path.rstrip("/")
    return path


def _routes_in(source: str, prefix: str) -> set[tuple[str, str]]:
    """从一个源文件里抽出 (METHOD, path)。

    覆盖两种写法：`@router.get("/x")` 与
    `@app.api_route("/x", methods=["GET", "POST"])`。
    """
    routes: set[tuple[str, str]] = set()
    for method, route in _DECORATOR_RE.findall(source):
        routes.add((method.upper(), _normalize(prefix + route)))
    for route, methods in _API_ROUTE_RE.findall(source):
        for method in re.findall(r'["\'](\w+)["\']', methods):
            routes.add((method.upper(), _normalize(prefix + route)))
    return routes


def _orchestrator_routes() -> set[tuple[str, str]]:
    """解析 app/api/*.py 的 @router.x(\"/y\") + APIRouter(prefix=...)。"""
    routes: set[tuple[str, str]] = set()
    files = sorted(ORCH_API_DIR.glob("*.py")) + [ORCH_MAIN]
    for path in files:
        if not path.exists():
            continue
        source = path.read_text(encoding="utf-8")
        prefix_match = _PREFIX_RE.search(source)
        prefix = prefix_match.group(1) if prefix_match else ""
        routes |= _routes_in(source, prefix)
    return routes


def _worker_routes() -> set[tuple[str, str]]:
    """解析 worker/src/*.py 的 @app.x(\"/api/v1/...\")（已是完整路径）。"""
    routes: set[tuple[str, str]] = set()
    for path in sorted(WORKER_SRC_DIR.glob("*.py")):
        routes |= _routes_in(path.read_text(encoding="utf-8"), "")
    return routes


def _read_allowlist() -> dict[str, str]:
    """返回 {(METHOD, path): 原因}。"""
    if not ALLOWLIST.exists():
        return {}
    out: dict[str, str] = {}
    for raw in ALLOWLIST.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        reason = ""
        if "#" in line:
            line, reason = line.split("#", 1)
            reason = reason.strip()
        parts = line.split()
        if len(parts) != 2:
            print(f"⚠️  允许清单格式无法解析，已跳过: {raw!r}", file=sys.stderr)
            continue
        out[(parts[0].upper(), _normalize(parts[1]))] = reason
    return out


def _write_allowlist(entries: dict[tuple[str, str], str]) -> None:
    lines = [
        "# orchestrator / worker 路由对等 —— 允许「线上故意不做」的路由清单",
        "#",
        "# 由来：orchestrator 与 worker 是两套代码，历史多次出现「本地有、线上 404」。",
        "# 本文件是**棘轮**：只有登记在案的路由才允许缺失；一旦 worker 补上了，" ,
        "# 对应行必须删掉（scripts/route-parity.py 会把过期登记判为失败）。",
        "#",
        "# 格式：METHOD /path   # 原因（原因必填，便于后人判断能不能删）",
        "# 更新：python scripts/route-parity.py --update  （更新后必须人工复核原因）",
        "",
    ]
    for (method, path), reason in sorted(entries.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        lines.append(f"{method} {path}  # {reason or 'TODO: 补原因'}")
    ALLOWLIST.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="orchestrator / worker 路由对等检查")
    parser.add_argument("--update", action="store_true", help="按当前状态重写允许清单")
    parser.add_argument("--list", action="store_true", help="只打印差异，不判定成败")
    args = parser.parse_args()

    orch = _orchestrator_routes()
    worker = _worker_routes()
    allow = _read_allowlist()

    absent = sorted(orch - worker)                        # 全部缺失
    missing = [r for r in absent if r not in allow]       # 未登记的缺失 = 真漂移
    worker_only = sorted(worker - orch)
    stale = sorted(k for k in allow if k in worker)

    print(f"orchestrator 路由: {len(orch)}   worker 路由: {len(worker)}   "
          f"允许清单: {len(allow)}")
    print(f"缺失: {len(absent)}（已登记 {len(absent) - len(missing)} / 未登记 {len(missing)}）"
          f"   过期登记: {len(stale)}   worker 独有: {len(worker_only)}")

    if args.update:
        # 按当前缺失重写清单；已有条目保留原原因，新条目留 TODO
        entries = {k: allow.get(k, "") for k in absent}
        _write_allowlist(entries)
        print(f"\n已写入 {ALLOWLIST.relative_to(REPO_ROOT)}：{len(entries)} 条待复核（原因需人工补全）")
        return 0

    if args.list:
        for label, items in (("缺失(未登记)", missing), ("过期登记", stale), ("worker 独有", worker_only)):
            print(f"\n== {label} ==")
            for method, path in items:
                print(f"  {method:6s} {path}")
        return 0

    failed = False
    if missing:
        failed = True
        print("\n❌ FAIL: orchestrator 有、worker 没有，且未登记（线上会 404）:")
        for method, path in missing:
            print(f"   {method:6s} {path}")
        print("   → 补齐 worker 路由，或登记到 "
              f"{ALLOWLIST.relative_to(REPO_ROOT)} 并写明原因")
    if stale:
        failed = True
        print("\n❌ FAIL: 允许清单里有路由 worker 其实已经实现（过期登记会掩盖下次漂移）:")
        for method, path in stale:
            print(f"   {method:6s} {path}  ← 该行应删除")
    if worker_only:
        print("\nℹ️  worker 独有（不算失败，建议在 orchestrator 侧补齐）:")
        for method, path in worker_only:
            print(f"   {method:6s} {path}")

    # 债务可见性：原因里写「待补」= 承认这是缺口（不是「故意不做」）。
    # 清单本身不至于让 CI 变红，但每次跑都把这些债打在日志里，避免烂在文件里。
    debt = sorted(k for k, reason in allow.items() if k in orch and "待补" in reason)
    if debt:
        print(f"\n⚠️  已登记的待补缺口 {len(debt)} 条（详见 "
              f"{ALLOWLIST.relative_to(REPO_ROOT)} 与 docs/ROUTE_PARITY_2026-10-10.md）:")
        for method, path in debt:
            print(f"   {method:6s} {path}   ← {allow[(method, path)]}")

    if failed:
        return 1
    print("\n✅ PASS: 路由面对等（缺失项全部已登记且无过期登记）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
