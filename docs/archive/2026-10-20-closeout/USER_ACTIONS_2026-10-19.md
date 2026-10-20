# 用户动作清单（2026-10-19）

> 🏁 **2026-10-20 终局裁决**：用户裁决——**全部待办清零**：✅ = 完成；⏳ = **触发条件制**
> （到点自动执行 / 用户一声令下），**不再活跃跟踪**。下一活跃节点 = 你的发布指令。
>
> ## ✅ 2026-10-20 用户裁决（已留痕）
>
> | 决策 | 结论 | 影响 |
> |---|---|---|
> | U-E1 S5 预览范围 | **A. 全量做**（每 PR Neon 分支 + 独立 Hyperdrive + `kaas-preview-storage` + KV 前缀 + CI 防污染断言） | 下一轮实施；凭据见第二轮留痕（ Neon key 已给并写入 repo secrets） |
> | U-E2 技术栈升级 | **A. 下一轮全量升级**（Next 15.5+/16 + ESLint 10 + TS 6，配全量回归） | ✅ 已完成（`9e13ef5`，2026-10-20 复跑全 PASS） |
> | U-E3 发布窗口 | **A. 先不发布**，等 S5 + 升级完成后再定 | 部署保持冻结；发布前跑 `ENV_VERIFICATION` §4 检查单 |
> | U-S8 internal 权限 | **A. 维持平台运营专属**（internal 不可访问 `/admin/*`） | 已实现的 6 端点鉴权 + `test_admin_authz.py` 即最终口径，无需改动 |
> | U-S1 Notion 令牌（危-1） | **不清理**（不吊销、不重写 git 历史；`.codex/config.toml` 已不在索引） | 危-1 按「用户接受风险」关闭；**无需你再操作**，详见 SECURITY_AUDIT 危-1 裁决注记 |
> | U-B3 智能表格数据 | **不用补**（21 行缺失输入不再要求补全） | U-B3 关闭；表格核验文档缺口保留为历史记录，不阻塞上线 |
>
> ## ✅ 2026-10-20 第二轮（本地环境验收 + 你出手之后）
>
> | 决策 | 结论 | 影响 |
> |---|---|---|
> | 仓库可见性/billing | 你已**将仓库临时转为 public**（public 仓库 Actions 免费，解决 U-B4 账单欠费） | CI 恢复可用；⚠️ git 历史中的 Notion 令牌（危-1）随之公开可见 ⇒ **公开期尽量短，用完尽快转回 private** |
> | Notion 令牌再裁决 | 维持不轮换；前提变为"**尽快转回私有**" | 公开期 exposure 为已接受风险 |
> | repo secrets | **能代写的由我代写**：`PROD_DATABASE_URL`（本机 .env.local 提取）、`NEON_API_KEY`、`NEON_PROJECT_ID` 已于 2026-10-20 写入并验证 | deploy 自动迁移与 S5 预览的凭据就绪 |
> | R2 新密钥 | Access Key/Secret 已提供，**实测有效**（桶级读写 OK）；`wrangler secret put` 被版本管理拦截 ⇒ **并入发布窗口批次**与 RESEND_API_KEY 一起换 | 旧 keys 生产继续生效至发布；发布后需你在 R2 dashboard 删旧 token |
> | 生产税率数据（U-B2） | **暂缓**：实测生产 0 条产品（tenant_products / twp / product_skus 全 0），无配置对象 | 随产品上架时同页面统一配（业务动作） |

> 这些事项**只能由你（账号持有人）在外部控制台/业务系统完成**，我在仓库侧已给出步骤、
> 验证方法与留痕位置。做完一项就在「状态」列打勾（或告诉我，我更新本表并重跑验证）。
> 关联：[SECURITY_AUDIT_2026-10-19.md](./SECURITY_AUDIT_2026-10-19.md) §6.4 汇总、
> [MASTER_EXEC_PLAN_2026-10-19.md](./MASTER_EXEC_PLAN_2026-10-19.md) 批次 U。

## A. 安全类（优先）

