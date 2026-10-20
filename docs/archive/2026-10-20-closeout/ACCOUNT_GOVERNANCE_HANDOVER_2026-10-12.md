# 账号治理交接文档（2026-10-12）

> **本文是「平台账号/团队治理」这条线的**当前口径**交接文档。**
> 覆盖：生产账号清理、账号治理 API（两端）、前端 UI 待办、门禁实测记录、环境与并发提示。
> 相关旧文：`docs/PROBLEM_STATUS_2026-10-11.md`（问题总账）、
> `docs/QA_TEST_ACCOUNTS.md`（QA 测试账号脚本）。

**一句话结论**：生产库已完成「清空全部团队 + 账号，只留一个系统管理员」；
后端**账号列表 / 停用 / 恢复** API 已两端落盘并通过单测与 route-parity；
**前端页面尚未实现**，其余门禁（frontend typecheck/lint/test、contracts:check、build）**本轮未跑**。

***

## ① 生产数据清理（已完成 · 不可逆 · 已复核）

**用户裁决**（2026-10-12，弹窗确认）：删掉系统中全部团队与账号，并创建一个系统管理员。

| 项 | 清理前 | 清理后 |
|---|---|---|
| 账号（`users`） | 3 | **1** |
| 团队（`teams`） | 1 | **0** |

**被删的 3 个账号**：`admin@kaas.dev`、`qa_user@qa.kaas.internal`、`qa_customer@qa.kaas.internal`
**被删的 1 个团队**：原「安平县联佳丝网制品有限公司」

**新建的系统管理员**（唯一账号）：

| 字段 | 值 |
|---|---|
| email | `david@powervoy.com` |
| 密码 | **不在仓库记录**（由用户当面指定；库里只存 bcrypt 哈希）。⚠️ 处置建议见 §⑥ |
| account_type / role | `internal` / `system_admin` |
| is_tenant_admin | `true` |
| status | `active` |
| team_id | `NULL`（无团队） |

**执行方式**：一次性脚本（事务内，先清子表再删主表，避免外键 `NO ACTION` 撞车）：

1. `DELETE FROM team_subscriptions / team_invites / team_option_overrides`
2. `DELETE FROM user_roles / user_subscriptions / user_customers`
3. `UPDATE teams SET created_by = NULL`；`UPDATE team_invites SET invited_by = NULL, accepted_by = NULL`
4. `DELETE FROM teams` → `DELETE FROM users`
5. `INSERT` 目标管理员

> **为什么不用接口做**：当时系统里**没有**账号删除 API（核实：全仓无 `DELETE /users`、
> 无平台级账号删除端点），且这些数据属"误建/测试"性质，属一次性运维动作。
> 脚本用完即弃，**未入库**（含明文口令，不入仓库）。

**落库后复核输出**（实测）：

```
deleted_users=3 deleted_teams=1
remaining_users=1 remaining_teams=0
{'id': 4, 'email': 'david@powervoy.com', 'account_type': 'internal',
 'role': 'system_admin', 'is_tenant_admin': True, 'status': 'active', 'team_id': None}
```

**复现/复核命令**（只读）：

```powershell
cd backend/orchestrator
$env:PYTHONPATH="."
.venv/Scripts/python.exe -c "..."   # 或直接 psql：SELECT id,email,role,status FROM users;
```

> 生产 DSN 读取方式见本文 §⑥；**不要把明文口令写进任何文件**。
> 另：`lead_candidates.owner_id` 等业务表把 owner 记成**文本 id**（如 `'1'`，非外键），
> 删账号**不会**被子表挡住，也不会级联 —— 历史线索行仍留在库里（预期行为）。

***

## ② 账号治理 API（后端 · 两端已落盘）

### 设计口径（用户已确认：**不做物理删除 API**）

不提供任何 `DELETE` 账号/团队端点。理由：账号关联面广（`user_roles` /
`user_subscriptions` / `user_customers` / 团队归属 / 邀请 / 各表 `created_by`），
外键既有 `CASCADE` 也有 `SET NULL` 还有 `NO ACTION`；物理删除易造成悬挂引用、
审计链断裂、"最后一名管理员被删"导致系统锁死。**改为停用/恢复**（`users.status`）。

`users.status='active'` 本来就是登录与鉴权的硬闸门
（orchestrator `app/core/auth.py:203`、`app/middleware/auth.py:93`；worker `src/main.py:145`），
所以"停用"天然生效、且**非破坏性**。

### 契约（两端完全一致）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/admin/accounts` | 账号列表 |
| `PATCH` | `/api/v1/admin/accounts/{user_id}` | body `{"status": "active"｜"disabled"}` |

