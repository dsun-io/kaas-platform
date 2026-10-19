# KaaS Platform

> **Knowledge as a Service** —— 面向传统制造业的外贸业务平台。
> 以「工位（Workstation）」为交付单元，把客户/询盘、报价、订单、出运、单证、税务、情报与 AI 能力串成一条可追溯的业务链。

- 生产站点：`https://kaas.powervoy.com`
- 生产 API：`https://api.kaas.powervoy.com`
- 本地前端：`http://localhost:3000`
- 本地后端：`http://localhost:8000`（`/health`、`/docs`）

---

## 1. 当前架构

```
浏览器
  │
  ▼
Cloudflare Worker "kaas"（单 Worker）
  ├─ kaas.powervoy.com      前端静态页面 + /api/v1/*
  ├─ api.kaas.powervoy.com  仅 API
  │
  │  /api/*、/health → Python FastAPI（Workers Python runtime）
  │  其余            → Next.js 静态导出资产
  │
  ▼ Hyperdrive
Neon PostgreSQL（production / dev 分支）

本地开发：
Docker Compose（Postgres + Redis + MinIO + orchestrator）
  + frontend `next dev` → http://localhost:3000
```

- **生产**：`backend/worker`（Python FastAPI + 原生 asyncpg + 静态资产，单 Worker）。
- **本地/迁移**：`backend/orchestrator`（SQLAlchemy + Alembic，负责开发环境与数据库迁移）。
- **共享内核**：`backend/kaas_common` 是唯一源，`scripts/sync-shared.ps1` 同步到 Worker 的 `src/kaas_common/`（不进版本控制）。
- **共享契约**：`shared/contracts/*.ts`（zod），前后端与契约检查共用。

---

## 2. 当前业务模块

| 工位 | 状态 | 说明 |
|---|---|---|
| 进出口情报 | 已上线 | 海关/贸易数据、货运记录、竞争格局 |
| 市场调研 | 已上线 | 从地图源挑选并深化（品类/价格/观察/能否提供） |
| 地图源客户信息获取 | 已上线 | Google Places 拓店铺 + 爬官网提产品 + CSV 导入 |
| 线索池 | 已上线 | `lead_candidates` 共享池，工位间唯一通信接口 |
| 客户/询盘 | 已上线 | 客户阶段、询盘三态（未报价/已报价/已关闭）、询盘编号 |
| 报价 | 已上线 | 多产品算价、成本手填、产品税率、整单保险、批量报价 |
| 订单 | 已上线 | 报价转化、状态机、应收/付款计划、汇兑损益 |
| 外贸单证 | 已上线 | 报价/订单/询盘生成 PI、CI、PL 等，快照留档 |
| 出运台账 | 已上线 | 出运记录、单号、订单关联 |
| 税务管理 | 已上线 | 企业税档（销项/杂税）+ 产品税率（进项/退税） |
| AI 层 | 已上线 | BYOK Provider、任务模板、用量审计 |
| 客户触达 | 已上线 | 邮箱/campaign/发送/重发 |

---

## 3. 本轮（2026-10-18）上线内容

### 3.1 税务档案

税务管理分两块：

1. **企业税档**：销项增值税、杂税（印花税已含在杂税里）；
2. **产品税率**：进项增值税、出口退税率，按产品逐条维护；
   - 同一团队同一产品只能一条；
   - 已配置的产品不会在下拉里重复出现；
   - 税变化时在一个页面统一改。

报价时：

- 企业税档带销项税、杂税；
- 每行按产品带进项税、出口退税率；
- 报价单保存 `tax_snapshot`，其中 `product_taxes` 保留当时各产品税率。

### 3.2 成本

- **所有报价行成本必须手填**；
- 历史报价只作为参考显示，必须点「应用参考成本」才带入；
- 不会自动套用产品定义里的默认成本；
- 未填成本不能算价、不能保存；后端保存报价时也会校验。

### 3.3 整单保险

- 仅对 **CIF / DAP / DDP** 生效；
- 公式：`保险费 = 整单 EXW 货值 × 1.1 ÷ 1000`，**最低 15 美元**；
- 整单只算一次，按各报价行 EXW 货值比例分摊；
- 报价页保险项显示“自动计算”，不要求手填；
- 后端 `/export-quote/calculate` 回传 `meta.term_totals` 供前端两轮计算。

