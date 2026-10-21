#!/usr/bin/env python
"""W3 Phase 0 · 路由清单导出器（先遣工具，不改任何产品代码）。

用法：
    backend/worker/.venv/Scripts/python.exe backend/ts-migration/export_routes.py

原理（打桩法）：
    Windows 上 asyncpg 无可用二进制、Cloudflare workers 运行时模块不存在，
    无法直接 import worker 的 main。本脚本在 sys.modules 预注入 stub：

    - asyncpg  —— PEP 562 模块级 __getattr__，任何属性返回占位类型
                 （注解 row: asyncpg.Record 等在 def 期被求值，必须可解析）；
    - workers  —— stub WorkerEntrypoint 基类与 asgi.fetch。

    然后按文件路径加入 sys.path 并 import main：
    - backend/worker/src —— worker 源码（main / ws_* / chain / quote_api 全是顶层模块）；
    - backend            —— 共享内核 kaas_common。
    main.py 末尾会自行 import 全部 ws_* 卫星模块，路由全部挂到同一个 app 上。

    platform/db.py 由 main.py 用 importlib 按文件加载（与 stdlib platform 重名，
    不能按包导入），stub 在 sys.modules 里同样生效，不受影响。

产物：
    backend/ts-migration/route-inventory.md —— 按文件分组的表格 + 域归属 + 总数核对。

解释器说明：须用 backend/worker/.venv 的 python（含 fastapi/pydantic/jwt）。
orchestrator 的 venv 没有 fastapi，跑不了本脚本（PATH 上的 python 是坏的
WindowsApps 占位符）。
"""

from __future__ import annotations

import inspect
import os
import sys
import types
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.normpath(os.path.join(HERE, ".."))
WORKER_SRC = os.path.join(BACKEND, "worker", "src")

EXPECTED_TOTAL = 253  # docs/OPTIMIZATION_PLAN_2026-10-21.md §2 Phase 0 登记数


def _install_stubs() -> None:
    asyncpg_stub = types.ModuleType("asyncpg")

    def _asyncpg_getattr(name: str):
        # 注解/基类需要真实类型对象；脚本只读路由元数据，不做 isinstance 判定，
        # 每次返回新类型无副作用。
        return type(name, (), {})

    asyncpg_stub.__getattr__ = _asyncpg_getattr  # type: ignore[attr-defined]
    sys.modules["asyncpg"] = asyncpg_stub

    workers_stub = types.ModuleType("workers")

    class WorkerEntrypoint:
        """占位：真身是 Cloudflare Workers Python 运行时入口。"""

    class _Asgi:
        @staticmethod
        async def fetch(app, request, env):  # pragma: no cover - 占位
            raise RuntimeError("asgi.fetch stub：导出器不跑服务器")

    workers_stub.WorkerEntrypoint = WorkerEntrypoint
    workers_stub.asgi = _Asgi()
    sys.modules["workers"] = workers_stub


def _import_worker_app():
    for p in (WORKER_SRC, BACKEND):
        if p not in sys.path:
            sys.path.insert(0, p)
    _install_stubs()
    import main as worker_main  # noqa: PLC0415 - 必须在 stub + sys.path 之后
    return worker_main


def _walk_dependants(dep):
    yield dep
    for sub in getattr(dep, "dependencies", None) or []:
        yield from _walk_dependants(sub)


def _dep_names(route) -> list:
    """顶层 Depends 调用名（不展开嵌套子依赖）。"""
    names = []
    for d in getattr(route.dependant, "dependencies", None) or []:
        call = getattr(d, "call", None)
        names.append(getattr(call, "__name__", None) or str(call))
    return names


def _uses(route, fn) -> bool:
    if fn is None:
        return False
    return any(getattr(d, "call", None) is fn for d in _walk_dependants(route.dependant))


_OPS_GATE_NAMES = {"_require_platform_ops", "_require_ai_admin"}


def _ops_via_source(endpoint) -> bool:
    """函数体内直接调用平台运营闸门（main/ws_admin_proposals 的惯例是
    handler 里写 _require_platform_ops(user)，不进 Depends 树）。"""
    try:
        text = inspect.getsource(endpoint)
    except (OSError, TypeError):
        return False
    return any(name + "(" in text for name in _OPS_GATE_NAMES)


