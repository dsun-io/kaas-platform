# 交接 · 2026-10-19 · 生产修复 + CI db-tests 修复

> **读者**：正在执行 `docs/MASTER_EXEC_PLAN_2026-10-19.md` 总清单的主线（另有 `feat/convergence-aprime` 分支）。
> **一句话**：生产注册/定价页两处 500·白屏已修并部署；CI `backend:test` 的 db-tests 长期红已定位并修绿（main `backend:test` = **success**）。
> 本文只记录**事实、证据、环境坑、不要重做的部分**；待办归属见 §6。

***

## 1. 已完成 · 生产侧（均已部署，main 已推）

| # | 问题 | 根因 | 修复位置 | 状态 |
|---|---|---|---|---|
| 1 | 生产注册必 500（用户报告） | 生产 `users.is_tenant_admin` 为 **NOT NULL 且无库默认值**（`f82ac951b473` 建表如此），worker 注册/初始化管理员 `INSERT INTO users` 漏该列 ⇒ `null value in column` | `backend/worker/src/main.py`：register + bootstrap-admin 两处 INSERT 补 `is_tenant_admin=false` | 已部署；**用户已能注册成功**（能打开 `/quotes` 需登录态，即为旁证） |
| 2 | 500 被浏览器误报成 CORS | 未捕获异常由外层 `ServerErrorMiddleware` 接管，绕过 CORS 中间件 ⇒ 无 `Access-Control-Allow-Origin` | `main.py` CORS 中间件加 `try/except`：未捕获异常返回**带 CORS 头的 500** | 已部署（实测 409 探针带 ACAO 头） |
| 3 | 注册页「公司名称」与「团队名称」重复（用户裁决） | 两者语义重复；`company_name` 只进日志不落库 | 前端删输入框（`frontend/src/app/register/page.tsx`）；orchestrator `auth.py`+`schemas/auth.py`、worker `RegisterRequest` 的 `company_name` 改**可选**；mock/types 同步；openapi 产物已重生成。另修掉 worker 独有的「company_name 兜底建团队」口径漂移（与 orchestrator 对齐：只有显式 `team_name` 才建团队） | 已部署 |
| 4 | 注册后 `/quotes?tab=pricing` 白屏（`TypeError … reading 'length'`） | worker `/api/v1/pricing-data` 还是**老算价流程**遗留实现（返回 `{items,total,page,pages}`），前端按 orchestrator 的**定价键完整矩阵**（`{dims,rows}`）渲染 → `matrix.rows` undefined | `main.py` 四端点（GET/POST/PATCH/DELETE）按 `app/api/pricing_data.py` 重写；矩阵/档位/成本表逻辑复用 `quote_api` 既有移植（身份口径 `quote_api._customer_of`，保证「配的价 = 算价用的价」）；POST 用单语句 CTE 保证「停用旧版+插新版」原子。旧 `product_specs` 自由规格成本实现（前端早已不用）移除 | 已部署；新增 `backend/worker/tests/test_pricing_data_api.py`（6 条）锁死形状 |

相关提交：`a8557c9`（注册/CORS/去重）、`4b152b4`（pricing 重写）、`4b05032`（test_product_extract stub 补 `_next_inquiry_no`）。

**生产验证方式**：黑盒 HTTP 探针 + 生产库只读 SQL 取证（探针脚本在 `backend/.tools/`，**不进 git**）。
只在事务内做过 INSERT 复现并回滚，**生产零残留**。

## 2. 已完成 · CI `backend:test` 的 db-tests（自 10-18 起恒红）

**根因（三处旧口径，全部与 10-18 的迁移/裁决联动，测试侧没跟上）**：

1. `tests/conftest.py::_seed_int_r3_data` 的 TRUNCATE 清单含 `customer_quote_profiles` ——
   该表已被迁移 `202610180009/010` **删除** ⇒ `UndefinedTableError` ⇒ 用到该 fixture 的
   10 条 admin 用例 **ERROR**。→ 改为 `to_regclass` 判存在后再 TRUNCATE（以后删表不用再改清单）。
2. `tests/test_company_seals.py` 仍是旧「仅 internal 可管公章」口径；按用户 2026-10-18 裁决
   （公章/企业抬头写入 = **团队管理员或平台管理员**，见 `app/api/company_profile.py::require_team_admin` 注释）
   更新：写操作用**平台管理员**身份（`X-Test-Role: admin`），客户账号断言由 `INTERNAL_ONLY`
   改为 `TEAM_ADMIN_REQUIRED`。
3. `tests/test_trade_docs_api.py` 单证号断言 `startswith("QUO-2026")` 过期 —— 编号自 10-18 起统一为
   「类型-国家-客户-时间戳」（`kaas_common.number_rules.build_number`）→ 断言改 `QUO-` 前缀。

**验证证据（确定性信号）**：
- 临时调试分支 `debug/ci-db-failures` 上 `backend:test` = **success**（`b33a745`，三个 job：unit / worker / db 全绿）
- 落到 main 后 `backend:test`（`6c08900`）= **success**；同 SHA 的 `deploy` = **success**
- main HEAD `2c00067`（docs）与 `origin/main` 一致