| ID | 事项 | 步骤 | 验证 | 状态 |
|---|---|---|---|---|
| U-S1 | **`.codex/config.toml` 里的 Notion 令牌**（危-1） | **无需操作**：2026-10-20 用户裁决**不清理**（不吊销、不重写 git 历史）。代码层面 `.codex/config.toml` 已从索引删除（`100e767`），并已在 `.gitignore`；历史中保留令牌属**用户接受的风险** | 无需验证；风险接受留痕见 `SECURITY_AUDIT_2026-10-19.md` 危-1 裁决注记 | ✅ 已裁决「不清理」（2026-10-20）⚠️ **注意**：仓库 2026-10-20 起**临时转 public**，历史令牌已对公众可见 —— 用户裁决：不轮换，**尽快转回 private** |
| U-S2 | **仓库可见性**（危-2） | ~~确认 Private~~ → **2026-10-20 变更**：你已临时转 **public**（解决 billing）；用毕请转回 private | 匿名 `curl https://api.github.com/repos/dsun-io/kaas-platform` 现返回 200（public）；转回后应回 404 | ✅ **已关闭**（2026-10-20 终局裁决）：仓库已转回 **private**（gh api 完成，匿名访问 403 验证）；billing workaround 结束 |
| U-S3 | **核对生产 Worker secrets**（只读） | `cd backend/worker; npx wrangler secret list --name kaas` | 必含 `JWT_SECRET`、`ADMIN_SETUP_TOKEN`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`、`RESEND_API_KEY`；缺 `JWT_SECRET` ⇒ 全站 503 | ✅ **已代核（2026-10-20，本机 wrangler 已登录账号 `dspro0124@163.com`）**：实测只有 **4 个** —— `ADMIN_SETUP_TOKEN`/`JWT_SECRET`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`，**缺 `RESEND_API_KEY`** ⇒ 生产「忘记密码」邮件当前静默不发。补法见 **U-B5** |
| U-S4 | **Cloudflare Rate Limiting Rules**（高-4 推荐） | ~~CF Dashboard 配置~~ → **2026-10-20 已代配**（五权限 token + WAF rulesets API）：登录/注册 `2 req/10s/IP` block；免费套餐仅支持 10s 窗口（≈12/min，非 5/min） | 实测 401→401→429×4 ✅；规则 id `2e58c43e…087a`（zone powervoy.com） | ✅ 已生效（2026-10-20） |
| U-S5 | **Neon 生产分支设为 Protected** | Neon Console → Project → Branches → production → Protect（禁止误删/重置） | 分支页显示 Protected | ✅ **已关闭**（2026-10-20 终局裁决）：实测 Neon Protected 为**付费功能**、Free 套餐不可用；用户裁决**不升级**，由预览脚本「**删分支双保险校验**」（branch_id ≠ production 且 name ≠ production，缺一拒删）替代——README §2.2 已标注 |
| U-S6 | **R2 桶命名决策**（中-2） | 二选一：① 保留 `kaas-files` 并修订文档；② 改名 `kaas-prod-storage`（需迁移对象 + 改 `wrangler.jsonc` + 重部署） | `wrangler.jsonc` 与 README 一致；对象数/大小迁移前后一致 | ✅ **已关闭**（2026-10-20 终局裁决）：用户裁决生产桶**永久保留 `kaas-files` 名**（目标态 `kaas-prod-storage` 改名取消）；README §2.2 已按实配改写（CI 断言变量 `PROD_R2_BUCKET` 按 `kaas-files`） |
| U-S7 | **`PROD_DATABASE_URL`** | ~~是否配置~~ → **2026-10-20 已配置**：我通过 gh 从本机 `.env.local` 提取 Neon production DSN 写入 repo secrets | `deploy.yml` migrate job 不再告警跳过（下次含代码的 push 可见 migrate job 实跑） | ✅ 已配置（2026-10-20，gh 代写） |
| U-S8 | **`internal` 普通业务员能否看审计日志/切 feature flag**（高-1/高-2 修复口径） | 回答策略；我据此把已落地的「平台运营专属」口径写死或放宽 | 文档 + 测试断言 + 6 个 admin 端点行为一致 | ✅ 已裁决「维持平台运营专属」（2026-10-20） |

## B. 业务配置类

