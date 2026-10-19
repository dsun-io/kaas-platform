# 用户动作清单（2026-10-19）

> ## ✅ 2026-10-20 用户裁决（已留痕）
>
> | 决策 | 结论 | 影响 |
> |---|---|---|
> | U-E1 S5 预览范围 | **A. 全量做**（每 PR Neon 分支 + 独立 Hyperdrive + `kaas-preview-storage` + KV 前缀 + CI 防污染断言） | 下一轮实施；需你提供 **Neon API key** 与 **Cloudflare API token**（或由你在控制台创建预览资源后给我 id/凭据） |
> | U-E2 技术栈升级 | **A. 下一轮全量升级**（Next 15.5+/16 + ESLint 10 + TS 6，配全量回归） | 独立一轮执行，不与其它改动叠加 |
> | U-E3 发布窗口 | **A. 先不发布**，等 S5 + 升级完成后再定 | 部署保持冻结；发布前跑 `ENV_VERIFICATION` §4 检查单 |
> | U-S8 internal 权限 | **A. 维持平台运营专属**（internal 不可访问 `/admin/*`） | 已实现的 6 端点鉴权 + `test_admin_authz.py` 即最终口径，无需改动 |
> | U-S1 Notion 令牌（危-1） | **不清理**（不吊销、不重写 git 历史；`.codex/config.toml` 已不在索引） | 危-1 按「用户接受风险」关闭；**无需你再操作**，详见 SECURITY_AUDIT 危-1 裁决注记 |
> | U-B3 智能表格数据 | **不用补**（21 行缺失输入不再要求补全） | U-B3 关闭；表格核验文档缺口保留为历史记录，不阻塞上线 |
>

> 这些事项**只能由你（账号持有人）在外部控制台/业务系统完成**，我在仓库侧已给出步骤、
> 验证方法与留痕位置。做完一项就在「状态」列打勾（或告诉我，我更新本表并重跑验证）。
> 关联：[SECURITY_AUDIT_2026-10-19.md](./SECURITY_AUDIT_2026-10-19.md) §6.4 汇总、
> [MASTER_EXEC_PLAN_2026-10-19.md](./MASTER_EXEC_PLAN_2026-10-19.md) 批次 U。

## A. 安全类（优先）

| ID | 事项 | 步骤 | 验证 | 状态 |
|---|---|---|---|---|
| U-S1 | **`.codex/config.toml` 里的 Notion 令牌**（危-1） | **无需操作**：2026-10-20 用户裁决**不清理**（不吊销、不重写 git 历史）。代码层面 `.codex/config.toml` 已从索引删除（`100e767`），并已在 `.gitignore`；历史中保留令牌属**用户接受的风险** | 无需验证；风险接受留痕见 `SECURITY_AUDIT_2026-10-19.md` 危-1 裁决注记 | ✅ 已裁决「不清理」（2026-10-20） |
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
| U-B3 | **智能表格 21 行缺失输入补全**（U-4） | **无需操作**：2026-10-20 用户裁决**不用补**（表格数据缺口保留为历史核验记录，不影响上线） | 无需验证；风险接受留痕于任务清单/交接文档 | ✅ 已裁决「不用补」（2026-10-20） |
| U-B4 | **仓库 billing / Actions 配额**（U-3） | GitHub → Billing：确认 Actions 配额/付款方式；当前限额已耗尽（CI 仅 workflow_dispatch） | `gh run list` 可正常触发（或账单页显示额度） | ⬜ 待执行 |

## C. 环境/发布决策类

| ID | 事项 | 选项与影响 | 状态 |
|---|---|---|---|
| U-E1 | **S5 预览环境** | **已裁决：A. 全量做**（每 PR Neon 子分支 + 独立 Hyperdrive + `kaas-preview-storage` + KV 前缀 + CI 防污染断言）。实施需你提供凭据/资源，见下方「S5 前置清单」 | ⬜ **待你提供凭据/资源**（代码侧已就绪待实施） |
| U-E2 | **技术栈升级**（高-3） | ✅ **已完成（2026-10-20，`9e13ef5`）**：Next **16.4.2** / React **19.3** / ESLint **10.13** / TS **6.0.3** / CI Node 22；回归 typecheck/lint(0 error)/455 tests/e2e 23+4skip/构建全绿；`pnpm audit` 80→39（**0 critical**） | ✅ 已完成，无需你操作 |
| U-E3 | **生产发布窗口** | 当前部署冻结（`deploy.yml` 仅手动）；**已裁决：先不发布，等 S5 + 升级完成后再定**。发布方式建议：本机 `cd backend/worker && npx pywrangler deploy`（Actions 限额）；迁移先用 `PROD_DATABASE_URL` 手动 `alembic upgrade head`（head `202610190020`） | ⬜ 待你指定时间/方式 |
| U-E4 | **冷启动基线测量**（S6-c 收尾） | 需一次**经你批准**的 `pywrangler deploy`（或 versions upload）后，在 CF Dashboard → Workers → kaas → Metrics 读 p50 冷启动；把结果写入 `backend/worker/coldstart-baseline.json`（格式：`{"measured_at":"YYYY-MM-DD","p50_ms":<number>,"method":"dashboard metrics","commit":"<sha>"}`）。验收线 **≤2,950ms**，写入后 `scripts/check-worker-bundle.py` 自动校验 | ⬜ 待你批准上传/发布后测量 |

### S5 前置清单（你提供后我下一轮实施；也可你创建资源、把 id 给我）

| 需要 | 用途 | 权限/说明 |
|---|---|---|
| `NEON_API_KEY`（+ `NEON_PROJECT_ID`） | 每 PR 创建/删除预览 Neon 分支 | Neon Console → Account → API keys；分支建议命名 `preview-pr-<num>`，关闭即删 |
| `CLOUDFLARE_API_TOKEN`（+ `CLOUDFLARE_ACCOUNT_ID`） | 创建/删除预览 Hyperdrive config、上传预览 Worker、管理 R2/KV | Token 权限：Workers Scripts:Edit、Workers Hyperdrive:Edit、R2:Edit、Workers KV Storage:Edit |
| 预览 R2 桶 `kaas-preview-storage` | 预览对象存储（键前缀 `pr-<slug>/`） | 可由上述 token 由脚本创建；也可你手动建后把名字给我 |
| 预览 KV namespace | 预览隔离（若目标态需要） | 同上 |
| `PREVIEW_DATABASE_URL`（可选） | 若你想先固定一个预览库而不是每 PR 分支 | 二选一：给 Neon 分支方案凭据，或给固定预览 DSN |
| repo secrets 写入 | GitHub → Settings → Secrets → Actions | `NEON_API_KEY`、`NEON_PROJECT_ID`、`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`（预览 workflow 使用） |

> 说明：预览环境会**真实创建云资源**（可能产生少量费用）。你裁决 A（全量）即已同意该成本；
> 若改主意，随时在本文改回 B/C。

## 我这边可代做的验证（你完成后告诉我即可）

- 重跑 `check-runtime-deps` / schema 双门禁 / `contracts:check` / worker 全量；
- 生产只读冒烟：`GET https://api.kaas.powervoy.com/health`、站点 200；
- 若配置了 `PROD_DATABASE_URL`：可在本机用只读连接核对迁移 head 与 `product_tax_rates` 行数；
- 每次发布/配置后更新 `docs/PROBLEM_STATUS_2026-10-11.md` 与本表状态列并推送。