**响应键集合（白名单，绝不含 `password_hash` / token）**：

```
{"accounts":[{id,email,display_name,account_type,role,status,
              team_id,team_name,console_access,created_at,updated_at}]}   # GET
{"account":{...同上...}}                                                   # PATCH
```

**鉴权**：仅 `account_type='internal'` 且 `effective_role='system_admin'`
（含历史 `admin` → `system_admin` 映射）放行；internal 普通账号、customer 账号一律 **403**。

**保护规则（PATCH 停用时）**：

| 条件 | 结果 |
|---|---|
| 停用**自己**（`user_id == 当前登录管理员`） | **409** `{"code":"SELF_PROTECT"}` |
| 停用**最后一名** active 管理员（`role ∈ {system_admin, admin}` 计数 ≤ 1） | **409** `{"code":"LAST_ADMIN"}` |
| `status` 非 `active｜disabled` | **422** |
| 目标账号不存在 | **404** |

### 落盘文件

| 端 | 文件 | 说明 |
|---|---|---|
| orchestrator | `backend/orchestrator/app/api/admin_accounts.py` | 新增（路由 + 白名单序列化 + 保护） |
| orchestrator | `backend/orchestrator/app/main.py` | 挂载 `admin_accounts_router`（+2 行） |
| worker | `backend/worker/src/ws_admin_accounts.py` | 新增（同路径同契约的生产镜像） |
| worker | `backend/worker/src/main.py` | 末尾 `import ws_admin_accounts`（+4 行） |
| worker | `backend/worker/tests/_bootstrap.py` | `_SIBLING_MODULES` 登记新模块（**必须**，否则重载 main 后新路由丢失） |
| worker | `backend/worker/tests/test_worker_routes.py` | 新路由登记（2 条） |
| 测试 | `backend/orchestrator/tests/test_admin_accounts.py` | 新增 13 条（无库、`-m unit` 可跑） |
| 测试 | `backend/worker/tests/test_admin_accounts.py` | 新增 11 条（无库；worker 侧**不写** `unit` 标记） |
| 契约产物 | `backend/orchestrator/docs/openapi.json` | 重生成（177 paths，+86 行 = 只有这 2 个路径） |

***

## ③ 门禁实测记录（本轮 · 只有跑过的才算数）

**提交**：`ff9aa73`（10 文件 / +1038 行），已推送 `origin/main`（`8888f2e..ff9aa73`，
复核 `git rev-list --count origin/main..HEAD` = **0**）。

| 门禁 | 命令 | 结果 |
|---|---|---|
| orchestrator 全量单测 | `cd backend/orchestrator && PYTHONPATH=. .venv/Scripts/python -m pytest -m unit -q` | ✅ **1196 passed, 1 skipped, 324 deselected**（40.21s） |
| worker 全量单测 | `cd backend/worker && <orchestrator>/\.venv/Scripts/python -m pytest tests -q` | ✅ **272 passed**（4.76s） |
| orchestrator 新单测 | `pytest tests/test_admin_accounts.py -q` | ✅ **13 passed** |
| worker 新单测 | `pytest tests/test_admin_accounts.py tests/test_worker_routes.py -q` | ✅ **16 passed**（11 + 5） |
| 路由对等 | `python scripts/route-parity.py` | ✅ **PASS**（orchestrator 228 / worker 219 / 缺失 11 全部已登记 / 过期 0） |
| 共享内核一致 | `powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1 -Check` | ✅ **EXIT 0**（共享内核 31 / 报价引擎 22 / 枚举字典 1，全一致） |
| 契约 | `<node> <pnpm.mjs> -C frontend contracts:check` | ✅ **EXIT 0 · PASS R0–R6**（R6：177 paths / 104 模型键集合 / 29 response_model，基准 = HEAD 快照） |
| OpenAPI 重生成 | `cd backend/orchestrator && PYTHONPATH=. .venv/Scripts/python scripts/export_openapi.py` | ✅ **177 paths**（产物 diff = +86 行，**只有**这 2 个新路径） |
| 前端 lint | `<node> <pnpm.mjs> -C frontend lint` | ✅ **EXIT 0**（仅 `no-img-element` 类 warning） |
| 前端单测 | `<node> <pnpm.mjs> -C frontend test` | ✅ **390 passed / 33 files**（7.10s） |
| 前端 typecheck | `<node> <pnpm.mjs> -C frontend typecheck` | ❌ **EXIT 1 —— 2 个既有错误（非本线引入，见下）** |
| `NEXT_EXPORT=1 pnpm build` | — | ⏳ **未跑** |

