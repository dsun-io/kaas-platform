"""最小 Python Worker 探针（Cloudflare 工单 A4）。

目的：验证「Pyodide 实例初始化间歇失败」是否与我们的业务代码/依赖面有关。
本文件**不 import 任何 kaas 模块、不引入业务依赖** —— 启动路径 = 纯 Pyodide 初始化 + 一行 handler。

handler 契约（实测踩坑，2026-10-24）：
  · `python_workers` 下若没有可识别的 fetch handler，部署会报 10068
    "The uploaded script has no registered event handlers"；
  · 正确写法是 workers SDK 的 `WorkerEntrypoint` 子类 `Default` + `async def fetch(self, request)`
    （**只接 request**，带 env/ctx 会注册失败）。
"""
from workers import Response, WorkerEntrypoint


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return Response.json({"ok": True, "probe": "kaas-pyinit-probe"})
