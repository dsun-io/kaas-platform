# QA 越权审计 · 7 条留证（C27 · 2026-10-21）

> **性质**：只读代码审计（未改代码、未跑生产、未用"测试通过"当越权证据）。
> **输入**：`docs/QA_TEST_ACCOUNTS.md:71-82` 的 7 条清单（该清单只有期望、无执行结论）。
> **方法**：`git grep` 定位端点/前端页面 → 读 handler 与鉴权依赖 → 查现有测试/契约 → 逐条三选一结论。
> **证据基准**：`main` @ `ab49811b`（2026-10-20）。行号均为该提交的工作树行号。
> ⚠️ **处理提示**：本文含授权缺陷细节；仓库当前 **public**（`docs/TODO.md` D5），对外披露面需 Lead/用户评估。

## 0. 账号前提核查（先看这一节，否则 7 条都无法真机复现）

| # | 事实 | 证据 |
|---|---|---|
| P-1 | `QA_TEST_ACCOUNTS.md` 引用的创建脚本 **`scripts/seed_qa.py` 不在仓库**（`git ls-files` 无、`git log --all -- scripts/seed_qa.py` 无历史、磁盘亦无）⇒ 账号的 `account_type/role/team_id` **无法从代码复现** | `docs/QA_TEST_ACCOUNTS.md:14,40,44,90,97,99` |
| P-2 | 文档假设「QA 独立租户 `qa-smoke-…`」，但代码是**单租户常量**：`DEFAULT_TENANT = "default"`，且 `users` 表**没有 `tenant_id` 列** ⇒ `_tenant_of()` 恒回落 `"default"` | `backend/worker/src/main.py:46`；`doc_payload.py:39`；`platform/db.py:28`；`models.py:309-330`；`ws_seals.py:62-64` |
| P-3 | 文档假设公章/单证按 `is_internal()` 判定；实际公章**写**闸门是「团队管理员或平台管理员」（403 `TEAM_ADMIN_REQUIRED`），`INTERNAL_ONLY` 只存在于**从未被调用**的 helper | `ws_seals.py:53-59`（定义）、`:119/:261/:283`（实际用 `_require_team_admin`）；`main.py:4672-4693` |

⇒ 真机复现前必须先确认：生产 `qa_user` / `qa_customer` 是否仍存在、其 `account_type/role/team_id`（文档称 internal/user 与 customer/owner，见 `QA_TEST_ACCOUNTS.md:22-23`、`PROBLEM_STATUS:3475`）。本文结论一律基于**代码行为**，不依赖这两个账号的现存状态。

## 1. 结论总表

