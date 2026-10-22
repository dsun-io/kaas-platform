# CI 瘦身与 self-hosted runner（2026-10-22）

> **状态：已实施**（workflow 改动已入 `main`）。本文是 **CI 成本/触发面的唯一说明**。
> 关联：`docs/PROBLEM_STATUS_2026-10-11.md` 交接摘要（2026-10-22 条）、`DEPLOY.md` §发布纪律、
> `README.md` §2（预览环境）、`.github/workflows/*.yml`。

## 0. 结论（TL;DR）

- **不删门禁**，只瘦触发面：lint/typecheck/build/单测/worker 测试/契约/静态门禁全部保留。
- 月耗从实测 ≈3,400–4,700 分钟（GitHub 按 job 计费口径）降到估算 **≈1,500–2,000 分钟**。
- **2026-10-22 仓库已转 public** ⇒ GitHub-hosted 标准 runner 对 public 仓库**免费且无限**，额度问题解除；
  本次瘦身仍保留（减少冗余 job / 加速反馈），但**不再是省钱必需**。若以后转回 private，本文件 §1 的额度口径立即恢复有效。
- 花钱的三个大头已处理：**e2e 不再每次 push 跑**、**预置/部署链路不随 push 跑**、**过期 run 自动取消**。
- `deploy.yml` **仍是 `workflow_dispatch` only**（2026-10-20 用户裁决不变，未恢复 push 自动部署）。
- **self-hosted runner（已批准方向，未实施；public 后降为可选）**：见 §6；public 仓库接 self-hosted 有 fork PR 执行风险，见 §6.1 第 5 条。

## 1. 为什么改（额度与实测）

- 额度时间线：**2026-10-22 之前仓库是 private**（GitHub Actions 免费额度 = **2,000 分钟/月**，Free 计划）；
  **2026-10-22 已转 public** ⇒ public 仓库的标准 runner **免费且无限**（官方 billing 文档原文：
  "GitHub Actions usage is free for self-hosted runners and for public repositories that use standard GitHub-hosted runners"）。
  下文 §1 的实测数字是瘦身的**依据与收益记录**，在 public 下不再决定是否超额。
- 历史：2026-10-17 私有仓库额度/账单把 job 挡在启动前（annotation：`recent payments have failed or your spending limit needs to be increased`），当时把仓库改 public 才恢复；后来按用户裁决改回 private（见 `PROBLEM_STATUS_2026-10-11.md` 2026-10-17 交接段）。
- 2026-10-22 实测（GitHub API：`/actions/runs` + `/actions/runs/{id}/jobs`，按 job 相加 = GitHub 计费口径）：

| 工作流 | 触发 | 单次计费（实测 job 相加） | 14 天 runs | 折月估算 |
|---|---|---|---|---|
| Frontend CI | push main / PR | ≈5.3 min（check 2.1–3.1 + e2e 2.5–3.1） | 170 | ≈1,900–2,200 |
| backend:test | push（任意分支）/ PR | ≈2.1 min（3 job：0.3 + 1.2 + 0.6） | 245 | ≈1,000–1,150 |
| contracts:check | push / PR | ≈0.7 min | 143 | ≈200 |
| preview | PR + 手动 | ≈2.4 min | 38 | ≈195 |
| deploy | push（**10-19 已冻结**）/ 手动 | ≈2.6 min | 191（冻结前） | 冻结后 ≈0；冻结前 ≈1,070 |
| ts-edge | push | ≈0.16 min | 16 | ≈5 |

> 口径提醒：我早前用 `updated_at−created_at`（墙钟）估的 772 分钟/7 天会**低估约 40–50%**——
> GitHub 按每个 job 的分钟相加计费，并行的 `check`+`e2e` 各算各的。本文一律用 job 相加口径。

### 1.1 落地当口的额度拦截（历史证据，public 后已解除）

2026-10-22 推送瘦身提交后，三个 workflow 都正常触发、job 选择也正确（e2e / 真 PG 集成均 skipped），
但**所有 job 在 0–3 秒内失败**，annotation 原文：

```text
The job was not started because recent account payments have failed or your spending limit needs to be increased.
Please check the 'Billing & plans' section in your settings
```

