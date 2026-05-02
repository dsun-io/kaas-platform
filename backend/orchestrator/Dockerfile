# ─── Kaas v2 Backend Dockerfile ───
# v2 修正: 使用 python:3.11-slim (非 3.10)
# 本地优先部署（铁律4 客户数据主权）

FROM python:3.11-slim AS base

# 系统依赖
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl \
        && rm -rf /var/lib/apt/lists/*

# 工作目录
WORKDIR /app

# 依赖安装（利用 Docker 缓存层）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制应用代码
COPY . .

# 暴露端口
EXPOSE 8000

# 健康检查（对应 /health 端点）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# 启动命令
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