| # | 条目（QA 期望） | 主要端点 / 页面 | 闸门证据（代码位置） | 结论 | 风险 |
|---|---|---|---|---|---|
| 1 | `qa_customer` 上传/读取公章（403 INTERNAL_ONLY） | `POST/GET /api/v1/tenant/company-seals`、`GET …/{id}/image`；页面 `/settings/company-profile` | 写：`_require_team_admin`→403 `TEAM_ADMIN_REQUIRED`（`ws_seals.py:119/261/283` + `main.py:4672-4693`）；读：**仅登录**，tenant 过滤（`ws_seals.py:185-218` + `_get_or_404:91-101`）；`_require_internal` 定义未用（`:53-59`） | **闸门缺失（风险）** | 中：任何登录账号可读公章列表/图片；写侧拒绝码与期望不符 |
| 2 | `qa_user` 读别家租户的公章/单证（404） | `GET /trade-docs`、`GET /trade-docs/{id}`、`…/render-data`；公章读 | 单证读全部**只按 `tenant_id`** 过滤（`main.py:4189-4250/4481-4502/4855-4867`；`doc_payload.py:182-190`）；`trade_docs` 有 `team_id/owner_id/owner_scope` 列但**读路径未用**（`workstation_links.py:283-286`）；公章读 tenant-only | **闸门缺失（风险）** | 高：任意登录账号可按 id 读任意团队单证；「跨租户」口径不适用（单租户） |
| 3 | `qa_customer` 创建/确认/导出单证（403/404） | `POST /trade-docs`（4341）、`POST …/confirm`（`ws_docs_ext.py:234`）、`POST …/pdf`（`ws_files.py:803`）、`GET …/render-data` | 创建：客户闸门 `_doc_customer`→404（`main.py:1314-1342`，团队可见性），**无 account_type 闸门**；确认/导出：**仅登录**（`ws_docs_ext.py:234-321`，无角色/团队判断） | **闸门缺失（风险）** | 高：customer 账号可确认/导出他人单据（同租户内） |
| 4 | `qa_user` 调 admin 专属接口（403） | `/api/v1/admin/*`（8 端点）、`/api/v1/events`、`/api/v1/admin/accounts*`、`/admin/spec/attribute-proposals*` | 全部 `_require_platform_ops`＝internal+`is_admin_role`（`main.py:160-174,2793,2833,2861,2906,2929,2968,3040`）；账号与提案分别 `_require_system_admin`（`ws_admin_accounts.py:31-33`）/`_require_platform_ops`（`ws_admin_proposals.py:32`） | **已有闸门** ✓ | — |
| 5 | `qa_user` 列表只见自己数据 | `/customers`、文件/产品域列表 | 真源 `scope.is_admin_role`（仅 system_admin）+ `can_view` 四规则（`scope.py:53-90`）；客户列表显式 `owner_id/owner_scope/team_id` 谓词（`main.py:1399-1408`）；文件域 `_team_scope`（`ws_files.py:70-98`）；**单证域不走这套**（见 #2） | **已有闸门** ✓（客户/文件域；单证域缺口见 #2） | 中（单证域）；账号数据面需真机验证 |
| 6 | 无 token / 伪造 token（401） | 全站 | `_get_current_user`：无 Bearer→401、`_decode_token` 过期/伪造→401、用户禁用→401（`main.py:128-157`）。248 个 `@app.*` 路由中仅 11 个不带该依赖，逐一分类见 §2.6（公开/令牌桩） | **已有闸门** ✓ | — |
| 7 | `qa_user` 改系统配置（AI Provider 等）（403） | `PUT /ai/providers/{name}`、`POST …/test`、`PUT /ai/task-bindings/{task_key}`、`POST /ai/tasks/{key}/run`；页面 `/settings/ai-providers` | **无闸门**：仅 `Depends(_get_current_user)`（`chain.py:587-611/614-637/659-691/733`）；前端页面裸 `<RouteGuard>`（`ai-providers/page.tsx:127-128`，未加 `adminOnly`），仅靠侧栏隐藏（`sidebar.tsx:149-150`，契约 `workstations.ts:310-317` adminOnly:true） | **闸门缺失（风险）** | **高**：任意登录账号可改全租户 AI 供应商密钥/base_url/enabled、触发外连测试、切任务绑定 |

**分布**：已有闸门 **3** 条（#4/#5/#6）· 闸门缺失（风险）**4** 条（#1 读侧/#2/#3/#7）· 需真机验证 **0** 条（但 #1/#2/#5 的*账号数据面*需真机确认，见 §0/§3）。
**高风险**：**3** 条（#2 单证跨团队读、#3 单证确认/导出、#7 AI 配置写）+ 1 条中风险（#1 公章读取）。

## 2. 逐条证据

