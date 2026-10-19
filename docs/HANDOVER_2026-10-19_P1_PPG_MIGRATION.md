# 交接文档 · 2026-10-19 检查点：P1 生产库迁 PPG（峰值时段暂停）

> **状态：迁移进行到 70%，停在"schema 漂移未清零"这个检查点；生产仍跑 Neon，未切换、未部署。**
> 本文写给**另一台设备上的 DSH 会话**接手用：状态、证据、下一步顺序、权限获取方式、
> 已知风险全在这里。先读本文，再读 `docs/MASTER_EXEC_PLAN_2026-10-19.md` 了解全局。
> 分支：`feat/convergence-aprime`（worktree：`.agents/worktrees/feat/convergence-aprime`）。

---

## 0. 一句话状态

PPG（Prisma Postgres）库已创建、schema 已建（**114 表**）、**数据已全量复制且行数 100% 一致**
（108 表 + 2 张漂移表补拷）、Hyperdrive 新配置已建、`wrangler.jsonc` 已切 id——
**但 schema 的约束/索引/列属性仍有明显漂移（见 §3），所以不能切生产流量。**
生产 Worker 仍连 Neon（Hyperdrive `f53fed…`），一切照旧。

## 1. 已完成（按时间顺序，均可从 commit 复现）

| # | 事项 | 证据 |
|---|---|---|
| 1 | **P0 POC 否决路线 A**：greenlet 无 wasm wheel ⇒ `sqlalchemy.ext.asyncio` ImportError；冷启动 +1854ms | `docs/POC_WORKER_SQLALCHEMY_2026-10-19.md`（main `cb25bd6`） |
| 2 | 方向转 **A′ + C 子集**；两个 POC Worker 已删除 | PROBLEM_STATUS 2026-10-19 条目 |
| 3 | **C 子集完成**：worker 真 PG 写入路径测试 5 条（注册/bootstrap-admin/客户/报价） | 分支 `3ada691`；`python -m pytest backend/worker` = 308 passed |
| 4 | `session.py` SSL 判定去 Neon 硬编码（通用化） | 分支 `a3860f6` |
| 5 | **空库建表根因修复**：`alembic/env.py` 补 import 5 个模型模块（此前空库只建 61 表，漏 `cust_contacts` 等） | 本文档同次提交（分支） |
| 6 | **PPG 库创建**：Prisma CLI 非交互 | project `kaas-platform` / db `kaas-prod` / PG17.2 / us-east-1 |
| 7 | **PPG schema**：快径建 93 模型表 + 补建 20 张 worker 独有/legacy 表 → **114 表** | 见 §3 校验输出 |
| 8 | **数据复制**：CSV 并发复制 108 表 + 2 张补拷；序列 setval 102 个 | 行数 0 不一致 |
| 9 | **Hyperdrive**：`kaas-ppg` = `1733fcd80736482e8ec6e7648ed52286`（直连 `db.prisma.io`）；`wrangler.jsonc` 已切 | 分支未合 main |

## 2. 当前环境与真实状态

```
生产（未变）：Worker kaas → Hyperdrive f53fed… → Neon PostgreSQL 18.6
迁库目标（已就绪 70%）：Worker kaas → Hyperdrive 1733fcd… → PPG 17.2 (us-east-1)
迁移中间态：PPG 已有 109 生产表 + 5 张「新命名」表（models 有、生产无）+ pg_stat_statements
```

- PPG 表数 114（= 109 生产表 + 5 张新命名表 + 无 alembic 差异），**生产缺的表一张不缺**；
- 行数校验：**108 张表全部一致（0 mismatch）**；2 张漂移表已补列并补拷（见 §3）；
- `alembic_version = 202610180010`（与生产一致）；
- 序列：102 个 `setval` 完成。

## 3. 阻塞项：schema 漂移（必须清零才能切）

2026-10-19 校验（`scripts/migrate-ppg/05_verify_ppg_vs_neon.py`）输出：

