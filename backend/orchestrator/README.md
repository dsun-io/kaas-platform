# kaas-orchestrator（S4 后：迁移与模型工具）

> **2026-10-19 S4 起，本目录不再包含可运行后端。**
> 生产与本地运行的唯一 app 是 `backend/worker/src/main.py`（本地入口
> `backend/worker/src/local_run.py`；方案 B 单应用）。

本包现在只负责两件事：

1. **`app/db/`**：SQLAlchemy 模型 —— 空库快径（`Base.metadata.create_all` +
   `alembic stamp head`）与 `alembic check` 的唯一真源；
2. **`alembic/`**：唯一 Schema 变更链（生产/预览/本地都只走这一条）。

## 常用命令

```powershell
cd backend/orchestrator
uv sync --extra migrations                      # 只装迁移依赖（sqlalchemy/alembic/psycopg2）
$env:DATABASE_URL="postgresql+asyncpg://kaas:kaas_dev@localhost:5432/kaas_dev"
uv run --extra migrations alembic upgrade head  # 建表 / 迁移
uv run --extra migrations alembic check         # models ↔ schema 零漂移
uv run --extra migrations pytest tests -q       # 222 条：内核纯函数 + 模型/schema 对齐
```

业务代码、API 测试、本地 uvicorn 入口均已删除；回退方式：`git revert <S4 提交>`。
测试处置见 `docs/S4_TEST_MIGRATION_2026-10-19.md`。