### 2.1 公章上传/读取（#1）
- 端点：`POST/GET /api/v1/tenant/company-seals`（`ws_seals.py:109-198`）、`GET …/{id}/image`（`:201-218`）、`PUT …/{id}/default`（`:254`）、`DELETE …/{id}`（`:283`）。
- 写闸门：三处写端点均 `await _main._require_team_admin(request, user)`；该函数 `is_admin_role` 直接放行，否则要求 `teams.created_by == 自己`，失败 403 `TEAM_ADMIN_REQUIRED`（`main.py:4672-4693`）。
- 读闸门：**无**。`list_seals`/`get_seal_image` 仅 `Depends(_get_current_user)`，按 tenant 过滤；用户行无 `tenant_id` ⇒ 恒 `"default"`。
- `_require_internal`（`ws_seals.py:53-59`，返回 `INTERNAL_ONLY`）在 `git grep '_require_internal('` 下**只有定义与测试**（`tests/test_ws_products_seals.py:340-345`），端点从未调用。
- 测试事实（可作闸门证据，不作越权结论）：`test_seal_management_is_team_admin_only` 明确断言 customer 写三端点 **403 TEAM_ADMIN_REQUIRED**、且**列表 200**（`test_ws_products_seals.py:220-242`）。
- 前端：`canManageSeals = user?.account_type === "internal"` 仅隐藏上传入口（`settings/company-profile/page.tsx:106-112`），注释称「ws_seals.py:46 只允许内部账号」与后端实际（team admin）不符。
- 建议：①若口径仍要「仅内部」，读端点补 `_require_platform_ops` 同口径闸门；②否则把 QA 期望改为「写 403 TEAM_ADMIN_REQUIRED / 读 200（团队成员）」，并修正前端注释与 §0-P3 的文档漂移。

### 2.2 跨租户读公章/单证（#2）
- 「别家租户」不可构造：租户恒 `"default"`（§0-P2）。404 语义实际只覆盖「id 不存在」。
- 公章：`_get_or_404` 用 `WHERE tenant_id=$1 AND id=$2`（`ws_seals.py:91-101`）⇒ 不存在 404，同租户均可读。
- 单证：`GET /trade-docs/{id}`（`main.py:4484`）、列表（`:4194-4208`）、`render-data`（`:4863`）、confirm 的 `_get_doc_or_404`→`doc_payload.py:182-190` 全为 `tenant_id=$1 AND id=$2`；`trade_docs.team_id/owner_id/owner_scope`（`workstation_links.py:283-286`）未被读路径使用。
- 对照：`customers` 列表已按 `owner_id/owner_scope/team_id` 过滤（`main.py:1399-1408`），`file_objects` 读带 `_team_scope`（`ws_files.py:556-607`）——单证域是**同一产品里唯一漏谓词的业务域**。
- 建议：单证读/列表/confirm/pdf 加 `_owner_visible` 或 `team_id` 谓词（与客户/文件域同尺），返回 404 不泄露存在性；QA 期望改为「跨团队 404」。

### 2.3 创建/确认/导出单证（#3）
- 创建：`POST /trade-docs` 仅需登录；`_doc_customer`（`main.py:1314-1342`）对 `customer_id` 做「存在/未软删/可见/同团队」校验，失败 404 `CUSTOMER_NOT_FOUND`；**不校验 `account_type`**。
- 确认：`POST /trade-docs/{id}/confirm`（`ws_docs_ext.py:234-321`）→ `_get_doc_or_404`（tenant-only）→ 状态机/校验/加固闸门，**无角色或团队判断**。
- 导出：`POST /trade-docs/{id}/pdf`（`ws_files.py:803-814`）与 `GET …/render-data`（`main.py:4855`）同样仅登录。
- 测试：`git grep 'CUSTOMER' backend/worker/tests` 命中的相关文件只有 seals/team-scope（`test_ws_products_seals.py`、`test_ws_files_team_scope.py`），**没有 customer×单证授权用例**。
- 建议：confirm/pdf/render-data 至少加团队谓词；customer 账号是否允许操作单证属产品口径（§G 待拍板），若不允许则加 `account_type != "customer"` 闸门并补 403 用例。

