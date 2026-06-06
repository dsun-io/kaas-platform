# msg-router 部署指南

## 系统要求

- **操作系统**: Windows/Linux/macOS
- **Python**: 3.10+
- **内存**: 4GB+

## 安装步骤

### 1. 克隆仓库

```powershell
git clone https://github.com/davidsun0124/kaas-platform.git
cd kaas-platform/msg-router
```

### 2. 创建虚拟环境

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
```

### 3. 安装依赖

```powershell
pip install -r requirements.txt
```

### 4. 配置环境变量

```powershell
copy .env.example .env
# 编辑 .env 文件，设置 FASTGPT_API_KEY
```

### 5. 初始化数据库

```powershell
python -c "from app.logger_db import init_db; init_db()"
```

### 6. 启动服务

```powershell
python -m app
```

服务将在 http://localhost:8000 启动。

## 生产环境部署

### 使用 Uvicorn 直接启动

```powershell
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4
```

### 使用 Gunicorn (Linux)

```bash
gunicorn app.main:app -w 4 -k uvicorn.workers.UvicornWorker -b 0.0.0.0:8000
```

### 使用 Docker

```dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .
EXPOSE 8000

CMD ["python", "-m", "app"]
```

构建并运行：

```bash
docker build -t msg-router .
docker run -p 8000:8000 --env-file .env msg-router
```

## API 文档

启动后访问：

- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

### 主要端点

- `POST /v1/chat` - 处理买家消息，返回AI回复
- `GET /health` - 健康检查

## 性能优化

### 1. 降低延迟（配合RPA <5s目标）

编辑 `.env`：

```env
FASTGPT_TIMEOUT_SECONDS=10
API_WORKERS=4
```

### 2. 高并发配置

```env
API_WORKERS=8
```

### 3. 数据库优化

SQLite 默认适合中小规模。如需更高并发，考虑迁移到 PostgreSQL。

## 监控

### 查看日志

```powershell
tail -f data/conversations.db.log
```

### 健康检查

```powershell
curl http://localhost:8000/health
```

### 性能分析

使用 RPA 的 perf_analyzer 分析整体链路：

```powershell
cd ../rpa-qianniu
python scripts/perf_analyzer.py
```

## 常见问题

### FastGPT 调用超时

- 检查网络连接
- 增加 `FASTGPT_TIMEOUT_SECONDS`
- 启用 `CHAT_STUB_MODE` 临时绕过

### 数据库锁定

SQLite 并发写入限制。解决方案：
- 减少并发请求
- 迁移到 PostgreSQL

### 内存占用高

- 减少 `API_WORKERS`
- 定期重启服务

## 更新部署

```powershell
git pull origin main
pip install -r requirements.txt --upgrade
python -m app
```

## 联系支持

如有问题，请提交 Issue 到 GitHub 仓库。