⇒ 这是**额度/账单拦截，不是代码或 workflow 语法问题**（同一 annotation 在 2026-10-17 出现过一次）。
恢复路径（三选一）：① GitHub → Settings → Billing and plans → Actions 提高 spending limit / 绑定支付方式；
② 等新计费周期免费分钟重置（Free 计划 2,000 分钟/月）；③ 按 §6 接 **self-hosted runner**（不吃 GitHub-hosted 分钟，
通常也不受该 spending limit 拦截）。

**2026-10-22 更新（已解决）**：仓库转 **public** 后复跑同一 run（`gh run rerun`），job 已**正常启动**
（`Frontend CI / check` 进入 in_progress），证实拦截来自 **private 额度**，不是 workflow 本身。
本条保留为历史证据；public 仓库的 GitHub-hosted 分钟免费无限，无需再处理 spending limit。

## 2. 本次改动（逐文件）

| 文件 | 改动 | 预计省（分钟/月） |
|---|---|---|
| `.github/workflows/frontend-ci.yml` | ①`e2e` 加 `if: github.event_name != 'push'`（只在 PR / 每晚定时 / 手动跑）；②新增 `schedule`（18:00 UTC = 02:00 Asia/Shanghai 夜间全量）；③删掉 e2e 里**从未被使用**的 `pnpm build`（webServer 起的是 `next dev`，见 `frontend/playwright.config.ts`）；④加 `concurrency` + `cancel-in-progress` | ≈1,200–1,300 |
| `.github/workflows/backend-test.yml` | ①push 限 `main`；②paths 收窄：不再用 `backend/**`、`scripts/**`，只列门禁相关源/脚本（poc-*、ts-migration、scripts/archive 不再触发）；③真 PG 集成 job `worker-db-tests` 加 `if: github.event_name != 'push'`（只在 PR / 定时 / 手动跑）；④新增 `schedule`（18:30 UTC）；⑤`concurrency` | ≈600–900 |
| `.github/workflows/contracts-check.yml` | 去掉落在 frontend-ci 触发面内的路径（`frontend/**`、`shared/contracts/**`）——frontend check job 已经在跑**同一个** `pnpm contracts:check`；加 `concurrency` | ≈100 |
| `.github/workflows/preview.yml` | PR 预览改为 **PR 打 `preview` label** 才构建（`types` 增加 `labeled`）；close 仍无条件 teardown（防资源泄漏）；加 label 判定 | ≈150–300 |
| `.github/workflows/ts-edge.yml` | 加 `concurrency` + `cancel-in-progress`；**修复 pnpm 安装顺序**（`pnpm/action-setup` 必须在 `setup-node(cache: pnpm)` 之前，否则 `Unable to locate executable file: pnpm`，2026-10-22 实测红） | 小 |
| `.github/workflows/deploy.yml` | **不变**（仍 `workflow_dispatch` only） | — |

### 2.1 首次使用预览环境的准备

仓库里需要存在 `preview` label（已用 `gh label create` 创建；若没有：`Settings → Labels → New label`，或
`gh label create preview -R dsun-io/kaas-platform`）。PR 打上该 label 后才会构建预览；去掉 label 不会自动回收，
需要关闭 PR（或手动 `workflow_dispatch` 跑 teardown）。

## 3. 保留的红线门禁（不建议再砍）

- `frontend` **check** job 的 `pnpm build`：typecheck 抓不到 build 期错误，这是唯一构建门禁。
- backend 的 `sync-shared.ps1` + 三个静态门禁（schema coverage / schema drift / structural debt）：防「代码上线、库没迁」「列漂移 500」。
- `contracts-check` 规则引擎（R1–R5）：只能搬家，不能删。
- `worker:integration`（真 PG，0.56 min/次）：很便宜，且是唯一能抓 `NOT NULL 无默认值 / 漏列` 的用例。

## 4. 如何验证瘦身生效

```bash
gh run list --workflow=frontend-ci.yml --limit 10     # push 触发的 run 里不应再有 e2e job
gh run list --workflow=backend-test.yml --limit 10    # push 的 run 只有 unit-tests + worker-tests
gh run view <run-id> --json jobs --jq '.jobs[].name'  # 核对实际跑了哪些 job
gh run list --workflow=preview.yml --limit 5          # 无 label 的 PR：run 存在但 job 全 skipped（不耗分钟）
```