### 3.4 批量报价

- 报价工位 → 批量报价页；
- 选客户 → 选询盘 → 统一产品/规格/成本/件数 → 生成报价单；
- 单批最多 200 行；
- 同一询盘允许多张报价，默认最新一张；某张生成后续单证后，同询盘其他报价转 `closed`；
- 未配置产品税率的产品会被拦截，提示先到税务管理配置。

### 3.5 其他口径

- 船公司固定选项，格式「中文名-英文缩写」（如 `马士基-MSK`、`地中海航运-MSC`、`中远海运-COSCO`）；
- 客户按米报需求时，报价行可填米数，系统按“每卷米数”自动换算卷数，**小数进一**；
- 编号格式：`类型-国家-客户-时间戳`，例如 `INQ-US-TIM-20261018111149`、`QUO-US-TIM-...`、`PI-...`、`SHP-...`；
- 国外费用美元、国内费用人民币，按报价汇率折算。

---

## 4. 本地开发

### 4.1 启动

```powershell
# 根目录
docker compose up -d          # Postgres / Redis / MinIO / orchestrator
# backend 启动时自动 alembic upgrade head

# 健康检查
curl http://localhost:8000/health

# 前端（另一个终端）
cd frontend
pnpm install
pnpm dev                      # http://localhost:3000
```

前端 `.env.development` 默认：

```env
NEXT_PUBLIC_API_MODE=real
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
```

只想用 mock（无需后端）：把 `NEXT_PUBLIC_API_MODE` 改为 `mock`。

### 4.2 后端单独启动

```powershell
cd backend/orchestrator
uv venv
uv sync
uv run alembic upgrade head
uv run python scripts/seed_dev.py
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 4.3 本地登录账号

> 仅本地开发库，由 `scripts/seed_dev.py` 创建；**生产没有这些账号**。

| 角色 | 邮箱 | 密码 |
|---|---|---|
| 系统管理员 | `admin@kaas.local` | `DevAdmin2026!` |
| 联佳业务员（团队 1） | `lianjia@kaas.local` | `Lianjia2026!` |
| 客户 B 业务员（团队 2） | `clientb@kaas.local` | `Clientb2026!` |
| 本地验收账号 | `e2e.local@kaas.local` | `LocalDev123!` |

登录：`http://localhost:3000/login`。API 文档：`http://localhost:8000/docs`。

> 注意：`http://localhost:8000/` 根路径返回 401 是正常的；健康检查用 `/health`。

---

## 5. 测试与门禁

```powershell
# 后端单测
cd backend/orchestrator
$env:PYTHONPATH=".;.."
.venv\Scripts\python.exe -m pytest tests -q -m unit

# Worker 单测
cd backend/worker
uv run --frozen --with pytest --with httpx2 python -m pytest tests -q

# 前端
cd frontend
pnpm typecheck
pnpm lint
pnpm test

# 共享内核同步与检查
powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1
powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1 -Check

# 契约 / 路由对等
pnpm contracts:check
python scripts/route-parity.py

# 静态导出
$env:NEXT_EXPORT="1"
$env:NEXT_DIST_DIR=".next-verify"
pnpm build
```

当前基线（2026-10-18）：

- orchestrator：**1202 passed**
- worker：**287 passed**
- frontend：**452 passed**
- typecheck / lint / build / contracts / route-parity / shared-check 全绿

E2E：

| 模式 | 命令 | 说明 |
|---|---|---|
| MSW contract E2E | `cd frontend && pnpm e2e` | 默认，无需后端 |
| Real Backend E2E | `NEXT_PUBLIC_API_MODE=real-backend pnpm e2e` | 需 Docker + 后端 |

---

## 6. 数据库迁移

当前 head：**`202610180010`**。

本轮相关迁移：

| 版本 | 内容 |
|---|---|
| `202610180006` | 企业税务档案表 + 种子 + 旧客户税率档案迁移 |
| `202610180007` | 报价单税务快照 |
| `202610180008` | 安全占位（原删表动作延后） |
| `202610180009` | 产品税率表 |
| `202610180010` | 发布后清理：删旧客户税率档案表、清旧进项/退税键 |

生产发布必须分段执行：**先 009 → 部署 Worker → 冒烟 → 再 010**。
完整步骤见 [docs/DEPLOYMENT_PLAN_2026-10-18.md](docs/DEPLOYMENT_PLAN_2026-10-18.md)。

