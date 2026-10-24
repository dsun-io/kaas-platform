"""最小 Python Worker 探针（Cloudflare 工单 A4）。

目的：验证「Pyodide 实例初始化间歇失败」是否与我们的业务代码/依赖面有关。
本文件**不 import 任何 kaas 模块、不引入任何第三方依赖** —— 它的启动路径就是
「纯 Pyodide 初始化 + 一行 handler」，用于回答：去掉我们的代码之后还崩不崩？
"""
from workers import Response, WorkerEntrypoint


class Default(WorkerEntrypoint):
    async def fetch(self, request, env, ctx):
        return Response.json({"ok": True, "probe": "kaas-pyinit-probe"})