# 域归属规则：按 path 前缀映射（为按域迁移排序用），从前到后命中即止。
# 域口径（计划 §2 列表 + 细化）：auth / customers / orders / quotes / trade-docs /
# files / intel / admin / cron + ai / outreach / teams / workstations（工位开通与
# 配置面）/ dashboard / meta。
_DOMAIN_RULES = [
    ("/health", "meta"),
    ("/api/v1/auth", "auth"),
    ("/api/v1/admin", "admin"),
    ("/api/v1/cron", "cron"),
    ("/api/v1/events", "cron"),                      # 事件归档 = cron 批处理产物
    ("/api/v1/customers", "customers"),
    ("/api/v1/customer/", "customers"),              # /customer/{id}/capabilities
    ("/api/v1/inquiries", "customers"),              # 询盘挂在客户域
    ("/api/v1/capabilities", "customers"),
    ("/api/v1/capability-", "customers"),           # /capability-customers（注意连字符）
    ("/api/v1/dashboard", "dashboard"),
    ("/api/v1/orders", "orders"),
    ("/api/v1/shipments", "orders"),                 # 自有出运台账
    ("/api/v1/actual-costs", "orders"),              # 实际采购成本
    ("/api/v1/payment-schedules", "orders"),
    ("/api/v1/receivables", "orders"),               # 收款（单证加固面）
    ("/api/v1/quotes", "quotes"),
    ("/api/v1/quotations", "quotes"),
    ("/api/v1/export-quote", "quotes"),
    ("/api/v1/quote-profiles", "quotes"),
    ("/api/v1/pricing-data", "quotes"),
    ("/api/v1/fx-rates", "quotes"),                  # 汇率进报价引擎
    ("/api/v1/product-tax-rates", "quotes"),         # 税率档案进报价引擎
    ("/api/v1/tax-archives", "quotes"),              # 税则归档进报价引擎
    ("/api/v1/trade-docs", "trade-docs"),
    ("/api/v1/external-docs", "trade-docs"),         # 外部单证上传
    ("/api/v1/clause-templates", "trade-docs"),      # 条款模板库
    ("/api/v1/intel", "intel"),
    ("/api/v1/market", "intel"),
    ("/api/v1/leads", "intel"),                      # 含 /leads/scan-replied
    ("/api/v1/leadgen", "intel"),
    ("/api/v1/research", "intel"),
    ("/api/v1/outreach", "outreach"),                # 邮件外发（市场工位子面）
    ("/api/v1/ai", "ai"),
    ("/api/v1/files", "files"),
    ("/api/v1/media", "files"),
    ("/api/v1/file-objects", "files"),
    ("/api/v1/teams", "teams"),
    ("/api/v1/workstations", "workstations"),
    ("/api/v1/me/workstations", "workstations"),
    ("/api/v1/subscriptions", "workstations"),       # 工位订阅
    ("/api/v1/users/", "workstations"),              # /users/{id}/subscriptions
    ("/api/v1/tenant-products", "workstations"),
    ("/api/v1/tenant-product-status", "workstations"),
    ("/api/v1/workstation-products", "workstations"),
    ("/api/v1/product-options", "workstations"),
    ("/api/v1/spec/", "workstations"),               # 产品定义配置化
    ("/api/v1/products", "workstations"),
    ("/api/v1/tenant/company-seals", "workstations"),
    ("/api/v1/tenant/company-profile", "workstations"),
    ("/api/v1/enums", "workstations"),               # 单证/工位枚举
    ("/api/v1/extras", "workstations"),
]


def _domain(path: str) -> str:
    for prefix, dom in _DOMAIN_RULES:
        if path.startswith(prefix):
            return dom
    return "misc"


def extract_routes(worker_main):
    from fastapi.routing import APIRoute  # noqa: PLC0415

    routes = []
    builtin = []
    for route in worker_main.app.routes:
        if not isinstance(route, APIRoute):
            methods = sorted(getattr(route, "methods", None) or [])
            builtin.append({"path": getattr(route, "path", str(route)), "methods": methods})
            continue
        methods = sorted(route.methods or [])
        try:
            file = os.path.relpath(inspect.getsourcefile(route.endpoint), BACKEND)
        except TypeError:
            file = "<unknown>"
        _, lineno = inspect.getsourcelines(route.endpoint)
        routes.append({
            "methods": methods,
            "path": route.path,
            "endpoint": route.endpoint.__name__,
            "file": file.replace(os.sep, "/"),
            "line": lineno,
            "depends": _dep_names(route),
            "auth": _uses(route, getattr(worker_main, "_get_current_user", None)),
            "ops": (
                any(
                    getattr(getattr(d, "call", None), "__name__", "") in _OPS_GATE_NAMES
                    for d in _walk_dependants(route.dependant)
                )
                or _ops_via_source(route.endpoint)
            ),
            "domain": _domain(route.path),
        })
    return routes, builtin


def _fmt_dep(dep: str) -> str:
    return "`" + dep + "`" if dep.startswith("_") else dep