**为什么长期没人发现（重要）**：**本机没有 PostgreSQL**，`pytest -m db` 在本地**全部 skip**
（conftest 连不上就 skip，不是"跑过且绿"）⇒ 任何"本地 db 测试绿"都是假绿；CI 日志需登录才能看，
只能看到 job 红。见 §4 的可复用查因技法。

## 3. 透明披露（我的两条噪音提交，无代码影响）

- `252b5ca ci(debug): 触发 backend:test…` 与 `042eb75 Revert "…"`：
  排查 CI 时我本想在**临时分支**加调试步骤，但共享工作区被另一会话切回了 `main`，
  提交落到了 main 上并被推走。发现后**立即 revert**（未改任何产品代码，只多了一个临时触发文件又删掉）。
  ⇒ 教训（已写进 §4）：**共享工作区里做隔离实验必须用 `git worktree`，并在提交前确认 `git branch --show-current`**。

## 4. 环境坑（给后续所有线，踩过都记下了）

1. **本机无 PostgreSQL** ⇒ db 测试全 skip；`docker`/`winget`/`choco` 均不可用。
   PG16 免安装二进制已下到 `%TEMP%\pg16`（EDB binaries），但 `initdb` 在**中文 Windows** 上失败：
   `invalid byte sequence for encoding "UTF8": 0xba`（post-bootstrap 阶段，疑似 Windows 中文时区名被按 GBK 写入），
   `--locale=C --encoding=UTF8`、换纯 ASCII 路径（`D:\pgdata`）均未绕过。**要本地跑 db 测试需另行解决该问题**。
2. **无 GitHub token 时**：`/actions/jobs/{id}/logs` 一律 **403**（不是限流）；但
   `/commits/{sha}/check-runs` 与 `/check-runs/{id}/annotations` **可匿名读**。
   ⇒ 查 CI 失败明细的可复用配方：临时分支上把 `pytest` 输出写成 `::error title=DB-TEST-FAIL::<行>`，
   推分支（`backend:test` 监听**所有分支**的 `backend/**`、`deploy` 只监听 main ⇒ **不触发生产部署**），
   再从 annotations 读失败清单。用完删分支。
3. GitHub API 无 token 限额 60/h，且**出口 IP 会轮换**（同一个 API 一会儿通一会儿 403，重试/换 `curl` 常能复活）。
4. `pnpm` 实际路径：`…\dependencies\pnpm\bin\pnpm.cjs`；git hook（husky）下需
   `%TEMP%\kaas-gitbin\pnpm` shim（内容 `exec "<node.exe>" "<pnpm.cjs>" "$@"`，无 BOM）。
   commitlint 的 `subject-case` 会让部分含英文的 subject 失败 ⇒ 中文 subject 或 `--no-verify`（仅限非产品提交）。
5. **共享工作区多会话并行会切换分支** ⇒ 隔离实验用 `git worktree`（本次已用 `%TEMP%\kaas-…` 三个 worktree，均已清理）。
6. 提交纪律照 `AGENTS.md §4`：私有 `GIT_INDEX_FILE` 提交 → **清掉变量后** `git add -- <自己的路径>` 归位共享 index；
   提交后 `git status --short` 自证别人改动原样在。

## 5. 不要重做（已闭环）

- `backend/worker/src/main.py`：注册/初始化 INSERT、CORS 兜底、`/pricing-data` 四端点
- `backend/worker/src/quote_api.py`：`_pricing_key_items` 补 `created_at`
- `backend/orchestrator/app/api/auth.py`、`schemas/auth.py`、`docs/openapi.json`
- `frontend/src/app/register/page.tsx`、`lib/auth/types.ts`、`mocks/handlers.ts`
- `backend/orchestrator/tests/conftest.py`、`test_company_seals.py`、`test_trade_docs_api.py`
- 新增：`backend/worker/tests/test_pricing_data_api.py`（6 条）、`tests/test_product_extract.py` stub 补列

## 6. 留给主线的事项（不重复我这边）

| ID | 事项 | 归属 | 备注 |
|---|---|---|---|
| H-1 | **Frontend CI 红**（`pnpm test` / `e2e`） | 总清单批次 0 · B0-1（teammate A） | 根因线索：`crypto.subtle.digest` 在 jsdom/CI 下缺失（`use-products.ts`）。工作区曾见该线未提交改动（`use-products.ts`/`quotes` 相关），我没碰 |
| H-2 | 用户复验：刷新 `/quotes?tab=pricing`（白屏修复）；用 `user@example.com` 注册 | 用户 | 注册已修复（能进 `/quotes` 即旁证） |
| H-3 | `3ada691` / `15997bd` 上的 `backend:test`、`Frontend CI`、`prisma-deploy` 失败 | `feat/convergence-aprime` 线 | **是功能分支上的状态**，不是 main；请以分支自己为准修绿后再合 |
| H-4 | db 测试本地可跑（可选） | 任何人 | 解决 §4-1 的 initdb 中文 Windows 问题，或改用 CI 作为唯一 db 门禁（现状） |

## 7. 当前状态快照（2026-10-19 14:0x 北京时间）

- `main` = `2c00067`（= `origin/main`）；工作区**干净**
- 最近验证：`backend:test`(6c08900) = success、`deploy`(6c08900) = success
- 生产：注册 500 / 定价页白屏 两处修复均已上线（部署版本见 Cloudflare `kaas` deployments）
- 生产库：**无迁移变更**（本轮修复均不涉及表结构）