| 指标 | Neon(生产) | PPG | 结论 |
|---|---|---|---|
| 表 | 109 | 114 | PPG 多 5 张「新命名」表（`order_quote_refs` 等，models 有生产无）→ 属无害冗余 |
| 行数 | — | — | **0 不一致 ✅** |
| 约束 | **1015** | **190** | ❌ **缺 852 个**（create_all 只建了部分 PK/唯一；生产里的 check/fk 大量缺失） |
| 索引 | **313** | **281** | ❌ 缺 50 个 |
| 列属性差异 | — | — | 33 处（类型/`NOT NULL`/默认值，如 `trade_docs.status`、`tenant_products.cost_field`、`tax_archives.tax_values`、`*_items.sort_order`） |

原因：93 张模型表走 `create_all` 快径，得到的约束/索引远少于生产历史累积的 DDL；
补建的 20 张表已从生产目录精确复制（约束/索引齐全），漂移集中在**模型表**。

**下一步（按序）**：
1. 写 `02_align_schema.py`：从 Neon 目录读取「模型表」的全部约束/索引/列属性，
   对 PPG 做 diff → 生成 `ALTER TABLE … ADD CONSTRAINT/DROP+ADD COLUMN（带 USING 转换）`；
   类型/默认/`NOT NULL` 差异优先按「改 PPG 对齐生产」处理（PPG 无业务流量，安全）。
2. 复跑 `05_verify_ppg_vs_neon.py`，要求：约束/索引差 = 0（或逐条白名单化并写进本文）。
3. Worker 冒烟（**不切生产**）：`npx wrangler dev` + `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`
   指向 PPG 直连 → 登录/注册/建客户/报价 4 条写入路径。
4. 合并分支到 main（触发 CI 部署）→ 生产冒烟（DEPLOY.md §0.2：`/health` JSON、
   `/api/v1/*` 401、`/login` 200、注册、建客户、报价）→ 观察 30 分钟。
5. 回滚预案：把 `wrangler.jsonc` 的 hyperdrive id 改回 `f53fed49705043008737032e4bfa2b8e`
   重新部署即可（Neon 数据未动）。
6. 稳定 30 天后：Neon production 分支改名 `kaas-prod-neon-legacy` 保留，到期删除。

## 4. 权限 / 凭据获取（换设备必看）

> **`.env.local` 是 gitignored，不随仓库走。** 新设备需重新生成或从安全渠道拷贝。

### 4.1 Prisma（PPG）
- 账号：**dspro0124@163.com**（GitHub 登录），workspace `Personal workspace`
- 项目：`kaas-platform` = `proj_uwe01gaebpmbkxwiio388f8e`
- 数据库：`kaas-prod` = `db_xe7ypplcbxq3ysghz93k3n8u`（PG **17.2**，`us-east-1`，ready）
- 登录 CLI：`npx prisma@latest auth login`（浏览器 OAuth；本机已验证可用）
- **取新连接串**（每设备各自一份，只打印一次）：
  ```bash
  npx prisma@latest postgres connection create kaas-prod --name <设备名>
  # 输出形如 postgres://<user>:<pass>@pooled.db.prisma.io:5432/postgres?sslmode=require
  # ⚠️ Accelerate（pooled.db.prisma.io）已进入停用倒计时：把 host 换成 db.prisma.io 用直连
  ```
- 写入 `.env.local`：`DATABASE_URL_PPG=postgres://...@db.prisma.io:5432/postgres?sslmode=require`
- 无浏览器环境：设 `PRISMA_SERVICE_TOKEN`（Console 生成）

### 4.2 Cloudflare
- 账号：`Dspro0124@163.com's Account`，ID **`766f8d7eb5a7d20e272673073ec8c3fd`**
- 登录：`pywrangler login`（OAuth，等价 `wrangler login`）
- Hyperdrive：**旧（Neon）`f53fed49705043008737032e4bfa2b8e`**；**新（PPG）`1733fcd80736482e8ec6e7648ed52286`**
- 重建命令（如配置丢失）：
  ```bash
  cd backend/worker
  pywrangler hyperdrive create kaas-ppg --connection-string="<PPG 直连 DSN>"
  ```

