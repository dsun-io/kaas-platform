"""本地开发入口（方案 B 阶段二 S4）：用 uvicorn 起**生产同一份 app**。

为什么需要它
------------
生产跑的是 `backend/worker/src/main.py`（Cloudflare Python Worker + asyncpg）；
本地开发此前跑 orchestrator 的 SQLAlchemy 版 app。方案 B 之后两者必须收敛为同一份
代码：本文件把 worker app 直接交给 uvicorn，并补上它依赖的运行时环境：

1. **`workers` 模块**：main.py 顶层 `from workers import WorkerEntrypoint`（只有
   Cloudflare 运行时才有）→ 本地用 stub（与 `backend/worker/tests/_bootstrap.py` 同法）。
2. **`request.scope["env"]`**：main.py 的 `_acquire` / `platform/db.py` 都从
   `request.scope["env"].HYPERDRIVE` 取连接参数、`_binding` 从同一 env 取 secrets。
   本地中间件注入一个 env 对象：HYPERDRIVE 指向本地 Docker PG，其余键透传 os.environ。

用法
----
```powershell
# 1) 本地 Docker PG（compose 里已定义）
docker compose up -d postgres
# 2) 首次建表（空库快径；与生产同一套 Alembic）
cd backend/orchestrator
$env:DATABASE_URL="postgresql+asyncpg://kaas:kaas_dev@localhost:5432/kaas_dev"
.venv/Scripts/python -m alembic upgrade head
# 3) 起 app（端口默认 8100，避免与旧 orchestrator 8000 冲突）
cd ../worker/src
$env:JWT_SECRET="local-dev-jwt-secret-at-least-32-chars!!"
$env:ADMIN_SETUP_TOKEN="local-setup-token"
$env:LOCAL_DATABASE_URL="postgresql://kaas:kaas_dev@localhost:5432/kaas_dev"
uv run --with uvicorn --with fastapi --with asyncpg --with pydantic --with pyjwt --with python-multipart --with bcrypt python local_run.py
```

注意：这是**开发便利入口**，不是生产部署路径；生产仍由 `pywrangler deploy` 打包
`main.py` 的 `Default(WorkerEntrypoint)`。
"""
from __future__ import annotations

import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent
# 关键：Python 启动时会把**脚本目录**放到 sys.path[0]，而 src/ 下有同名 `platform/`
# 目录（worker 的连接封装），会遮蔽标准库 platform ⇒ asyncpg 导入即 AttributeError。
# 所以先把它移出 sys.path、导入标准库，再放回。
sys.path[:] = [p for p in sys.path if Path(p or ".").resolve() != SRC]

import os  # noqa: E402
import platform  # noqa: E402,F401  （标准库；必须早于 asyncpg）
import types  # noqa: E402
from types import SimpleNamespace  # noqa: E402
from urllib.parse import urlparse  # noqa: E402

if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


def _install_workers_stub() -> None:
    """main.py 顶层 import `workers`（Cloudflare 运行时才有），本地用 stub。"""
    if "workers" in sys.modules:
        return
    workers = types.ModuleType("workers")

    class WorkerEntrypoint:  # main.py 只需可子类化
        pass

    workers.WorkerEntrypoint = WorkerEntrypoint
    workers.asgi = lambda app: app
    sys.modules["workers"] = workers


_install_workers_stub()

import main as worker_main  # noqa: E402  （必须在 stub 之后）


def _parse_db_url(raw: str) -> SimpleNamespace:
    url = urlparse(raw.replace("postgresql+asyncpg://", "postgresql://"))
    return SimpleNamespace(
        host=url.hostname or "localhost",
        port=int(url.port or 5432),
        user=url.username or "kaas",
        password=url.password or "",
        database=(url.path or "/kaas_dev").lstrip("/") or "kaas_dev",
    )


class _LocalEnv:
    """冒充 Worker env：HYPERDRIVE + secrets/vars（os.environ 透传）。"""

    def __init__(self) -> None:
        self.HYPERDRIVE = _parse_db_url(
            os.environ.get(
                "LOCAL_DATABASE_URL", "postgresql://kaas:kaas_dev@localhost:5432/kaas_dev"
            )
        )
        for key, value in os.environ.items():
            if not hasattr(self, key):
                setattr(self, key, value)


class _EnvMiddleware:
    """把本地 env 注入每个 HTTP 请求的 scope（等价于 asgi.fetch 注入 Worker env）。"""

    def __init__(self, app) -> None:
        self.app = app
        self.env = _LocalEnv()

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http":
            scope.setdefault("env", self.env)
        await self.app(scope, receive, send)


app = _EnvMiddleware(worker_main.app)


if __name__ == "__main__":
    import uvicorn  # 延迟导入：生产打包不会包含本地入口

    port = int(os.environ.get("PORT", "8100"))
    # 默认只监听回环（本机开发）；Docker 里需 0.0.0.0 才能从宿主机访问
    host = os.environ.get("HOST", "127.0.0.1")
    if os.environ.get("LOCAL_RELOAD") == "1":
        # reload 必须用 import string（uvicorn 会起子进程重新 import 模块）
        uvicorn.run("local_run:app", host=host, port=port,
                    log_level="info", reload=True, reload_dirs=[str(SRC)])
    else:
        uvicorn.run(app, host=host, port=port, log_level="info")