```powershell
cd backend/orchestrator
alembic heads
alembic current
alembic upgrade 202610180009   # 发布前
# 部署 + 冒烟
alembic upgrade 202610180010   # 发布后清理
```

> 生产库连接串只放在本机环境变量 / `.env.local`，不要提交。

---

## 7. 部署

- 生产分支：`main`，push 会触发 `.github/workflows/deploy.yml`；
- 流程：前端静态导出 → 同步共享内核 → `pywrangler deploy` → 生产冒烟；
- 纯文档提交（`**.md` / `docs/**`）不触发部署；
- 冷启动窗口、回滚、Neon/Hyperdrive 说明见 [DEPLOY.md](DEPLOY.md)；
- 本轮发布顺序、风险、验收清单见 [docs/DEPLOYMENT_PLAN_2026-10-18.md](docs/DEPLOYMENT_PLAN_2026-10-18.md)。

常用运维：

```powershell
cd backend/worker
npx wrangler deployments list --name kaas
npx wrangler versions deploy <version-id>@100% --name kaas --yes
```

---

## 8. 关键业务规则

### 8.1 询盘 / 报价状态

- 询盘：`unquoted`（未报价）→ `quoted`（已报价）；`closed`（已关闭）为手动；
- 报价：`draft / sent / accepted / rejected / expired / closed`；
- 询盘生成报价后自动变已报价；
- 报价生成后续单证（PI/合同等）后，同询盘其他报价自动 `closed`；
- 询盘编号在生成报价前可改，生成报价后锁定并二次确认。

### 8.2 单号

统一 `类型-国家-客户-时间戳`：

- `INQ-...` 询盘
- `QUO-...` 报价
- `PI-...` / `CI-...` / `PL-...` 单证
- `ORD-...` 订单
- `SHP-...` 出运

### 8.3 成本 / 税 / 保险

详见 [docs/QUOTE_COST_INSURANCE_2026-10-18.md](docs/QUOTE_COST_INSURANCE_2026-10-18.md)。

---

## 9. 仓库结构

```
backend/
  kaas_common/            共享内核（唯一源）
  orchestrator/           本地 FastAPI + SQLAlchemy + Alembic
  worker/                 生产 Cloudflare Worker（Python FastAPI + assets）
frontend/                 Next.js 14 静态导出
shared/contracts/         前后端 zod 契约
scripts/                  sync-shared / contracts / seed / verify
docs/                     设计与交接文档
.github/workflows/        backend-test / frontend-ci / contracts-check / deploy
docker-compose.yml        本地基础设施
```

---

## 10. 文档索引

- [DEPLOY.md](DEPLOY.md) — 生产部署与运维速查
- [docs/DEPLOYMENT_PLAN_2026-10-18.md](docs/DEPLOYMENT_PLAN_2026-10-18.md) — 本轮发布方案
- [docs/PROD_DB_OPTIMIZATION_PLAN_2026-10-19.md](docs/PROD_DB_OPTIMIZATION_PLAN_2026-10-19.md) — 生产优化方案（Neon→PPG 迁移 + 性能链路，定稿待执行）
- [docs/TAX_ARCHIVE_HANDOVER_EXECUTION_PLAN_2026-10-18.md](docs/TAX_ARCHIVE_HANDOVER_EXECUTION_PLAN_2026-10-18.md) — 税务改造
- [docs/BATCH_QUOTE_REDESIGN_PLAN_2026-10-18.md](docs/BATCH_QUOTE_REDESIGN_PLAN_2026-10-18.md) — 批量报价
- [docs/QUOTE_COST_INSURANCE_2026-10-18.md](docs/QUOTE_COST_INSURANCE_2026-10-18.md) — 成本/保险/计量口径
- [docs/SHEET_CALC_VERIFICATION_2026-10-18.md](docs/SHEET_CALC_VERIFICATION_2026-10-18.md) — 智能表格算价核验
- [docs/WORKSTATION_DESIGN.md](docs/WORKSTATION_DESIGN.md) — 工位总体设计
- [docs/CURRENT_IMPLEMENTATION_MAP.md](docs/CURRENT_IMPLEMENTATION_MAP.md) — 当前实现地图

---

**最后更新**：2026-10-19
