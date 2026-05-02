# ─── Kaas v2 Backend Dockerfile ───
# v2 修正: 使用 uv + pyproject.toml 管理依赖（P0-3 修复）
# 本地优先部署（铁律4 客户数据主权）

FROM python:3.11-slim AS base

# 系统依赖
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl \
        && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 安装 uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# 依赖安装（利用 Docker 缓存层）
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

# 复制应用代码
COPY . .

# 暴露端口
EXPOSE 8000

# 健康检查（对应 /health 端点）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# 启动命令
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