### ⚠️ 遗留红：前端 `typecheck` 当前是红的（**不是本线引入**）

```
src/app/(app)/onboarding/page.tsx(55,17): error TS2322:
  Type '"/quotes?tab=pricing"' is not assignable to type 'UrlObject | RouteImpl<"/quotes?tab=pricing">'
src/app/(app)/onboarding/page.tsx(80,17): error TS2322:
  Type '"/quotes?tab=product"' is not assignable to type 'UrlObject | RouteImpl<"/quotes?tab=product">'
```

**取证**：`next.config.mjs` 开了 `typedRoutes: true`；出错的
`onboarding/page.tsx` **最后一次提交是 2026-09-27**（`269fc48`），且当前工作树**对该文件无改动**；
**本线 10 个文件里没有一个是前端文件** ⇒ 这是**别线**（改动了路由面 / 类型化路由清单）留的既有红。
**待办**：由前端线修（把这两处链接改成正确的类型化路由，或给该跳转换写法）；
本线**未**顺手改它（跨范围改动需先问 —— AGENTS.md 规则 4）。

***

## ④ 前端 UI（**未实现** · 设计已定稿）

用户在 2026-10-12 明确要求"设计对应的前端 UI"。设计口径（已确认）：

- **入口**：设置页 `settings` 下的「平台账号管理」；**仅 `system_admin` 可见**
  （用 `useRole().isSystemAdmin`，**不能**用现有 `RouteGuard adminOnly` ——
  它只判 `account_type==='internal'`，达不到新口径）。
- **列表列**：邮箱 / 显示名 / 账号类型 / 角色 / 状态 / 团队 / 创建时间。
- **操作**：**停用 / 恢复**（**没有删除按钮**）。
- **二次确认**：停用前弹窗说明「该账号将无法登录；可随时恢复；不会删除历史数据」。
- **错误反馈**：`SELF_PROTECT` / `LAST_ADMIN` → 明确文案阻止；`403` → 无权限。
- **敏感字段**：类型定义不声明 `password/token`；渲染只读白名单列。
- **数据源**：`GET /api/v1/admin/accounts` + `PATCH /api/v1/admin/accounts/{id}`（契约见 §②）。
- **待写文件（建议）**：
  - `frontend/src/app/(app)/settings/hooks/use-accounts.ts`
  - `frontend/src/app/(app)/settings/components/account-management.tsx`
  - `frontend/src/app/(app)/settings/page.tsx`（加 system_admin 入口）
  - `frontend/src/mocks/handlers.ts`（list + patch 的 MSW handler）
  - `shared/contracts/account.ts`（zod）或 `frontend/src/lib/**` 类型 + 组件测试

***

## ⑤ 下一台设备续作清单（按优先级）

1. **修掉 §③ 那个既有前端 typecheck 红**（2 条 typed-route 链接）——它现在是 main 上的门禁红。
2. **实现前端账号管理 UI**（§④ 设计稿），完成后补跑 `typecheck / lint / test` 与
   `NEXT_EXPORT=1 pnpm build`。
3. **端到端验收**：三类账号各验一次 ——
   ① `system_admin` 可列可停用可恢复；② `internal` 普通账号 403 且 UI 无入口；
   ③ `customer` 账号 403；④ 自停 → 409 `SELF_PROTECT`；⑤ 停最后一名管理员 → 409 `LAST_ADMIN`；
   ⑥ 停用后该账号**登录被拒**（`users.status` 闸门）、恢复后可登录。
4. **确认 `david@powervoy.com` 能登录生产**（首次登录即改密口径由用户定；当前**未**实现强制改密）。
5. 若要做团队清理的**常规化**能力：只做「停用」，不做删除（与账号同口径）。
6. 复跑全套门禁的命令（本轮已实测可用）：
   ```powershell
   # orchestrator
   cd backend/orchestrator; $env:PYTHONPATH="."; .venv/Scripts/python.exe -m pytest -m unit -q
   # worker（worker venv 无 pytest ⇒ 用 orchestrator venv 或 uv）
   cd backend/worker; & <orchestrator>\.venv\Scripts\python.exe -m pytest tests -q
   # 路由 + 共享内核 + 契约（pnpm 走自带那份，见 §⑥）
   python scripts/route-parity.py
   powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1 -Check
   & <node.exe> <pnpm.mjs> -C frontend contracts:check     # 必须在"提交 openapi.json 之后"跑
   ```

***

## ⑥ 环境与凭据提示