- 次日 02:00 / 02:30（Asia/Shanghai）应出现 `schedule` 触发的夜间全量 run。
- 额度观察：GitHub → Settings → Billing and plans → Actions（需要 `user` scope 的 token 才能走 API）。

## 5. 回滚 / 恢复原口径

- 恢复 **e2e 每次 push 跑**：删掉 `frontend-ci.yml` 里 e2e job 的 `if:` 行（并把 `pnpm build` 加回只会浪费，不必加）。
- 恢复 **push 必跑真 PG 集成**：删掉 `worker-db-tests` 的 `if:` 行。
- 恢复 **preview 随 PR 自动跑**：把 `preflight` 的 label 判定恢复为 `if: github.event.action != 'closed'`。
- 其它改动均可 `git revert <本提交>` 回退；改动只在 workflow 文件，无代码/配置副作用。

## 6. self-hosted runner（已批准方向，未实施；public 后降为可选）

> **2026-10-22 口径更新**：仓库已转 **public** ⇒ GitHub-hosted 标准 runner 免费无限，**省钱这一动因消失**。
> 本方案降级为**可选优化**（价值点变为：更快的本机缓存/自定义环境；以及"以后若转回 private"的兜底）。

**为什么仍值得留着**：self-hosted runner 的分钟数免费且无上限，且不排 GitHub 托管的队；本仓库推送频率高
（近 30 天 747 提交），有机器时可显著缩短反馈时间。

### 6.1 实施步骤（草案）

1. 准备一台**常开的 Linux 机器**（云主机或常驻开发机；Windows 也能跑，但本仓库 CI 里有 `pwsh` 步骤与 CRLF 差异，Linux 更省心）。
2. 在仓库 `Settings → Actions → Runners → New self-hosted runner` 生成注册命令（或 API：
   `gh api -X POST /repos/dsun-io/kaas-platform/actions/runners/registration-token --jq .token`），
   按提示 `./config.sh --url https://github.com/dsun-io/kaas-platform --token <token>` 并安装为服务。
3. 给 runner 打标签（如 `self-hosted`、`linux-x64`、`ci`）。
4. **按收益顺序**挑 job 改 `runs-on: [self-hosted, linux-x64]`：
   ① `Frontend CI / e2e`（最大头）→ ② `backend:test / 三个 job` → ③ `contracts:check`。
   保守做法：先只改 e2e，观察一周稳定性。
5. **安全前提（public 仓库尤其重要）**：GitHub 官方**不建议**把 self-hosted runner 用于 public 仓库——fork PR 的代码会在
   你的机器上执行。若要接：只把 `runs-on` 给 **push 到 main / workflow_dispatch** 的 job（不要给 `pull_request`），
   敏感机器不要接。

### 6.2 验收

- `gh run list` 中该 job 的 runner 显示为自己机器的名字；
- 跑一轮完整 e2e（27 条）全绿；
- Billing 页面该 workflow 不再消耗 GitHub-hosted 分钟。

### 6.3 回退

把 `runs-on` 改回 `ubuntu-latest` 即可；runner 服务可随时 `./svc.sh stop` 注销。

## 7. 与 Cloudflare Workers Builds 的关系（未接，登记）

- 2026-10-22 评估过「把构建搬到 Cloudflare / Neon」：**可行**，但先做本文件的瘦身（成本更低、零迁移风险）。
- 硬事实（官方额度）：Workers Builds 免费 **3,000 分钟/月、1 并发、单次 20 分钟上限**、2 vCPU/8 GB/20 GB；
  **Neon 不提供构建执行器**（只提供 Postgres 分支/迁移 API），构建只能在 CF 或 GH 侧跑。
- 若之后要搬，按当时的评估执行；**本次不接 CF、不删任何 workflow**。

## 8. 变更记录

- **2026-10-22**：首版。workflow 瘦身落地；self-hosted runner 登记为已批准、未实施。
- **2026-10-22（稍后）**：仓库转 **public** ⇒ 额度问题解除（标准 runner 免费无限）；本口径更新：瘦身保留、self-hosted 降为可选；
  顺手修复 `ts-edge` 的 pnpm 安装顺序（`pnpm/action-setup` 必须在 `setup-node(cache: pnpm)` 之前）。

---

*维护：CI 触发面再变动时同步本文与 `docs/PROBLEM_STATUS_2026-10-11.md` 交接摘要。*