### 2.4 admin 专属接口（#4）
- 6 个 `/api/v1/admin/*`：GET/POST `feature_flag`、GET `tenants`、POST `tenants/reload`、GET `audit-log`、GET `archive-logs` → 均在 handler 首行 `_require_platform_ops`（`main.py:2793` 另覆盖 `/api/v1/events`）。
- `_require_platform_ops`＝`account_type=="internal"` 且 `is_admin_role(role)`（`main.py:160-174`）；`qa_user` 若确为 internal/user ⇒ `is_admin_role("user")=False` ⇒ 403。
- 账号/提案端点：`_require_system_admin`（`ws_admin_accounts.py:31-33,53,80`）、`_require_platform_ops`（`ws_admin_proposals.py:32,71,91,108`）。
- 测试：`test_admin_authz.py:38-45` 端点表；`:84-98` customer/internal-member→403、无 token→401；`:101-105` platform admin→200。另有 `test_debug_endpoints_admin_guard.py`。
- 结论：**已有闸门**（代码级 + 测试锁死）。

### 2.5 列表可见性（#5）
- 真源：`kaas_common/workstation/scope.py:53-90`——`is_admin_role` 只认 `system_admin`（`admin` 为历史映射）；`can_view`＝admin / `owner_scope='tenant'` / 本人 / 同团队。
- 客户列表：非管理员追加 `(owner_id=$me OR owner_scope='tenant' OR team_id=$my_team)`（`main.py:1399-1408`）。
- 文件/产品域：`_team_scope`/`_team_scope_soft`（`ws_files.py:70-98`）＋静态审计测试（`test_ws_files_team_scope.py:195-211`）锁「每个落点都带谓词」。
- 单证域：**不适用**（见 #2，缺谓词）⇒ 本条只能算「客户/文件域已有闸门」。
- 文档侧已引用此条：`orchestrator/tests/test_team_scope_rules.py:55-56` 明确写「qa_user 是 internal + role=user，按 QA 第 5 条只能看到自己那套数据」。
- 仍需真机确认：账号实际 `team_id/owner` 数据面（§0-P1）；「隔离租户」表述应改为「同租户内按 owner/team 收窄」。

### 2.6 无 token / 伪造 token（#6）
- `_get_current_user`（`main.py:141-157`）：无 `Bearer`→401；JWT 过期/伪造→401（`_decode_token:128-138`）；用户不存在/非 active→401。
- 全量：248 个路由装饰器中仅 **11** 个在 16 行窗口内无该依赖，逐条定性：
  `/auth/login`、`/auth/register`、`/auth/logout`、`/auth/forgot-password`、`/auth/reset-password`（公开业务，符合预期）；
  `/auth/bootstrap-admin`（`ADMIN_SETUP_TOKEN` Bearer + `hmac.compare_digest`，401/403，`main.py:300-310`）；
  `/health`（探针，`:1925`）；`/company-seals/{id}/render-content`（`:221-251`）与 `/file-objects/{id}/render-content`（`ws_files.py:920`）——**签名令牌**，失败 401 `RENDER_TOKEN_INVALID`；`/outreach/webhook`（501 桩，`chain.py:1955`）；`/api/v1/enums`（公开静态字典，`ws_enums.py:25-32`）。
- 测试：`test_admin_authz.py:93-98` 断言无 token 先 401（非 403）。
- 结论：**已有闸门**；QA 第 6 条可写「覆盖：除 5 个 auth 公开端点、health、2 个签名直链、1 个 501 桩、enums 外，均 401」。

### 2.7 系统配置写（#7）
- `/api/v1/ai/*` 共 8 端点（`chain.py:538,572,587,614,640,659,694,733`），**全部只挂 `Depends(_get_current_user)`**：
  - `PUT /ai/providers/{name}`（`:587-611`）可写 `api_key/model/base_url/enabled`（写库 `ai_providers`）；
  - `POST /ai/providers/{name}/test`（`:614-637`）用库里的 key/base_url 发起真实外连；
  - `PUT /ai/task-bindings/{task_key}`（`:659-691`）可改任务→供应商绑定；
  - `POST /ai/tasks/{task_key}/run`（`:733`）可直接触发 AI 调用（消耗额度/产生 usage）。