- **生产 DSN**：`backend/orchestrator/.env` 里的 `DATABASE_URL` 指向 Neon 生产库
  （`ep-small-brook-b54t5318`）；`.env` **未被跟踪** ✓。**注意池化端点直连会握手失败**，
  脚本里需把 `-pooler.` 去掉改用直连端点（本轮实测：带池化 → `ConnectionRefusedError`；
  去池化 + `ssl=require` → 通）。
- **⚠️ 安全检查发现（本轮顺带修的）**：`backend/.tools/{list_columns,list_tables,seed_ports,seed_port_coords}.py`
  这 4 个文件**曾把生产库口令硬编码在源码里**（`DSN = "postgresql://neondb_owner:npg_…@…"`）。
  本轮已把它们**改为从环境变量 `KAAS_DSN` 读取**，仓库**当前快照**不再含该口令 ✓。
  **但 git 历史里仍有**（这四个文件早已在仓库中）⇒ **强烈建议立刻在 Neon 控制台轮换该口令**，
  否则"仓库里的旧口令"仍可直连生产。历史重写属破坏性操作（会影响其他并行线），**未做**，需用户拍板。
  另：`.gitignore` 本就把 `.tools/` 声明为"临时脚本/本地工具，不入库" ⇒
  这 4 个文件属**历史遗留违规**，建议后续删除或按本文档保持"只读 env 变量"形态。
- **不要 `os.environ["DATABASE_URL"]` 事后覆盖**：`app.db.session` 在 import 时已建 engine，
  必须在 import **之前**设好环境变量，或直接自建 `create_async_engine`（本轮做法）。
- **口令**：`david@powervoy.com` 的初始口令由用户当面指定，**本文档不记录明文**
  （库里只存 bcrypt 哈希）。⚠️ 本轮**早期版本的提交里曾出现该明文**（`ff9aa73` 的 §①，
  已在 `b75a055` 之后的提交中改为"不在仓库记录"）⇒ **建议连同 §⑥ 的 Neon 口令一起轮换**，
  或由用户拍板做一次历史重写。
- **本机工具（2026-10-12 实测）**：
  - `node.exe`：`C:\Program Files\nodejs\node.exe`（在 PATH）；
  - **`pnpm` 不在 PATH**，自带一份在
    `C:\Users\河北慷逊公司\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs`
    （同目录 `dependencies\node\bin\node.exe`；**实测两个路径都存在**）。
    调用式：`& "<node.exe>" "<pnpm.mjs>" -C frontend <script>`。
    ⚠️ AGENTS.md 里旧写的 `C:\Users\HJ\…` **不存在**（已在该文档中更正）。
  - **但没有 PowerShell 7**（`pwsh` 不在 PATH，只有 5.1）⇒ 本文档里 `pwsh scripts/…`
    请改用 `powershell -ExecutionPolicy Bypass -File scripts/…`。
  - **提交前把 pnpm/node 的 bin 放进 PATH**：`.husky/pre-commit` 会调 `pnpm lint-staged`，
    否则 `pnpm: command not found`（code 127）导致提交失败。
  - `uv.exe`：`C:\Users\河北慷逊公司\.local\bin\uv.exe`（worker 测试可用它跑 pytest）。
  - **commitlint 的 `subject-case`** 禁止句首/Pascal 大小写 ⇒ subject 用**中文**或全小写才过。

***

## ⑦ 并发与提交纪律（本轮实测快照）

**这个工作区同时有多条线在写**（AGENTS.md 规则 4）。本轮收尾时先看到这些**别线**改动：

```
D  backend/orchestrator/app/services/export_quote/effective_spec.py   # ⚠️ staged 删除幻影
D  backend/orchestrator/tests/test_effective_spec.py                  # ⚠️ 同上
MM docs/PROBLEM_STATUS_2026-10-11.md                                  # ⚠️ 别线（staged + unstaged）
 M backend/orchestrator/app/api/export_quote.py                       # ⚠️ 别线
```

**它们随后被别线自己提交**（`8888f2e docs: 2026-10-12 下午场交接（10 提交）+ AGENTS.md 环境更正与私有 index 补丁`），
⇒ 本线推送后工作区**只剩**：`?? .agent-teams/` 与 `?? .tmp_prod_inventory.py`（别线的临时脚本）。
本线的临时清理脚本（含明文口令）**已删除、未入库**。

**两条必须知道的坑（本轮亲眼见到）**：

1. **`D ` + `??` 同现 = 私有索引提交后没归位共享 index 的幻影**（AGENTS.md 已记录）。
   这次就是这样：文件在**工作树里还在**，只是共享 index 停在旧 HEAD。
   **不要**把它们当成"要删的文件"，更不要裸提交 —— 让**产生它的那条线自己归位**。
