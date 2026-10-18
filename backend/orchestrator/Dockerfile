# ─── Kaas v2 Backend Dockerfile ───
# 构建上下文 = `backend/`（见根目录 docker-compose.yml），因为 orchestrator
# 运行期要 import 共享内核 `backend/kaas_common`（G1：orchestrator / worker 一份代码）。
# 旧版上下文是 `backend/orchestrator`，`kaas_common` 根本没进镜像 ⇒
# 容器启动即 `ModuleNotFoundError: No module named 'kaas_common'`（2026-10-18 修复）。

FROM python:3.11-slim AS base

# 系统依赖（curl 供 compose healthcheck 用）
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl \
        && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 安装 uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# 依赖装进**独立 venv**（/opt/venv）：/app 会被 bind mount 覆盖成宿主代码，
# 放在 /app/.venv 会被宿主目录遮蔽/污染（旧 compose 的匿名卷还会残留旧依赖）。
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    PATH="/opt/venv/bin:$PATH"

# 依赖安装（利用 Docker 缓存层）：锁文件与 pyproject 放在 orchestrator/ 下
COPY orchestrator/pyproject.toml orchestrator/uv.lock orchestrator/README.md ./
RUN uv sync --frozen --no-dev

# 复制应用代码 + 共享内核
COPY orchestrator/ ./
COPY kaas_common /kaas_common

# `kaas_common` 在 /kaas_common（不在 /app 下，避免被 orchestrator 的 bind mount 覆盖）
ENV PYTHONPATH=/app:/kaas_common

# 暴露端口
EXPOSE 8000

# 健康检查（对应 /health 端点）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# 启动命令（Alembic 迁移 + uvicorn）。
# 开发容器开 --reload：/app 是宿主的 bind mount，改代码即生效（单 worker）。
CMD ["sh", "-c", "alembic upgrade head && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"]
