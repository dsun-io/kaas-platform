"""worker 测试统一起手式：stub `workers` + **彻底重载** main 及其路由模块。

为什么必须放在共享模块里
------------------------
worker 的每个路由模块都是「`import main as _main` 然后往 `_main.app` 上注册路由」。
如果测试只 `sys.modules.pop("main")` 再重新 import，会得到**新的 app 实例**，
但子模块仍在 `sys.modules` 里缓存着 —— `import ws_shipments` 拿回旧模块，
它的路由注册在**旧 app** 上，新 app 里一条都没有。
表现是「路由明明写了，测试却说未注册」，且只在多个测试文件同时收集时出现
（单独跑某个文件反而是绿的）—— 极难排查。

所以：**凡是加载 main 的测试文件，一律走 `load_main()`**，别自己 pop。
"""
from __future__ import annotations

import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

# main 直接或间接 import 的全部同级模块（路由 + cron 等；新增模块请登记到这里）
_SIBLING_MODULES = (
    "main",
    "chain",
    "quote_api",
    "ws_extras",
    "ws_products",
    "ws_seals",
    "ws_enums",
    "ws_shipments",
    "ws_docs_ext",
    # A7-2 单证加固 HTTP 层（事实/一致性/lint/收款/清单/导出自检）：
    # 由 main 与 ws_docs_ext 共同引用，必须一起重载，否则新 app 上缺这些路由。
    "ws_docs_hardening",
    # A5-W1 条款模板库（团队级 CRUD + 懒种子）
    "ws_clause_templates",
    "ws_quote_ext",
    "ws_crm_ext",
    "ws_teams",
    # 团队加入申请（2026-10-22）：注册时团队已存在 → 申请 + 管理员审核
    "ws_join_applications",
    "ws_workstations",
    "ws_admin_accounts",
    "ws_admin_proposals",
    "ws_customer_records",
    "ws_option_overrides",
    "ws_files",
    "tax_archives",
    # Cloudflare Cron 任务（main 末尾 import；scheduled 钩子调它）
    "ws_cron",
)


def load_main():
    """返回一个干净、自洽的 main 模块（其 app 上注册了全部路由）。"""
    workers = types.ModuleType("workers")

    class _WorkerEntrypoint:  # main.py 只需可子类化
        pass

    workers.WorkerEntrypoint = _WorkerEntrypoint
    workers.asgi = lambda app: app
    sys.modules.setdefault("workers", workers)

    for name in _SIBLING_MODULES:
        sys.modules.pop(name, None)

    import main  # noqa: PLC0415

    return main
