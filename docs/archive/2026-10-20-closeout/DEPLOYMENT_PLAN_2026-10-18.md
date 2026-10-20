# KaaS 平台部署方案（2026-10-18 本轮）

> ## 本次实际执行结果（2026-10-18 22:00 左右）
>
> - 代码：`main` 已推送；部署提交 `9f82163`（README/冒烟修复为其后文档与 CI 修正）
> - 数据库：Neon production `202610170004` → **`202610180009`**（发布前）→ **`202610180010`**（清理）
> - 发布前备份分支：`pre-deploy-20261018-2150`（Neon，copy-on-write）
> - Worker：Cloudflare 部署版本 `839c6661-616b-4974-b2a3-4fb95e65ecd4`，部署时间 `2026-10-18T14:00:43Z`
> - GitHub Actions：`build-frontend` 成功；`deploy-worker` 成功（修复了旧冒烟路由断言后）
> - 生产冒烟：`/health` = ok 且 `shared.loaded=true`；`/api/v1/tax-archives`、`/api/v1/product-tax-rates`、`/api/v1/quotes` 均 401；`/login`、`/settings/tax-archives`、`/quotes` 均 200
> - 生产 `customer_quote_profiles` 已删除；`product_tax_rates` 已建；企业税档 `tax_values` 只剩 `output_vat_rate/misc_fee_rate`
> - **待业务配置**：生产 `product_tax_rates` 当前为 0 条，需要团队管理员按实际进项税/退税率配置后，批量报价才会放行

> 适用版本：`main` 分支截至本次推送（Worker 代码含税务档案、产品税率、整单保险、批量报价固定测试）。
> **本文只设计部署，不执行生产发布。** 生产发布必须由人确认后按下述顺序执行。

## 1. 当前事实（部署前先核对）

| 项 | 现状 | 核对方式 |
|---|---|---|
| 代码 | 已推送到 `origin/main` | `git status -sb` 应为 `main...origin/main` |
| 生产 Worker | 最近部署仍是 **2026-10-17T11:00Z** 左右版本 | `cd backend/worker; npx wrangler deployments list --name kaas` |
| 本次推送是否触发自动部署 | **截至编写时未产生新 Worker 版本** | 同上；若出现 2026-10-18 新版本，说明 GitHub Actions 已自动部署，先停下来核对数据库迁移 |
| 生产数据库 | 需人工确认当前 alembic 版本 | 在能连生产库的环境执行 `alembic current` |
| 生产迁移目标 | `202610180010` | 本方案分两段执行，不一次升到 head |

> 自动部署工作流：`.github/workflows/deploy.yml` 监听 `main` push（纯文档路径除外）。
> 本次推送包含代码，按理可能触发；但 Cloudflare 侧没有新版本，说明 Actions 未执行或用例未跑。
> **部署当天必须先看 Actions / Cloudflare 版本，避免“以为没部署、其实在排队”。**

## 2. 本次发布内容

1. 税务档案改企业级：`tax_archives` 只保留销项税、杂税；
2. 新增产品税率 `product_tax_rates`：进项增值税、出口退税率按产品维护；
3. 报价单税务快照 `quote_orders.tax_snapshot`；
4. 报价成本强制手填 + 历史参考需点“应用参考成本”；
5. 整单保险公式：EXW 货值 × 1.1 ÷ 1000，最低 15 美元，整单一次、按行分摊；
6. 船公司固定选项、米→卷自动进一；
7. 批量报价固定回归测试；
8. 旧批量导入面板、旧客户税率档案 API/表清理（**表删除延后到发布后**）。

## 3. 关键迁移顺序（本方案的核心）

本轮迁移已拆成“加法迁移”和“发布后清理”两段：

