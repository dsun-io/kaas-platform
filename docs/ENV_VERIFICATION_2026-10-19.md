# 三环境配置与连接核对（2026-10-19）

> 目标态矩阵见 [README §2](../README.md)。本文记录**当前实测状态**：哪些已验证、哪些缺什么、
> 缺的东西由谁补（`U-*` 对应 [USER_ACTIONS_2026-10-19.md](archive/2026-10-20-closeout/USER_ACTIONS_2026-10-19.md)）。
> 结论（2026-10-20 更新）：**开发环境全通；生产只读验证通过（密钥/迁移待用户）；
> 预览环境已裁决全量做（S5），等用户提供 Neon/CF 凭据与资源后实施。**
> 技术栈基线：Next 16.4.2 / React 19.3 / ESLint 10.13 / TS 6.0.3 / CI Node 22（2026-10-20 升级）。

## 0. 汇总

| 环境 | 数据库 | 对象存储 | 运行时 | 迁移 head | 状态 |
|---|---|---|---|---|---|
| 开发 | 本地 Docker PG `kaas-postgres`（`kaas_local`，102 表） | 本地 MinIO（compose，未启动时相关测试 skip） | `local_run.py`（uvicorn，生产同一份 app） | `202610190020` | ✅ 已验证 |
| 预览 | 每 PR Neon 分支（脚本动态建） | `kaas-preview-storage`（✅ 已建） | preview workflow（✅ `feat/preview-env` 待合并） | — | ✅ S5 已实现，待合并 + variables/CF token |
| 生产 | Neon production（只读连接已验证；PG 18.6） | R2 `kaas-files`（binding `FILES`） | Worker `kaas`（api + assets） | `202610180010`（**待应用 020**） | ⚠️ 只读已验证（health/site 200）；密钥/迁移待用户 |

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

## 2. 预览环境（**S5 已全量实现 · 2026-10-20 · 分支 `feat/preview-env` 待合并**）

> 范围已定：每 PR Neon 子分支 + 独立 Hyperdrive + `kaas-preview-storage` + KV 前缀 + CI 防污染断言（S5）。
> 2026-10-20 用户裁决全量做；本日已落地并本机全链路实测（ensure→teardown 闭环）。
> 用法与变量契约见 [`scripts/preview/README.md`](../scripts/preview/README.md)。

| 需要 | 状态（2026-10-20 实测） |
|---|---|
| 共享 R2 桶 `kaas-preview-storage` | ✅ 已建（wrangler 实测，`r2 bucket list` 可见） |
| 预览 KV namespace `KAAS_PREVIEW` | ✅ 已建，id `c77ab8c9c3a3422aa09c2afdc33f6974` |
| 每 PR Neon 子分支 `preview-pr-<num>` | ✅ `scripts/preview/ensure.py`（从 production 派生 + 挂 read_write endpoint；**删除带双保险校验**：拒删根分支/production） |
| 独立 Hyperdrive `kaas-preview-<num>` | ✅ ensure 创建（origin.scheme=postgres，指向分支 pooler 主机）；teardown 回收 |
| preview workflow | ✅ `.github/workflows/preview.yml`（preflight 四项权限校验 → ensure → alembic → 构建（注入 workers.dev API URL）→ 部署 → PR 评论；closed → 全量回收） |
| S5-d 防污染断言 | ✅ `scripts/preview/assert-bindings.py` 对照线上真实绑定；生产模式对现网 `kaas` 阳性对照通过 |
| PR_SLUG 前缀 | ✅ `kaas_common.preview`（R2 `pr-<num>/`、KV `pr-<num>:`；空=生产零影响）+ /health 探针 |

**合并前待办**（用户/lead）：repo **variables** 4 个 = `KAAS_PREVIEW_KV_NAMESPACE_ID` /
`KAAS_PREVIEW_R2_BUCKET=kaas-preview-storage` / `PROD_R2_BUCKET=kaas-files`（现名，改名另立项）/
`PROD_HYPERDRIVE_ID=f53fed49705043008737032e4bfa2b8e`；CF token 换五权限 custom token（更新
`CLOUDFLARE_API_TOKEN` secret）；预览 worker secrets（JWT_SECRET 等）有则注入、无则告警。

**已知边界**：预览分支从生产派生 ⇒ 派生前的历史文件字节在预览桶里不存在（新上传正常）；
R2 对象级清理需 S3 密钥（teardown 不配则打印手动指引）；预览 worker 无 cron（渲染时剥离）。

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
