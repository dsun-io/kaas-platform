# 用户动作清单（2026-10-19）

> 这些事项**只能由你（账号持有人）在外部控制台/业务系统完成**，我在仓库侧已给出步骤、
> 验证方法与留痕位置。做完一项就在「状态」列打勾（或告诉我，我更新本表并重跑验证）。
> 关联：[SECURITY_AUDIT_2026-10-19.md](./SECURITY_AUDIT_2026-10-19.md) §6.4 汇总、
> [MASTER_EXEC_PLAN_2026-10-19.md](./MASTER_EXEC_PLAN_2026-10-19.md) 批次 U。

## A. 安全类（优先）

| ID | 事项 | 步骤 | 验证 | 状态 |
|---|---|---|---|---|
| U-S1 | **吊销 `.codex/config.toml` 里的 Notion 令牌**（危-1） | ① Notion → Settings → Connections/Integrations，找到该 token 对应 integration → 删除/轮换；② 决定是否做 git 历史重写（可选，需 backup） | token 已失效（旧 token 调 API 返回 401）；仓库已 `git rm --cached .codex/config.toml`（`100e767`） | ⬜ 待你操作 |
| U-S2 | **确认仓库可见性**（危-2） | GitHub → Settings → General → 确认 Private；若仍 public ⇒ 改 private（推翻 10-17「不轮换」裁决需你点头，可顺带轮换 Neon 口令） | `curl -s -o NUL -w "%{http_code}" https://api.github.com/repos/dsun-io/kaas-platform` → 404（private 匿名不可见） | ⬜ 待确认（2026-10-19 匿名探测为 404，倾向已是 private） |
| U-S3 | **核对生产 Worker secrets**（只读） | `cd backend/worker; npx wrangler secret list --name kaas` | 必含 `JWT_SECRET`、`ADMIN_SETUP_TOKEN`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`、`RESEND_API_KEY`；缺 `JWT_SECRET` ⇒ 全站 503 | ⬜ 待你执行（我无凭据） |
| U-S4 | **Cloudflare Rate Limiting Rules**（高-4 推荐） | CF Dashboard → Security → WAF/Rate limiting：对 `/api/v1/auth/login`、`/api/v1/auth/register` 配 5 req/min/IP | 超限返回 429；日志里出现 rate limit 命中 | ⬜ 待决策 |
| U-S5 | **Neon 生产分支设为 Protected** | Neon Console → Project → Branches → production → Protect（禁止误删/重置） | 分支页显示 Protected | ⬜ 待执行 |
| U-S6 | **R2 桶命名决策**（中-2） | 二选一：① 保留 `kaas-files` 并修订文档；② 改名 `kaas-prod-storage`（需迁移对象 + 改 `wrangler.jsonc` + 重部署） | `wrangler.jsonc` 与 README 一致；对象数/大小迁移前后一致 | ⬜ 待决策 |
| U-S7 | **`PROD_DATABASE_URL` 是否配置**（决定 deploy 自动迁移） | GitHub → Settings → Secrets → Actions → 新增 `PROD_DATABASE_URL`（Neon production 的 psycopg2 形式 DSN） | `deploy.yml` migrate job 不再告警跳过 | ⬜ 待决策 |
| U-S8 | **`internal` 普通业务员能否看审计日志/切 feature flag**（高-1/高-2 修复口径） | 回答策略；我据此把已落地的「平台运营专属」口径写死或放宽 | 文档 + 测试断言 + 6 个 admin 端点行为一致 | ⬜ 待裁决 |

## B. 业务配置类

| ID | 事项 | 步骤 | 验证 | 状态 |
|---|---|---|---|---|
| U-B1 | **R2 `S3_ACCESS_KEY` 重建 32 位**（U-1） | CF Dashboard → R2 → Manage R2 API Tokens → 创建 Access Key/Secret（Object Read & Write，限 `kaas-files`）→ `npx wrangler secret put S3_ACCESS_KEY --name kaas` / 同 S3_SECRET_KEY | `curl` 上传→预签名下载回环成功；`/api/v1/files/_r2_debug`（管理员）返回 ok | ⬜ 待执行 |
| U-B2 | **生产 `product_tax_rates` 配置数据**（U-2） | 按 `docs/DEPLOYMENT_PLAN_2026-10-18.md` 顶部清单，在 Neon production 写入税率行（0 条则批量报价不放行） | `select count(*) from product_tax_rates;` > 0；批量报价接口不再返回「税率未配置」 | ⬜ 待执行 |
| U-B3 | **智能表格 21 行缺失输入补全**（U-4） | 按 `docs/SHEET_CALC_VERIFICATION_*.md §4-5` 清单补齐业务输入 | 报价复算与表格逐行一致（脚本 `scripts/verify_quote_against_sheet` 类工具） | ⬜ 待业务执行 |
| U-B4 | **仓库 billing / Actions 配额**（U-3） | GitHub → Billing：确认 Actions 配额/付款方式；当前限额已耗尽（CI 仅 workflow_dispatch） | `gh run list` 可正常触发（或账单页显示额度） | ⬜ 待执行 |

## C. 环境/发布决策类

| ID | 事项 | 选项与影响 | 状态 |
|---|---|---|---|
| U-E1 | **S5 预览环境** | A. 做全量（每 PR Neon 子分支 + 独立 Hyperdrive + `kaas-preview-storage` + KV 前缀 + CI 防污染断言）；B. 只做「预览 Worker + 共享预览 DB」（成本低、隔离弱）；C. 明确不做（README §2.2 标未排期） | ⬜ 待你选 |
| U-E2 | **技术栈升级排期**（高-3） | Next 14.2 → 15.5+/16（2 critical RCE，需回归）、ESLint 10、TS 6；CI Node 已升 22。建议单独一轮做 Next + 回归 | ⬜ 待排期 |
| U-E3 | **生产发布窗口** | 当前部署冻结（`deploy.yml` 仅手动）。发布方式建议：本机 `cd backend/worker && npx pywrangler deploy`（Actions 限额）；迁移先用 `PROD_DATABASE_URL` 手动 `alembic upgrade head`（head `202610190020`） | ⬜ 待指令 |

## 我这边可代做的验证（你完成后告诉我即可）

- 重跑 `check-runtime-deps` / schema 双门禁 / `contracts:check` / worker 全量；
- 生产只读冒烟：`GET https://api.kaas.powervoy.com/health`、站点 200；
- 若配置了 `PROD_DATABASE_URL`：可在本机用只读连接核对迁移 head 与 `product_tax_rates` 行数；
- 每次发布/配置后更新 `docs/PROBLEM_STATUS_2026-10-11.md` 与本表状态列并推送。