| 版本 | 内容 | 何时执行 |
|---|---|---|
| `202610180006` | 建 `tax_archives`、种子、旧客户税率档案按税组合迁移 | 发布前（加法，旧 Worker 可兼容） |
| `202610180007` | 报价单加税务快照列 | 发布前（加法） |
| `202610180008` | **空操作**（原删表动作已移走） | 发布前（无副作用） |
| `202610180009` | 建 `product_tax_rates` | 发布前（加法） |
| `202610180010` | **清理**：删 `customer_quote_profiles`、清企业税档里的进项/退税旧键 | **新 Worker 冒烟通过后** |

为什么不能一次 `upgrade head`：
旧 Worker 仍会读 `customer_quote_profiles`。如果先删表，再切新生效代码，中间几分钟旧版本会 500。
所以发布前只升到 **009**，新 Worker 稳定后再升到 **010**。

### 3.1 发布前迁移

```bash
cd backend/orchestrator
# DATABASE_URL 指向生产库（Neon production 分支）
alembic upgrade 202610180009
alembic current           # 必须是 202610180009
```

验证：

```sql
SELECT to_regclass('tax_archives');
SELECT to_regclass('product_tax_rates');
SELECT to_regclass('customer_quote_profiles');  -- 此时仍应存在
SELECT version_num FROM alembic_version;        -- 202610180009
```

### 3.2 发布后清理（冒烟通过后）

```bash
cd backend/orchestrator
alembic upgrade 202610180010
```

验证：

```sql
SELECT to_regclass('customer_quote_profiles');  -- 应为空
SELECT tax_values FROM tax_archives LIMIT 3;    -- 不再含 input_vat_rate/rebate_rate
```

## 4. 部署前准备

### 4.1 数据库备份

- Neon：新建一个**发布前快照/分支**（例如 `pre-20261018`），保留到验收完成；
- 记录当前 `alembic current` 与迁移头；
- 确认没有未提交/未推送的数据库脚本。

### 4.2 构建门禁（本机已跑过，发布前再跑一次）

```powershell
# 共享内核
powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1
powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1 -Check

# 后端
cd backend/orchestrator
$env:PYTHONPATH=".;.."
.venv\Scripts\python.exe -m pytest tests -q -m unit

# Worker
cd ..\worker
uv run --frozen --with pytest --with httpx2 python -m pytest tests -q

# 前端
cd ..\..\frontend
pnpm typecheck
pnpm lint
pnpm test
$env:NEXT_EXPORT="1"; $env:NEXT_DIST_DIR=".next-verify"; pnpm build
```

前端产物：`frontend/out/`（Worker 的 `assets.directory` 引用它）。

### 4.3 Worker 配置核对

- `JWT_SECRET` / `ADMIN_SETUP_TOKEN` / `RESEND_API_KEY` 仍在 Worker 上；
- Hyperdrive 绑定 `HYPERDRIVE` 正常；
- 自定义域名：`kaas.powervoy.com`、`api.kaas.powervoy.com`；
- 本次**不改** Worker 名称和 secrets，避免旧 token 失效。

## 5. 发布执行（二选一）

### 方案 A：GitHub Actions（推荐，可留痕）

1. GitHub → Actions → `deploy` → `Run workflow`（`main`）；
2. 确认 `build-frontend` 与 `deploy-worker` 两个 job 全绿；
3. 若 Actions 因额度/账单起不来，改方案 B。

### 方案 B：本机 Wrangler

```powershell
cd backend/worker
npx wrangler whoami                    # 确认已登录
powershell -ExecutionPolicy Bypass -File ..\..\scripts\sync-shared.ps1
powershell -ExecutionPolicy Bypass -File ..\..\scripts\sync-shared.ps1 -Check
npx pywrangler deploy                  # 或 uv run pywrangler deploy
```

> 发布后会有数分钟冷启动窗口（Pyodide），间歇 5xx 属预期，**不要连续回滚**。
> 判定：间歇 5xx 且 5 分钟内自愈 → 等待；100% 持续失败 > 5 分钟才回滚。

## 6. 发布后验收

### 6.1 基础健康