2. **`MM docs/PROBLEM_STATUS_2026-10-11.md`**：曾属**别线**在写（staged + unstaged 各一份）；
   等它被别线自己提交后，本线才在该文档**顶部交接摘要**补了「平台账号治理」条目
   （提交 `bb5276e`）✓ 现已同步。
3. **收尾轮（用户指令："整个项目的改动全部推送到远程，不管是不是你改的；但不要提交垃圾或敏感信息"）**：
   实查结果 —— 工作区**已无**任何未提交的项目改动（别线在 `8888f2e` 前后已全部提交并推送）；
   剩下的只有两类**非项目内容**，已按"不提交垃圾"处理：
   - `.agent-teams/`（AgentTeams 协作状态）→ 加入 `.gitignore`；
   - `.tmp_prod_inventory.py`（一次性临时脚本）→ 由新增的 `.tmp_*` 规则忽略
     （**未删除**：属别线文件，不动他人工作树）。
   同时还**顺手修掉了两处敏感信息**（详见 §⑥ 与提交 `fbced67`）：
   `backend/.tools/*.py` 里硬编码的生产 DSN、以及本交接文档早期版本里的管理员明文口令。
   收尾后 `git status --short` **为空**，`HEAD == origin/main == fbced67`。

**本线提交走的私有索引配方**（AGENTS.md 规则 4，含 2026-10-12 的补丁：
归位必须在**清掉 `GIT_INDEX_FILE` 之后**单独执行）：

```powershell
$env:GIT_INDEX_FILE = "$env:TEMP\kaas-idx-$(Get-Random)"
git read-tree HEAD
git add -- <本线路径…>
git diff --cached --stat            # 自检：只应有本线文件
git commit -m "feat(admin): 账号治理 API（列表/停用/恢复，无删除）"
Remove-Item Env:GIT_INDEX_FILE      # ① 先清变量
git add -- <本线路径…>               # ② 再归位共享索引（只动自家路径）
git status --short                  # 自证：自家路径干净，别人的改动原样在
```

***

## ⑧ AgentTeams 任务状态（**最终** · 2026-10-12 17:2x 收尾）

团队 `kaas-account-governance-v2`（captain + backend/frontend/qa 三名成员）→ **已归档（archived）**，
按用户"只做交接、不再进行开发任务"的指令停手：

| 任务 | 内容 | 最终状态 |
|---|---|---|
| t1 | 实现账号治理 API（列表/停用/恢复，无删除） | ✅ **completed**（captain 接管完成，attempt 9；契约 §②，门禁 §③） |
| t2 | 实现账号管理前端界面 | ⛔ **cancelled**（用户指令停手；契约 §②、设计 §④ 已固化，可直接重建任务） |
| t3 | 验收账号治理端到端能力 | ⛔ **cancelled**（同上；验收清单 §⑤-3） |

> **归档不等于丢弃**：任务契约、设计稿、门禁数字与后续清单全部固化在**本文档**里；
> 续作者按 §②（契约）+ §④（UI 设计）+ §⑤（待办）重建任务即可，无需依赖团队状态。
> 协作状态目录 `.agent-teams/` 已加入 `.gitignore`（属本机会话产物，不入库）。

> ⚠️ **t2 的验收命令注意**：成员环境里 `pnpm` 不在 PATH（见 §⑥），且前端 `typecheck`
> 现在**已有 2 条既有错误**（§③ 的遗留红）。captain 已就此发过明确指引：
> 用自带那份 pnpm；**不要**去改 onboarding 那 2 条（跨范围）；t2 的判据是
> "不新增错误 + lint/test 通过"，并在回报中如实说明既有红。
> 若 t2 因此卡死，续作者按 §⑤ 的清单接手即可（契约与设计都已固化在本文档）。

> **过程教训（值得记下）**：t1 先后 8 次尝试均**无可核验产出**（成员反复做超长 grep、
> 单轮耗尽预算却不写码），captain 三次介入后最终自己落盘。
> **监管机制已下发**：① in_progress 任务 ~15 分钟无可核验产出 ⇒ 接管；
> ② 重复无效操作 ~5 分钟 ⇒ 立即接管；③ 每轮末尾必须给短进度（改了哪些文件/下一步/阻塞）。
> 续作者若重建该团队，建议**直接把 §② 的契约抄进任务 description**，并要求成员
> "先写文件再跑测试"，禁止探索性检索占用整轮。
