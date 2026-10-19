# 三环境配置与连接核对（2026-10-19）

> 目标态矩阵见 [README §2](../README.md)。本文记录**当前实测状态**：哪些已验证、哪些缺什么、
> 缺的东西由谁补（`U-*` 对应 [USER_ACTIONS_2026-10-19.md](./USER_ACTIONS_2026-10-19.md)）。
> 结论：**开发环境已全通；生产读写面可用（只读已验证，写/密钥面待用户只读核对）；预览环境未落地（S5 待决策）。**

## 0. 汇总

| 环境 | 数据库 | 对象存储 | 运行时 | 迁移 head | 状态 |
|---|---|---|---|---|---|
| 开发 | 本地 Docker PG `kaas-postgres`（`kaas_local`，102 表） | 本地 MinIO（compose，未启动时相关测试 skip） | `local_run.py`（uvicorn，生产同一份 app） | `202610190020` | ✅ 已验证 |
| 预览 | 每 PR Neon 分支（**未建**） | `kaas-preview-storage`（**未建**） | preview workflow（**未建**） | — | ❌ 未落地（S5 待 U-E1 决策） |
| 生产 | Neon production（只读连接已验证；PG 18.6） | R2 `kaas-files`（binding `FILES`） | Worker `kaas`（api + assets） | `202610180010`（**待应用 020**） | ⚠️ 只读已验证；密钥/迁移待用户 |

## 1. 开发环境（已验证）

| 项 | 证据（本轮实跑） |
|---|---|
| PG | `docker ps` → `kaas-postgres Up (healthy)`；`kaas_local`：`102` 张表、`alembic_version=202610190020` |
| 建表 | 空库 `uv run --extra migrations alembic upgrade head` → 102 表；`alembic check` → no new operations |
| 运行时 | `python local_run.py`（uvicorn）→ `/health` 200；bootstrap/login 200（扁平 11 键）；建客户 201；报价/订单/应收列表 200；`export-quote/products` 200 |
| 容器 | `docker build -f backend/worker/Dockerfile.local` → `kaas-backend-local:test`（319MB）；`docker run` 连宿主 PG，`/health` HTTP 200 |
| 测试 | worker **954 passed + 5 skipped**（真 PG 集成 5 条：`tests/integration`，需 `TEST_DATABASE_URL`） |
| MinIO | compose 定义（`kaas-dev` 桶）；本地未启动 MinIO 时 `tests/integration` 不依赖它；涉及 S3 的 `test_files_s3.py` 是纯计算交叉验签，不依赖服务 |

**开发环境缺口（非阻塞）**：`backend/worker/.dev.vars` 不存在（`wrangler dev` 冒烟需要
`JWT_SECRET`/`ADMIN_SETUP_TOKEN`）；本地 `uv` 的 pyodide 解释器探针损坏 ⇒
`pywrangler deploy --dry-run` 在本机不可用（CI 可跑，见 S6-c）。

## 2. 预览环境（未落地）

| 需要 | 当前 | 缺什么 / 谁补 |
|---|---|---|
| 每 PR Neon 子分支 | 无 | Neon API key + 分支创建/回收逻辑（S5-b，代码可做；需 U-E1 决策） |
| 独立 Hyperdrive config | 无（仅生产 `f53fed49705043008737032e4bfa2b8e`） | CF API token + 创建/删除（S5-b） |
| R2 `kaas-preview-storage` + `pr-<slug>/` 前缀 | 无（仅 `kaas-files`） | 建桶 + 授权（U-E1） |
| 预览 KV namespace | 无（生产也无 KV 绑定） | 若目标态需要，S5-c |
| preview workflow + 防污染断言 | 无 | S5-a/S5-d（代码可做，依赖上面资源决策） |

> ⚠️ README §2.2/2.3 已标注「预览 = 目标态、未实施」，避免有人按矩阵手工搭半个环境。

## 3. 生产环境（只读已验证，写面待用户）

| 项 | 证据 / 缺口 |
|---|---|
| Worker 存活 | `GET https://api.kaas.powervoy.com/health` → 200（`service=kaas-intel-worker`，`shared.loaded=true`）；`https://kaas.powervoy.com/` → 200 |
| Hyperdrive | `wrangler.jsonc` binding `HYPERDRIVE.id = f53fed49705043008737032e4bfa2b8e`（与矩阵一致） |
| Neon | 只读 DSN（`.env.local` → branch production）连接成功；此前实测 PostgreSQL 18.6、102→109 表视图（见 SECURITY_AUDIT §6） |
| 迁移 head | 生产 `alembic_version = 202610180010`；**`202610190020` 尚未应用**（列已存在、幂等迁移，发布或手动 migrate 时安全应用） |
| R2 | binding `FILES.bucket_name = kaas-files`（与目标态 `kaas-prod-storage` 不一致 → U-S6 决策） |
| Worker secrets | **仓库无法证实**（需 `npx wrangler secret list --name kaas`，U-S3）：`JWT_SECRET`/`ADMIN_SETUP_TOKEN`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`/`RESEND_API_KEY` |
| 定时任务 | `wrangler.jsonc` crons：`*/15 * * * *`、`30 16 * * *`（2 个，S3 已重建；生产是否已部署该版本取决于上次 deploy） |
| 自动迁移 | `deploy.yml` migrate job 需 secret `PROD_DATABASE_URL`（U-S7）；未配置则手动迁移 |

## 4. 发布前检查单（等你指令后执行）

1. `cd backend/orchestrator; DATABASE_URL=<PROD_DATABASE_URL> uv run --extra migrations alembic upgrade head`
   → 期望 head `202610190020`（幂等，生产列已存在）。
2. `cd backend/worker; npx pywrangler deploy`
   （Actions 限额；本机 `pywrangler sync` 的 pyodide 探针损坏 ⇒ 若本机失败，改用 CI 手动 dispatch）。
3. 冒烟：`/health` 200、登录、客户列表、`export-quote/products`、crons 在 Dashboard 可见。
4. 回滚预案：**Neon 分支/PITR**（历史链不支持 `downgrade base`，见
   [MIGRATION_DOWNGRADE_AUDIT](./MIGRATION_DOWNGRADE_AUDIT_2026-10-19.md) 实测节）。
5. 记录：更新 `PROBLEM_STATUS` + 本文件「迁移 head / 部署版本」两行并 push。
