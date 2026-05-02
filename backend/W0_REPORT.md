# Backend W0 · 基础设施脚手架 · 验收报告

> **阶段**: Backend W0 (Infrastructure Scaffold)
> **分支**: `feature/v2-refactor`
> **提交**: `feat(W0): backend infrastructure scaffold - v2 architecture`
> **日期**: 2026-05-02
> **Runner**: Antigravity + Claude Opus

---

## 一、交付物清单

### 1.1 目录结构（对标 v2 设计文档 §6.2）

```
kaas-platform/
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py                      # FastAPI 入口 + /health + /api/v1/ping
│   │   ├── config/
│   │   │   ├── __init__.py
│   │   │   ├── settings.py              # pydantic-settings 环境变量管理
│   │   │   └── tenant_config.py         # 多租户配置加载（cachetools.TTLCache）
│   │   ├── db/
│   │   │   ├── __init__.py
│   │   │   ├── base.py                  # SQLAlchemy DeclarativeBase
│   │   │   ├── models.py               # events / quotations / customer_capabilities
│   │   │   └── session.py              # AsyncSession 工厂 + FastAPI DI
│   │   ├── middleware/
│   │   │   ├── __init__.py
│   │   │   └── tenant.py               # TenantContextMiddleware (X-Tenant-Id)
│   │   ├── repositories/
│   │   │   └── __init__.py             # W1 实现
│   │   └── jobs/
│   │       └── __init__.py             # W2 实现
│   ├── alembic/
│   │   ├── env.py                       # asyncpg→sync 自动转换
│   │   ├── script.py.mako
│   │   └── versions/.gitkeep
│   ├── config/
│   │   └── tenants.yaml                 # 静态租户配置（Phase 1）
│   ├── docs/
│   │   └── schema-registry.md           # 飞轮 L0 事件注册表
│   ├── alembic.ini
│   ├── Dockerfile                       # python:3.11-slim + HEALTHCHECK
│   ├── requirements.txt
│   └── .env.example
├── shared/
│   └── contracts/
│       └── events.registry.md           # 与 backend/docs/ byte-equal
├── docker-compose.yml                   # PG + Redis + MinIO + Backend
└── .gitignore
```

### 1.2 文件数量统计

| 类别 | 文件数 |
|------|--------|
| Python 模块 | 12 |
| 配置文件 | 4 (yaml, ini, env, requirements) |
| Docker | 2 (Dockerfile, docker-compose.yml) |
| 文档 | 2 (schema-registry × 2 byte-equal) |
| **合计** | **20** |

---

## 二、五条铁律合规检查

| # | 铁律 | W0 落地情况 | 状态 |
|---|------|------------|------|
| 1 | AI 不做范围决策 | `tenant_config.py` 由代码层拼 datasetIds，`get_tenant_datasets()` 返回确定性映射 | ✅ |
| 2 | 报价不进向量库 | `quotations` 表在 PostgreSQL（models.py），无向量索引 | ✅ |
| 3 | 确定性优先 | 路由/权限/计费走代码（TenantContextMiddleware），LLM 仅在 `DEEPSEEK_*` 配置预留 | ✅ |
| 4 | 客户数据主权 | 本地 PG（非 Supabase），MinIO 本地归档，`.env.example` 管理密钥 | ✅ |
| 5 | 原始事件 INSERT-only | `events` 模型无 UPDATE/DELETE 方法，docstring 明确标注 INSERT-only | ✅ |

---

## 三、v2 已知修正点落实

| 修正项 | Phase 0 原文 | v2 修正 | 代码位置 | 状态 |
|--------|-------------|---------|----------|------|
| TTL 缓存 | `functools.lru_cache(ttl=...)` | `cachetools.TTLCache(maxsize=32, ttl=300)` | `tenant_config.py:12` | ✅ |
| 时间戳字段 | `occurred_at` | `created_at` | `models.py` 全部模型 | ✅ |
| 报价事件类型 | `quote.requested` | `quote.response` | `schema-registry.md` | ✅ |
| 事件存储 | Supabase | 本地 PostgreSQL `events` 表 | `models.py` + `docker-compose.yml` | ✅ |
| Python 版本 | 3.10 | 3.11-slim | `Dockerfile` | ✅ |
| OSS 归档 | 无 | MinIO 容器 | `docker-compose.yml` | ✅ |

---

## 四、Docker 环境

```yaml
# docker-compose.yml 服务清单
postgres:  16-alpine  (5432)  ← L4 quotations + L0 events
redis:     7-alpine   (6379)  ← L5 会话记忆
minio:     latest     (9000/9001) ← L0 OSS 归档
backend:   python:3.11-slim (8000) ← Orchestrator
```

所有服务配置了 `healthcheck`，`backend` 依赖 `postgres` 和 `redis` 健康后启动。

---

## 五、数据库 Schema（ORM 模型 · 对标 §3.5 / §3.7）

### events (L0 飞轮唯一入口)
- `schema_version INT NOT NULL DEFAULT 1`
- `tenant_id TEXT NOT NULL` — 多租户隔离
- `event_type TEXT NOT NULL` — chat.turn / quote.request / quote.response / ...
- `payload JSONB NOT NULL` — schema_version 控制字段集
- `sampled BOOLEAN` — trace 采样策略 (§3.7.3)
- **INSERT-only**，永不 UPDATE/DELETE

### quotations (L4 报价事实)
- 不存 `effective_to`（§3.5.2 彻底消除时间区间取错）
- `unit_price NUMERIC(10,4)` — NULL = 显式废止
- `spec_hash TEXT` — 规格哈希，配合 `effective_from DESC` 索引
- **INSERT-only**

### customer_capabilities (客户生产规格)
- `spec_constraints JSONB` — 权威数据源在 PG，L3 仅可读副本
- 支持 `updated_at` 因为是配置表非事实表

---

## 六、Schema 注册表

`backend/docs/schema-registry.md` 与 `shared/contracts/events.registry.md` **byte-equal**，
记录了 6 个 event_type 的 v1 字段集：
- `chat.turn` / `quote.request` / `quote.response` / `capability.update` / `kb.edit` / `audit.access`

CI 阶段将校验两份文件一致性（Phase 1 手动，Phase 2 自动化）。

---

## 七、尚未完成（W1 / W2 范围）

| 项目 | 计划阶段 |
|------|---------|
| 业务路由（/api/v1/orchestrate 等） | W1 |
| Repository 层（显式 tenant_id 注入） | W1 |
| Alembic 初始迁移生成 + 执行 | W1 |
| FastGPT 反向调用 HTTP client | W1 |
| 定时任务（OSS 归档 / L3 同步） | W2 |
| DeepSeek 话术包装集成 | W2 |

---

## 八、验收请求

David，W0 基础设施脚手架已完成。请验收以下关键点：

1. ✅ 目录结构是否符合你对 v2 §6.2 的预期
2. ✅ 五条铁律在代码层的落地方式是否认可
3. ✅ Schema 注册表的 6 个 event_type 字段集是否完整
4. ✅ Docker 环境（PG + Redis + MinIO）是否满足本地开发需求
5. ✅ tenants.yaml 的联佳配置结构是否合理

**验收通过后我将启动 W1 阶段**（业务路由 + Repository + Alembic 迁移执行）。