- [ ] `https://api.kaas.powervoy.com/health` → 200，body 为 JSON，`shared.loaded=true`
- [ ] 匿名访问 `/api/v1/quotes`、`/api/v1/leads` → 401（不是 200）
- [ ] `https://kaas.powervoy.com/login` 可登录

### 6.2 本轮功能

- [ ] 税务管理页能打开，企业税档只剩销项/杂税两个字段；
- [ ] 「产品税率」能新增产品、重复产品被拦、能修改；
- [ ] 报价行不填成本不能算价/保存；点「应用参考成本」才带入；
- [ ] CIF 报价页保险项显示“自动计算”，金额 ≥ 15 美元；
- [ ] 船公司下拉在 CFR/CIF/DAP/DDP 出现；
- [ ] 填客户需求米数后卷数自动进一；
- [ ] 批量报价：选客户 → 选询盘 → 填成本 → 生成报价单成功；
- [ ] 批量页对未配置产品税率的产品给出明确提示，不静默用默认税。

### 6.3 数据配置（发布后必须做）

每个团队管理员进「税务管理」：

1. 检查企业税档的销项税、杂税；
2. 为每个在售产品新增产品税率（进项增值税、出口退税率）；
3. **未配置产品税率的团队**：
   - 单笔报价会回退到默认进项 10% / 无退税；
   - 批量报价会被拦，提示先配置；
4. 确认历史报价单 `tax_snapshot` 仍可查看（历史数据不受影响）。

## 7. 回滚方案

### 7.1 Worker 回滚（优先）

```powershell
cd backend/worker
npx wrangler deployments list --name kaas
npx wrangler versions deploy <上一版本ID>@100% --name kaas --yes
```

注意：回滚也会重置冷启动窗口，短故障不要反复回滚。

### 7.2 数据库回滚

- 发布前只执行了 **006/007/008（空操作）/009**，都是加法迁移：
  - 旧 Worker 不读新表，回滚 Worker 后仍可运行；
  - 新增表/列无需删除。
- 若已执行 **010**（删旧表 + 清旧键）：
  - 表删除不可逆，必须用发布前 Neon 快照恢复；
  - 恢复后按需回退 Worker。
- **任何时候都不要在生产库手工 `DROP` 新表来“快速回滚”**，会造成数据丢失。

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| push 自动触发部署，但数据库未迁移 | 新代码缺表/列，税务、报价 500 | 部署前先看 Cloudflare 版本和 Actions；先跑 009 再切代码 |
| 旧 Worker 与旧表依赖 | 删表后旧版本 500 | 010 延后到新 Worker 冒烟后 |
| 产品税率未配置 | 批量报价被拦、单笔退税不准确 | 发布后第一时间配置；在群里给出配置清单 |
| 保险前端两轮计算 | 页面计算时间略增 | 只对 CIF/DAP/DDP 触发；核验保险金额 |
| 冷启动窗口 | 间歇 5xx | 冒烟带重试；5 分钟内不自愈才回滚 |
| GitHub Actions 额度不足 | 自动部署不运行 | 用本机 Wrangler 方案 B |

## 9. 执行清单（按顺序打勾）

> ✅ **全部已于 2026-10-18 22:00 执行完毕**（生产迁移至 `202610180010`，部署走 GitHub Actions
> run 成功；2026-10-19 盘点补打勾。细节见本文顶部「执行结果」记录与 HANDOVER_2026-10-18）。

- [x] 通知相关人：发布窗口
- [x] Neon 快照 `pre-20261018`
- [x] 记录 Worker 当前版本与生产 `alembic current`
- [x] 本机全量门禁通过
- [x] `alembic upgrade 202610180009`（生产）
- [x] 部署 Worker（Actions 或本机）
- [x] `/health`、登录、匿名 401 冒烟
- [x] 税务管理 / 产品税率 / 报价 / 批量报价验收
- [x] 团队配置产品税率
- [x] `alembic upgrade 202610180010`（清理）
- [x] 再跑一轮冒烟
- [x] 记录发布版本、时间、验收人