- 对照：同属「系统配置」的 admin 6 端点、账号管理、属性提案都有平台闸门（#4）——**只有 AI 配置这一组没加**。
- 前端三层都不闭合：契约 `adminOnly:true`（`shared/contracts/workstations.ts:310-317`）→ 侧栏对非 internal 隐藏（`sidebar.tsx:149-150`）→ **但页面自身 `settings/ai-providers/page.tsx:127-128` 是裸 `<RouteGuard>`（未传 `adminOnly`）**，直连 URL 可打开；后端再放行 ⇒ 「前端隐藏、后端不校验」的旧教训（`main.py:164-166` 注释）在此组重演。
- 测试：`backend/worker/tests` 无 `/ai/providers` 用例（仅前端 MSW mock：`mocks/longtail-handlers.ts:1724-1770`）。
- 建议（不改代码，Lead 定）：4 个写/执行端点加 `_require_platform_ops`；页面改 `<RouteGuard adminOnly>`；补 3 条 403 用例（customer / internal 非管理员 / 无 token 401）。

## 3. 真机验证清单（发布后 P4 用；本审计未能真机执行）

1. 先核实生产账号：`SELECT email, account_type, role, team_id, status FROM users WHERE email LIKE 'qa_%'`（只读）。
2. #1 读侧：`qa_customer` 登录 → `GET /tenant/company-seals`、`GET …/{id}/image`，记录状态码（预测 200）。
3. #2/#3：`qa_customer` 登录 → `GET /trade-docs`、`GET /trade-docs/{id}`、`POST …/confirm`、`POST …/pdf`（预测 200/409，取决于单据状态）。
4. #7：`qa_customer` 登录 → `PUT /ai/providers/deepseek`（body 只改 model，**不要写真实 key**）→ 预测 200（缺失证据即确认）。
5. #4/#6 回归：`qa_user` 调 `/admin/feature_flag` 预测 403；无 token 调任一业务端点预测 401。
6. ⚠️ 真机操作仅用 `qa_*` 账号、只读/可回滚请求；**不要**改生产 AI key、不要删除数据。

## 4. 与现行文档的口径漂移（需同步修正）

| 漂移 | 文档写的 | 代码事实 | 处置建议 |
|---|---|---|---|
| D-1 | 公章/单证按 `is_internal()` → `403 INTERNAL_ONLY`（`QA_TEST_ACCOUNTS.md:32,75`） | 写闸门＝team admin → `403 TEAM_ADMIN_REQUIRED`；`INTERNAL_ONLY` 只在未调用 helper（§0-P3） | 改 QA 清单期望值，或补 internal 闸门（业务口径二选一） |
| D-2 | QA 独立租户 `qa_smoke`（`:25,51,57`） | 单租户常量 `default`，users 无 tenant_id（§0-P2） | 改为「同租户内按 owner/team 收窄」 |
| D-3 | `scripts/seed_qa.py` 创建账号（`:14,40,44,90,97,99`） | 脚本不在仓库、无历史（§0-P1） | 补脚本入库或标注「已下线，账号手工维护」 |
| D-4 | 前端已隐藏入口（隐含安全）（`:32`） | #7 页面裸 `RouteGuard`；#1 前端注释与后端不符 | 前端补 `adminOnly`；注释按后端实际改 |

## 5. 证据索引（复核命令）

```powershell
git grep -n '_require_team_admin' -- backend/worker/src          # #1 写闸门
git grep -n '_require_internal' -- backend/worker/src            # #1 未用 helper
git grep -n '"SELECT \* FROM trade_docs WHERE tenant_id' -- backend/worker/src  # #2 读路径缺谓词
git grep -n '_require_platform_ops' -- backend/worker/src        # #4 平台闸门
git grep -n 'api/v1/ai' -- backend/worker/src/chain.py           # #7 端点清单（均仅登录）
git grep -n 'def _get_current_user' -A 20 -- backend/worker/src/main.py         # #6 401
```

_审计人：DSH branch-audit（只读）· 2026-10-21 · 未改代码/TODO，未提交_