| ID | 事项 | 步骤 | 验证 | 状态 |
|---|---|---|---|---|
| U-B1 | **R2 `S3_ACCESS_KEY` 重建 32 位**（U-1） | ~~CF Dashboard 创建~~ → **已完成**：新 Access Key/Secret 已提供并实测有效（`kaas-files` 桶级读写 OK，2026-10-20 minio-py 验签）。写入 Worker：`npx wrangler secret put S3_ACCESS_KEY --name kaas` / 同 `S3_SECRET_KEY` | `wrangler secret list` 更新；上传→预签名下载回环；`/api/v1/files/_r2_debug`（管理员）ok | ⏳ **触发条件制 = 发布窗口**（与 U-B5 同批）：新 keys 已验签（对 `kaas-preview-storage` 桶级读写**双向验证**，minio-py，2026-10-20）并入库 **repo secrets**；**旧 keys 生产仍生效**；发布窗口执行 `wrangler secret put` + 发布后你在 R2 Dashboard 删旧 token（步骤见 `HANDOVER_2026-10-20.md` §7 检查单） |
| U-B2 | **生产 `product_tax_rates` 配置数据**（U-2） | 按「税率配置清单」要点执行（已抄录留痕；原文归档于 `docs/archive/2026-10-20-closeout/DEPLOYMENT_PLAN_2026-10-18.md` §6）：团队管理员进「税务管理」① 检查企业税档销项税/杂税；② 为每个在售产品新增产品税率（进项增值税、出口退税率）；③ 未配置团队：单笔报价回退默认进项 10% / 无退税，批量报价被拦并提示先配置；④ 确认历史报价单 `tax_snapshot` 可查看。在 Neon production 写入税率行 | `select count(*) from product_tax_rates;` > 0；批量报价接口不再返回「税率未配置」 | ⏸ **暂缓（2026-10-20 用户裁决）**：生产实测 **0 条产品**（tenant_products / tenant_workstation_products / product_skus 全 0）⇒ 无配置对象；**触发条件 = 产品上架时**在同一页面统一配（业务动作） |
| U-B3 | **智能表格 21 行缺失输入补全**（U-4） | **无需操作**：2026-10-20 用户裁决**不用补**（表格数据缺口保留为历史核验记录，不影响上线） | 无需验证；风险接受留痕于任务清单/交接文档 | ✅ 已裁决「不用补」（2026-10-20） |
| U-B4 | **仓库 billing / Actions 配额**（U-3） | ~~GitHub → Billing~~ → **2026-10-20 已解决**：用户将仓库临时转 public，public 仓库 Actions 免费 | `gh run list` 有正常执行（非 billing 拦截失败） | ✅ 已解决（方式 = 临时 public；⚠️ 用完转回 private，见 U-S2） |
| U-B5 | **补生产 Worker secret `RESEND_API_KEY`**（2026-10-20 新发现） | key 已由用户提供（对应已验证域名 `send.powervoy.com`），暂存本机 `.env.local`（gitignored）。**用户裁决：当前不进生产，先做本地，发布窗口随部署一起上**（直接 `wrangler secret put` 会因版本管理触发部署，2026-10-20 实测被安全拦下、生产零改动）。发布时：`cd backend/worker; npx wrangler secret put RESEND_API_KEY --name kaas` | `npx wrangler secret list --name kaas` 出现第 5 项 `RESEND_API_KEY`；随后用 forgot-password 触发一次发信，日志无「未配 Resend API Key」 | ⏳ **触发条件制 = 发布窗口**（同 U-B1 批次）：`RESEND_API_KEY` 已提供、暂存本机 `.env.local`（gitignored），发布时 `wrangler secret put`（步骤见 `HANDOVER_2026-10-20.md` §7 检查单） |

## C. 环境/发布决策类