### 4.3 Neon（回滚用，勿删）
- 项目 `falling-salad-31662168`；生产/开发分支 DSN 在 `.env.local` 的 `DATABASE_URL`（带引号，读取要 strip 引号）

### 4.4 本机工具链（原设备实测，新设备可参考）
- 无 `pwsh`（只有 PowerShell 5.1）；`pnpm` 在
  `C:\Users\河北慷逊公司\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs`
  （⚠️ 不是旧文档写的 `node\pnpm\bin\pnpm.mjs`）
- node：`...\dependencies\node\bin\node.exe`；npx：`C:\Program Files\nodejs\node_modules\npm\bin\npx-cli.js`
- orchestrator venv：`backend/orchestrator/.venv`（psycopg2/alembic 都在）；worker 测试用**系统 python**（含 pytest 9.1.1）
- **无 Docker / 无 WSL / 无 pg_dump**：迁移用「alembic 快径建表 + CSV COPY」而不是 pg_dump
- PPG 区域 us-east-1：**单条 DDL/COPY 往返约数秒**，批量操作要有耐心或并发（脚本已用 6 线程）

## 5. 迁移脚本（`scripts/migrate-ppg/`）

| 脚本 | 用途 |
|---|---|
| `01_reset_ppg_schema.py` | 清空 PPG public schema（**只在重建时用**） |
| `03_copy_data.py` | 并发 CSV 复制全部表 + setval + 行数校验（可重复执行） |
| `04_fix_schema_drift.py` | 补 `market_ports`/`trade_docs` 漂移列并补拷（已执行完） |
| `05_verify_ppg_vs_neon.py` | 全量校验：表/列/约束/索引/行数（**当前唯一判据**） |

> 02（补建 20 张非模型表的脚本）是一次性执行的，未保留；如需重建，依据：
> 表清单 = `information_schema` 中 Neon 有而 `Base.metadata` 无的表（20 张，见 §3 提及），
> 用 `pg_get_constraintdef` / `pg_indexes.indexdef` 从生产目录复制。

## 6. 全局待办（按优先级，详见 MASTER_EXEC_PLAN）

1. **P1 收尾**（本文档 §3 的 6 步）——最高优先级，卡在 schema 对齐；
2. **P2 预览环境**：CF 预览部署（免费档已确认可用）+ Neon dev 分支做预览库；
   注意：预览环境从空库建必须走已修复的 `env.py`（否则缺表 500）；
3. **P3**：A′（SQL/DDL 内核同源）+ C 子集（真 PG 测试已交付，CI job 待验证）；
4. **批次 6**：技术栈安全债（Next 15.5+/16 等），排在收敛后；
5. 批次 U（用户操作：R2 key 重建、生产 product_tax_rates 配置、仓库 private、智能表格补全）。

## 7. 风险登记

| # | 风险 | 现状/缓解 |
|---|---|---|
| R1 | PPG 免费档 20 万 ops/月 | 迁移期 COPY/DDL 已消耗部分额度；上线后按真实流量评估 |
| R2 | Accelerate 停用 | 一律用 `db.prisma.io` 直连（Hyperdrive 池化） |
| R3 | us-east-1 延迟 | Worker（边缘）→ Hyperdrive → us-east-1；迁移期感知慢，运行时由 Hyperdrive 池化缓解 |
| R4 | PPG 无自动备份（免费档） | 上线前用 CSV 导出做一次冷备；后续按 PROD_DB_OPTIMIZATION_PLAN §2.2 落 R2 备份链 |
| R5 | 5 张「新命名」表只在 PPG 侧存在 | 无害（生产本就没用）；切流量前与 worker 代码核对确认未被引用 |
| R6 | 回滚 | 改回 Hyperdrive `f53fed…` 重部署即回 Neon（数据未动） |
