"""最小 Python Worker 探针（Cloudflare 工单 A4 + E2 依赖二分）。

用途
----
1. **E1**：零业务依赖时，Pyodide 初始化会不会失败？（已跑：不复现）
2. **E2 依赖二分**：逐档加上生产内核的依赖面（fastapi/pydantic → asyncpg → PyJWT/bcrypt），
   看「从哪一档开始」出现 init 失败、以及 startup 时间如何随包体增长。
3. **E3**：串行 vs 并发（重入假设）。

设计：同一个 handler 在模块导入期**尽力 import 所有已知重依赖**（缺哪个跳过），
并把「实际加载了哪些 + 各模块是否可用」放进响应 ⇒ 同一份源码可服务所有变体。

handler 契约（实测踩坑）：必须用 workers SDK 的 WorkerEntrypoint.Default + fetch(self, request)，
否则部署报 10068 "The uploaded script has no registered event handlers"。
"""
import importlib

from workers import Response, WorkerEntrypoint

# 生产内核的主要依赖面（顺序 = 由轻到重；缺包时跳过，便于同一源码服务 E2 各档）
HEAVY_MODULES = ("fastapi", "pydantic", "asyncpg", "jwt", "bcrypt", "multipart")

LOADED: list[str] = []
FAILED: dict[str, str] = {}
for _name in HEAVY_MODULES:
    try:
        importlib.import_module(_name)
        LOADED.append(_name)
    except Exception as _exc:  # noqa: BLE001 - 缺包属预期（E2 各档不同）
        FAILED[_name] = type(_exc).__name__

PAYLOAD = {
    "ok": True,
    "probe": "kaas-pyinit-probe",
    "loaded": LOADED,
    "missing": sorted(FAILED),
}


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        # 加一个极小的 CPU 动作，确保 handler 真的在 Python 侧跑过
        return Response.json({**PAYLOAD, "n": sum(range(50))})