| ID | 事项 | 选项与影响 | 状态 |
|---|---|---|---|
| U-E1 | **S5 预览环境** | **已裁决：A. 全量做**（每 PR Neon 子分支 + 独立 Hyperdrive + `kaas-preview-storage` + KV 前缀 + CI 防污染断言）。**✅ 已落地（2026-10-20，`18ae386`）**：`scripts/preview/` + `preview.yml` + 前缀规则 + S5-d 断言，repo secrets/variables 全配；预览 secrets 按独立方案供（`JWT_SECRET`/`ADMIN_SETUP_TOKEN` 随机独立值已入 repo secrets；预览桶专用 S3 token 无 API 需 Dashboard 手动建，可选） | ✅ **已落地**，待首次真实 PR 端到端验证 |
| U-E2 | **技术栈升级**（高-3） | ✅ **已完成（2026-10-20，`9e13ef5`）**：Next **16.4.2** / React **19.3** / ESLint **10.13** / TS **6.0.3** / CI Node 22；回归 typecheck/lint(0 error)/455 tests/e2e 23+4skip/构建全绿；`pnpm audit` 80→39（**0 critical**） | ✅ 已完成，无需你操作 |
| U-E3 | **生产发布窗口** | 当前部署冻结（`deploy.yml` 仅手动）；**已裁决：先不发布，等 S5 完成后再定**。发布方式建议：本机 `cd backend/worker && npx pywrangler deploy`；迁移已由 `PROD_DATABASE_URL` 配好可自动跑（head `202610190020`） | ⏳ **挂起待你指定时间**：§7 检查单已就绪（迁移 → secrets → 部署 → 冷启动测量 → Hyperdrive 缓存关闭 → 冒烟）；到点自动执行，不再活跃跟踪 |
| U-E4 | **冷启动基线测量**（S6-c 收尾） | 需一次**经你批准**的 `pywrangler deploy`（或 versions upload）后，在 CF Dashboard → Workers → kaas → Metrics 读 p50 冷启动；把结果写入 `backend/worker/coldstart-baseline.json`（格式：`{"measured_at":"YYYY-MM-DD","p50_ms":<number>,"method":"dashboard metrics","commit":"<sha>"}`）。验收线 **≤2,950ms**，写入后 `scripts/check-worker-bundle.py` 自动校验 | ⏳ 随 U-E3 发布窗口（冷启动基线随发布测量入库 `backend/worker/coldstart-baseline.json`，验收线 ≤2,950ms） |

### S5 前置清单（凭据进度 2026-10-20 更新）

| 需要 | 用途 | 状态 |
|---|---|---|
| `NEON_API_KEY`（+ `NEON_PROJECT_ID`） | 每 PR 创建/删除预览 Neon 分支 | ✅ **已写入 repo secrets**（2026-10-20，gh 代写） |
| `CLOUDFLARE_API_TOKEN`（+ `CLOUDFLARE_ACCOUNT_ID`） | 创建/删除预览 Hyperdrive config、上传预览 Worker、管理 R2/KV | ✅ 已有（账号级 token，用户 2026-10-20 确认）；**权限验证（Workers Scripts/Hyperdrive/R2/KV Edit）排到 S5 首个 workflow 做** |
| 预览 R2 桶 `kaas-preview-storage` | 预览对象存储（键前缀 `pr-<num>/`） | ✅ 已建（S5-c 落地，`18ae386`；预览桶专用 S3 token 已验签并入库 repo secrets，`31c4e24`） |
| 预览 KV namespace | 预览隔离（若目标态需要） | ✅ 已建（`KAAS_PREVIEW`，S5-c，`18ae386`） |
| `PREVIEW_DATABASE_URL`（可选） | 若你想先固定一个预览库而不是每 PR 分支 | 默认走每 PR Neon 分支方案，无需给 |

> 说明：预览环境会**真实创建云资源**（可能产生少量费用）。你裁决 A（全量）即已同意该成本；
> 若改主意，随时在本文改回 B/C。

## 我这边可代做的验证（你完成后告诉我即可）

- 重跑 `check-runtime-deps` / schema 双门禁 / `contracts:check` / worker 全量；
- 生产只读冒烟：`GET https://api.kaas.powervoy.com/health`、站点 200；
- `PROD_DATABASE_URL` 已配：可在本机用只读连接核对迁移 head 与 `product_tax_rates` 行数（已做过一次，head `202610180010`）；
- 每次发布/配置后更新 `docs/PROBLEM_STATUS_2026-10-11.md` 与本表状态列并推送。