def render_markdown(routes, builtin_routes) -> str:
    by_file = defaultdict(list)
    for r in routes:
        by_file[r["file"]].append(r)

    total = len(routes)
    method_rows = sum(len(r["methods"]) for r in routes)
    builtin_total = len(builtin_routes)  # 每条文档路由算 1 条（HEAD 是 Starlette 自动附加）
    domain_counts = defaultdict(int)
    for r in routes:
        domain_counts[r["domain"]] += 1

    lines = []
    lines.append("# W3 Phase 0 · 路由清单（Route Inventory）")
    lines.append("")
    lines.append("> 生成工具：`backend/ts-migration/export_routes.py`（打桩法 import worker main，只读路由元数据，不跑服务器）。")
    lines.append("> 口径：每行 = 一个 FastAPI APIRoute（method+path+endpoint）；一个 endpoint 挂多 method 算 1 条。")
    lines.append("> 排序：按文件分组、组内按源码行号。")
    lines.append("> 「平台运营」判定：Depends 树 ∪ handler 函数体静态扫描（_require_platform_ops( / _require_ai_admin(）。")
    lines.append("")
    lines.append("## 总数核对")
    lines.append("")
    lines.append("| 指标 | 数量 | 期望 | 结论 |")
    lines.append("|---|---|---|---|")
    grand = total + builtin_total
    ok = "✅ 一致" if grand == EXPECTED_TOTAL else "⚠️ 仍不符（差 %+d，需人工复查）" % (grand - EXPECTED_TOTAL)
    lines.append("| APIRoute 业务路由 | %d | — | — |" % total)
    lines.append("| FastAPI 内置（openapi/docs/redoc） | %d | — | — |" % builtin_total)
    lines.append("| **app.routes 合计** | **%d** | **%d** | **%s** |" % (grand, EXPECTED_TOTAL, ok))
    lines.append("| method×path 展开行数 | %d | — | 仅供参考 |" % method_rows)
    lines.append("")
    lines.append("> 核对说明：计划 §2 Phase 0 登记的 253 = app.routes 全部条目；其中 %d 条是 FastAPI 默认" % builtin_total)
    lines.append("> 挂载的文档路由（不参与业务迁移；TS 侧 Hono 是否镜像留给 Phase 1 决定）：")
    lines.append(">")
    for b in builtin_routes:
        lines.append("> - %s `%s`" % (", ".join(b["methods"]) or "(mount)", b["path"]))
    lines.append("")
    n_misc = domain_counts.get("misc", 0)
    if n_misc:
        lines.append("> ⚠️ 仍有 %d 条路由域归属为 misc，需人工确认规则。" % n_misc)
        lines.append("")

    lines.append("## 按域汇总（迁移排序用）")
    lines.append("")
    lines.append("| 域 | 路由数 |")
    lines.append("|---|---|")
    for dom, n in sorted(domain_counts.items(), key=lambda kv: (-kv[1], kv[0])):
        lines.append("| %s | %d |" % (dom, n))
    lines.append("")

    lines.append("## 按文件分组明细")
    for file in sorted(by_file):
        rows = by_file[file]
        lines.append("")
        lines.append("### `%s`（%d 条）" % (file, len(rows)))
        lines.append("")
        lines.append("| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for r in sorted(rows, key=lambda x: x["line"]):
            m = ", ".join(r["methods"])
            deps = ", ".join(_fmt_dep(d) for d in r["depends"]) or "—"
            auth = "✅" if r["auth"] else "—"
            ops = "✅" if r["ops"] else "—"
            lines.append(
                "| %s | `%s` | `%s` | :%d | %s | %s | %s | %s |"
                % (m, r["path"], r["endpoint"], r["line"], deps, auth, ops, r["domain"])
            )
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # 控制台 GBK 下中文不炸
    except Exception:
        pass
    worker_main = _import_worker_app()
    routes, builtin = extract_routes(worker_main)

    md = render_markdown(routes, builtin)
    out = os.path.join(HERE, "route-inventory.md")
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(md)

    total = len(routes)
    builtin_n = len(builtin)
    grand = total + builtin_n
    print("APIRoute 业务路由: %d；内置文档路由: %d；合计 %d（期望 %d）-> %s"
          % (total, builtin_n, grand, EXPECTED_TOTAL, "OK" if grand == EXPECTED_TOTAL else "MISMATCH"))
    for b in builtin:
        print("  builtin: %s %s" % (", ".join(b["methods"]) or "(mount)", b["path"]))
    by_file = defaultdict(int)
    by_domain = defaultdict(int)
    for r in routes:
        by_file[r["file"]] += 1
        by_domain[r["domain"]] += 1
    print("\n按文件:")
    for f, n in sorted(by_file.items()):
        print("  %4d  %s" % (n, f))
    print("\n按域:")
    for d, n in sorted(by_domain.items()):
        print("  %4d  %s" % (n, d))
    if by_domain.get("misc"):
        print("\nmisc 路径:")
        for r in routes:
            if r["domain"] == "misc":
                print("  %s %s (%s:%d)" % (", ".join(r["methods"]), r["path"], r["file"], r["line"]))
    print("\n写入: " + out)
    return 0 if grand == EXPECTED_TOTAL else 1


if __name__ == "__main__":
    sys.exit(main())
