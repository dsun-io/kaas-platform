# QA 越权修复 · 验收清单（C27 · 2026-10-21）v2

> **用途**：align-b 完成 task-49（4 类越权闸门修复 + R-1 并入）后的**独立验收矩阵**。本文件只定义"该验什么、期望什么、证据在哪"，不改代码、不执行验收。
> **v2 变更（2026-10-21 Lead 裁决 P1–P6 全部落定 + R-1 并入）**：矩阵 A 加读端点；矩阵 B/C 加 `PATCH /trade-docs/{id}`；无团队统一 404；公章读收紧；前端 adminOnly。裁决见 §9，实现以 align-b task-49 为准。
> **验收口径**：①代码级（依赖覆盖 + FakeDb，断言状态码，不依赖真实库）②既有测试回归 ③真机黑盒（发布后 P4，仅拒绝路径）。**不得用"测试通过"当越权证据**——每条须给「请求 → 状态码 → 断言位置」。
> ⚠️ 仓库当前 public（TODO D5）：本文含越权矩阵，披露面需 Lead/用户评估。

## 0. 修复范围与验收基线

| 类 | 修复目标（task-49，含裁决） | 修复前证据 | 验收通过条件 |
|---|---|---|---|
| F1 | AI **读写全部** admin-only（写/执行 4 + 读 4）；前端页面 `adminOnly` | `chain.py:538-733` 全部仅登录；`ai-providers/page.tsx:127-128` 裸 RouteGuard | §2 矩阵全绿 + 新增 403/401 用例 + 既有 admin 闸门不回退 |
| F2 | 单证读（列表/详情/render-data）→ team/owner；**internal（含非管理员）显式 bypass 跨团队**；customer 仅本团队/owner | `main.py:4189-4250/4481-4502/4855-4867`；`doc_payload.py:182-190` tenant-only | §3 读矩阵全绿 + 跨团队 404 不泄露存在性 |
| F2b | **R-1**：`PATCH /trade-docs/{id}`（含 doc_no、`draft→issued`）→ 读+写闸门；customer 仅自己/本团队且 draft；跨团队 404；非团队管理员改 issued / 签发 403 | `main.py:4505` 仅 tenant 过滤、无角色闸门 | §3 写矩阵全绿 + 顺序断言 |
| F3 | confirm/pdf → 团队管理员或 internal | `ws_docs_ext.py:234-321`；`ws_files.py:803` 仅登录 | §4 矩阵全绿 + "404 先于 403" |
| F4 | 公章**读**收紧为 team admin 或 internal（普通成员 403 `TEAM_ADMIN_REQUIRED`）；写侧不变；签名 render-content 不受影响 | `ws_seals.py:185-218` 读仅登录 | §5 矩阵全绿 + §6 写侧不回退 |

**门禁基线（不得减少）**：worker `1391 passed + 12 skipped`（无库）；动 `kaas_common` 必跑 `powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1 -Check`；若改前端 `ai-providers` 页：`pnpm typecheck; pnpm lint; pnpm exec vitest run --maxWorkers=2`（743 基线）+ `route-guard` 用例。

## 1. 角色夹具（S1–S7）与构造方式

| 代号 | 角色（`account_type` / `role` / `team_id`） | 说明 | 测试里怎么造 |
|---|---|---|---|
| S1 | internal / system_admin / 任意 | 平台管理员（`is_admin_role=True`） | `app.dependency_overrides[_get_current_user]=lambda: S1`（同 `tests/test_admin_authz.py:25-28`） |
| S2 | internal / user / 有团队或 None | 内部普通成员（**非**平台管理员；F2 中按裁决可跨团队读） | 同上；**须验证实现是显式 internal bypass，而不是靠 `_team_scope`** |
| S3 | customer / owner / team A 且 `teams.created_by=S3.id` | 客户团队管理员 | 同上 + FakeDb 使 `teams.created_by` 命中 |
| S4 | customer / user（或 owner）/ team A，非 `created_by` | 客户团队成员 | 同上 |
| S5 | customer / owner / `team_id=NULL` | 无团队客户账号（**详情/写一律 404**，裁决 D3） | 同上 |
| S6 | customer / owner / team B | 另一团队客户（跨团队 404 判定对象） | 同上 |
| S7 | 无 `Authorization` / 伪造 token | 未认证 | 不覆盖依赖，或 `Bearer forged`（`main.py:128-138` → 401） |

数据夹具：`trade_docs(id, tenant_id='default', team_id=A|B|NULL, owner_id, owner_scope, status='draft'|'issued')`（列存在：`workstation_links.py:283-286`）；`tenant_company_seals(tenant_id='default', id)`；FakeDb 按 SQL 返回/不返回行即可覆盖 404 与过滤分支。

## 2. 矩阵 A — AI 配置（F1：读 + 写/执行全部 admin-only）

端点：读 `GET /ai/tasks`、`GET /ai/providers`、`GET /ai/task-bindings`、`GET /ai/usage`；写/执行 `PUT /ai/providers/{name}`、`POST /ai/providers/{name}/test`、`PUT /ai/task-bindings/{task_key}`、`POST /ai/tasks/{task_key}/run`。

| 组 | S1 | S2 | S3 | S4 | S5 | S6 | S7 |
|---|---|---|---|---|---|---|---|
| 4 个读端点 | **200** | **403** | **403** | **403** | **403** | **403** | **401** |
| 4 个写/执行端点 | **200** | **403** | **403** | **403** | **403** | **403** | **401** |

- S1 合法请求体（如 `{"model":"x"}`，**不写真实 key**）→ 200；其余 403 且 `detail.error=="forbidden"`（`_require_platform_ops` 同口径，`main.py:160-174`）；S7 先 401。
- 前端：`/settings/ai-providers` 在 S2 直连 URL 应被 `RouteGuard adminOnly` 拦（"您没有访问此页面的权限"）；S1 放行；契约 `workstations.ts:310-317` adminOnly:true。
- 若 align-b 认为 `GET /ai/tasks`（纯元信息）不必收紧，须在报告说明并把本行拆开；默认按裁决全部收紧。

## 3. 矩阵 B — 单证读（F2）+ PATCH 写/签发（F2b/R-1）

读端点：`GET /api/v1/trade-docs`、`GET /trade-docs/{id}`、`GET /trade-docs/{id}/render-data`（经同一 `_get_doc_or_404` 的读端点同口径）。夹具 docA(team=A, draft)、docB(team=B)、docNull(team NULL)、docAIssued(team=A, issued)。

| 读 | S1 | S2 | S3(teamA) | S4(teamA) | S5 | S6(teamB) | S7 |
|---|---|---|---|---|---|---|---|
| 列表（断言只含可见行+total） | 200 全量 | **200 全量**（internal bypass） | 200 仅 A | 200 仅 A | **403 `NO_TEAM`** | 200 仅 B | 401 |
| 详情/render-data docA | 200 | **200** | 200 | 200 | **404** | **404** | 401 |
| 详情 docB | 200 | 200 | **404** | **404** | 404 | 200 | 401 |
| 详情 docNull（历史 NULL） | 200 | 200 | **404** | **404** | 404 | **404** | 401 |

写端点：`PATCH /api/v1/trade-docs/{id}`（R-1 并入）——三个动作：A1 改字段（draft）、A2 `draft→issued`（签发）、A3 改已 issued 单。判定顺序：**401 → 404（不可见/跨团队/无团队）→ 403（可见但角色不足）→ 200/409（业务规则）**。

| PATCH 动作 / 夹具 | S1 | S2 | S3(teamA) | S4(teamA) | S5 | S6(teamB) | S7 |
|---|---|---|---|---|---|---|---|
| A1 改 docA(draft) 字段 | 200 | 200 | 200 | **200**（customer 可改本团队 draft） | 404 | 404 | 401 |
| A2 docA draft→issued | 200 | 200 | 200 | **403 `TEAM_ADMIN_REQUIRED`**（签发动作） | 404 | 404 | 401 |
| A3 改 docAIssued | 200 | 200 | 200 | **403 `TEAM_ADMIN_REQUIRED`**（非团队管理员改 issued） | 404 | 404 | 401 |
| A1/A2/A3 对 docB | 200 | 200 | **404** | **404** | 404 | 200（自己的团队） | 401 |

- 409 不是越权：`DOC_NO_LOCKED`/`DOC_NO_TAKEN`/`ILLEGAL_TRANSITION` 属业务规则，验收时**不得**把 409 记成"闸门生效"。
- 裁决 D2 的落地解释：`draft→issued` 等同"签发动作"，按 F3 口径限制（S4 403）；align-b 若认为不该限制须先回报 Lead 再改本行。
- 404 一律走 `DOC_NOT_FOUND`（不泄露存在性）；列表过滤必须是 SQL 谓词（`team_id=`/`owner_id=`/`owner_scope='tenant'`），不能取回后过滤（否则 total 泄露行数）。
- 实现要点：internal bypass 须在 team scope helper 里**显式**判断 `account_type=="internal"`（否则 S2 无团队会掉进 `NO_TEAM` 分支，`ws_files.py:70-98` 的现有 `_team_scope` 就是这种形状）。

## 4. 矩阵 C — confirm / pdf / 签发路径（F3）

端点：`POST /trade-docs/{id}/confirm`（`ws_docs_ext.py:234`）、`POST /trade-docs/{id}/pdf`（`ws_files.py:803`）、以及 §3 的 `PATCH draft→issued`（同一签发口径）。顺序：**401 → 404 → 403 → 200**。

| 夹具 | S1 | S2 | S3(teamA) | S4(teamA) | S5 | S6(teamB) | S7 |
|---|---|---|---|---|---|---|---|
| confirm docA（draft，必填齐全） | 200 | 200 | 200 | **403 `TEAM_ADMIN_REQUIRED`** | **404** | **404** | 401 |
| confirm docB（对 S3/S4/S6） | 200 | 200 | 404 | 404 | 404 | 200 | 401 |
| pdf docA | 200 | 200 | 200 | 403 `TEAM_ADMIN_REQUIRED` | 404 | 404 | 401 |
| PATCH draft→issued docA | 200 | 200 | 200 | 403 `TEAM_ADMIN_REQUIRED` | 404 | 404 | 401 |

- 200 路径要造"可确认"合法数据（draft + 必填 + 无 blocking 事实），否则拿到 422/409 是**业务校验**、不能当作闸门生效。
- S4 对 docB 必须是 **404**（证明"可见性判定先于角色判定"），不是 403。

## 5. 矩阵 D — 公章读（F4：team admin 或 internal）

端点：`GET /api/v1/tenant/company-seals`（列表）、`GET …/{id}/image`；`GET …/{id}/render-content` 走签名令牌（不受角色影响）。

| 端点 | S1 | S2 | S3 | S4 | S5 | S6 | S7 |
|---|---|---|---|---|---|---|---|
| 列表 / 看图 | 200 | **200**（internal） | **200**（团队管理员） | **403 `TEAM_ADMIN_REQUIRED`** | 403 | 403 | **401** |
| render-content 无 token | 401 `RENDER_TOKEN_INVALID`（与角色无关） | ← | ← | ← | ← | ← | 401 |
| render-content 有效 token | 200（令牌即授权，`ws_seals.py:221-251`） | ← | ← | ← | ← | ← | — |

- 写侧（上传/设默认/删除）**不回退**：S1 200、S3 200、S4/S5/S6 403 `TEAM_ADMIN_REQUIRED`、S2 403（internal 非管理员、无团队）；S7 401。
- 公章为租户级资产、无 `team_id` 列 ⇒ S3（任一客户团队管理员）可读全租户公章，这是裁决 D4 的可执行含义（已知并接受）。

## 6. 既有闸门回归（不得回退）

| 组 | 断言 | 证据/命令 |
|---|---|---|
| admin 6 端点 + `/events` | S2/S3/S4 → 403、S7 → 401、S1 → 200 | `test_admin_authz.py::test_non_platform_operator_gets_403 / test_no_token_still_401_before_403 / test_platform_admin_allowed` |
| 账号/提案/调试端点 | customer/internal 非管理员 403 | `test_admin_accounts.py`、`test_admin_proposals.py`、`test_debug_endpoints_admin_guard.py`、`test_events_admin_gate.py` |
| 文件域团队谓词 | 别团队 404、无团队 403、历史 NULL 普通成员 404 | `test_ws_files_team_scope.py`（含静态审计 `test_每处落点都带谓词或写入带team_id`） |
| 客户列表可见性 | owner/tenant/team 三谓词 | `main.py:1399-1408`；`orchestrator/tests/test_team_scope_rules.py` |
| 公章写 | S4 → 403 `TEAM_ADMIN_REQUIRED` | `test_ws_products_seals.py:220-242`（其"读列表 S4=200"断言需随 F4 改为 403） |
| 全量 worker | ≥ `1391 passed + 12 skipped` | `cd backend/worker; uv run --frozen --with pytest --with httpx2 python -m pytest tests -q` |

## 7. 应有测试落点（验收时逐项找）

| 类别 | 期望新增/扩展 | 至少覆盖 |
|---|---|---|
| F1 | `test_ai_config_admin_guard.py`（新） | 8 端点（4 写 + 4 读）× {S1 200, S2 403, S3 403, S7 401} parametrize |
| F2 | `test_trade_docs_team_scope.py`（新） | 列表过滤（total+items）、详情/render-data 跨团队 404、同团队 200、S2 internal 跨团队 200、S5 列表 403/详情 404、docNull 404、S7 401；静态断言读路径 SQL 含 team/owner 谓词 |
| F2b | `test_trade_docs_patch_authz.py`（新） | A1/A2/A3 × 角色矩阵；跨团队 404 先于 403；`doc_no` 锁定 409 与越权 403 区分 |
| F3 | `test_trade_doc_confirm_authz.py`（新） | confirm/pdf × 角色矩阵 + "404 先于 403" |
| F4 | 扩展 `test_ws_products_seals.py` | 读端点 × {S1/S2/S3 200, S4/S5/S6 403, S7 401}；写侧旧断言保持 |
| 前端 | `route-guard.test.tsx` + ai-providers 页面测试 | S2 直连 URL 被拦、S1 放行 |

## 8. 真机黑盒（发布后 P4；只验拒绝路径）

- 账号：新造一次性 `qa_authz_*` 临时账号（独立团队）验收后删除；不复用生产 `qa_customer` 既有数据做写操作。
- 只对**拒绝路径**发请求：S2/S4/S5/S6 调 F1/F2/F2b/F3/F4 端点断言 403/404；S7 断言 401。
- 200 路径仅在只读端点（如 S1 读列表）；**不要**改生产 AI key/base_url、不要 confirm/pdf 生产单据。
- 记录：`时间 | 账号类型 | 方法+URL | 状态码 | 响应 code | 结论`，curl 用变量占位，不落明文。

## 9. 裁决记录（2026-10-21 Lead，取代 v1 的 P1–P6）

| 原 ID | 裁决 | 对矩阵的影响 |
|---|---|---|
| D1（原 P1） | internal 角色（**含非管理员**）允许跨团队**读**（显式 bypass，避免 `NO_TEAM`）；customer 仅本团队/owner。写仍按各端点角色闸门（AI 写 admin-only） | §3 读矩阵 S2=200；§2 S2=403 |
| D2（原 R-1） | `PATCH /trade-docs/{id}`（含 doc_no、`draft→issued`）并入本次：读+写闸门；customer 只能改自己/本团队且 draft；跨团队 404；非团队管理员改 issued 403 | 新增 §3 写矩阵 + §4 末行 |
| D3（原 P2） | 无团队详情统一 **404**（不泄露存在性） | §3 详情 S5=404；列表仍 403 `NO_TEAM` |
| D4（原 P3） | 公章读 = team admin 或 internal；普通成员 403 `TEAM_ADMIN_REQUIRED`；签名 render-content 不受影响 | §5 读矩阵 |
| D5（原 P4/P5） | AI **读**端点也 admin-only | §2 读矩阵 |
| D6（原 P6） | 前端 `/settings/ai-providers` 加 `adminOnly` | §2 前端行 |

**剩余实现细节（非策略，align-b 定并写进报告）**：错误码措辞（403 `forbidden` vs `TEAM_ADMIN_REQUIRED`）、`GET /ai/tasks` 是否真需收紧（默认收紧）、PATCH 对 `owner_scope='tenant'` 行的可见性、internal bypass 的辅助函数命名与复用位置。

## 10. 验收记录表（2026-10-21 复核已填）

> **复核方式**：`git show 3d56d76c` 读代码 diff + 逐文件定位测试 + 跑全量/定向。复核时 HEAD = `d4007a10`（期间未变动；`3d56d76c/d3a99539/57aa7b45` 均为其祖先）。**只读复核，未改代码、未提交。**

| 矩阵 | 用例数 | 通过 | 失败 | 证据（文件:用例名 / 命令输出摘要） | 验收人 | 时间 | 结论 |
|---|---|---|---|---|---|---|---|
| §2 F1 读写 | 40 | 40 | 0 | `test_ai_config_admin_guard.py`：8 端点（4 读+4 写）×〔S2/S3/S4→403 且 `detail.error=="forbidden"`、无 token→401、S1→200〕；代码 8/8 端点均调 `_require_ai_admin`→`_require_platform_ops`（`chain.py:31,556,586,603,630,657,678,717,754`） | branch-audit | 2026-10-21 00:22 | ✅ |
| §3 F2 读 | 26 | 26 | 0 | `test_trade_docs_team_scope.py`：`test_list_filters_by_team_or_owner`、**`test_list_uses_sql_predicate_not_post_filter`**（断言 SQL 含 `team_id = $2` / `owner_id = $` / `COUNT(*) FROM trade_docs`）、`test_list_admin_and_internal_have_no_team_predicate`（阳性对照）、`test_list_no_team_customer_403_without_querying`、detail/render-data 参数化（跨团队/NULL/无团队→404）；代码 `main.py:4272-4290`（列表 SQL 谓词）、`:4619`/`:5018`（详情/render-data 先判可见性） | branch-audit | 2026-10-21 00:22 | ✅ |
| §3 F2b PATCH | 19 | 19 | 0 | `test_trade_docs_patch_authz.py`：A1 S4→200 / A2 S4→403 `TEAM_ADMIN_REQUIRED` / A3 S4→403 / 跨团队 404（`test_a1_cross_team_or_no_team_is_404_before_write`、`test_a2_cross_team_issue_404_before_403`）+ `test_member_cannot_bypass_via_doc_no_on_issued_doc`（403 先于 409）；代码 `main.py:4644-4651`（可见性→角色→业务校验，顺序正确） | branch-audit | 2026-10-21 00:22 | ✅ |
| §4 F3 confirm/pdf | 13 | 13 | 0 | `test_trade_doc_confirm_authz.py`：`test_confirm_cross_team_or_no_team_404_before_403`、S4→403 `TEAM_ADMIN_REQUIRED`、S2/S3 过闸落到业务层（409/422）、pdf 同矩阵（特权→503 过闸）；代码 `ws_docs_ext.py:248-251`（404 后 403）、`ws_files.py:821-822`（404 后 403） | branch-audit | 2026-10-21 00:22 | ✅ |
| §5 F4 公章读 | 7 | 7 | 0 | `test_ws_products_seals.py::test_seal_read_matrix`（S1/S2/S3→200、S4/S5/S6→403 `TEAM_ADMIN_REQUIRED`，列表+看图双端点）+ `test_seal_render_content_unaffected_by_role_gate`（无 token→401）；代码 `ws_seals.py:67,207,225` | branch-audit | 2026-10-21 00:22 | ✅ |
| §6 回归 + 全量 | — | 全绿 | 0 | 全量 `1523 passed, 12 skipped in 36.03s`（`pytest tests -q`）；5 个 authz 文件定向 `124 passed in 2.86s`；公章**写侧**三端点仍 customer→403 `TEAM_ADMIN_REQUIRED`（`test_seal_management_is_team_admin_only` 未放宽）；改动的既有测试（`test_ws_render_pdf.py`、`test_ws_render_fingerprint_check.py`）只换夹具用户/补 team 字段，**断言未放宽** | branch-audit | 2026-10-21 00:23 | ✅ |
| §7 测试落点齐备 | 5/5 文件 | 5 | 0 | 4 新建（`test_ai_config_admin_guard` / `test_trade_docs_team_scope` / `test_trade_docs_patch_authz` / `test_trade_doc_confirm_authz`）+ 1 扩展（`test_ws_products_seals`）；唯前端页面级用例缺（见 D-1） | branch-audit | 2026-10-21 00:23 | ✅（附 D-1） |

### 10.1 偏差与未覆盖断言（均不影响"4 类越权已修"结论）

| # | 等级 | 内容 | 建议 |
|---|---|---|---|
| D-1 | 中 | 前端 `/settings/ai-providers` 已改 `<RouteGuard adminOnly>`（`page.tsx:127-130`），但 fix commit **未新增页面级前端测试**；既有 `route-guard.test.tsx` 只覆盖 `adminOnly` 语义，不覆盖"本页确实接了这个 prop" | 补一条页面测试（mock auth=customer 渲染"无权限"）；或由 Lead 接受 route-guard 通用覆盖 |
| D-2 | 低 | AI 矩阵 S5/S6（无团队/别团队 customer）未显式参数化（仅 S2/S3/S4） | 行为同走 `_require_platform_ops`→403；如需逐格对应可 +2 参数 |
| D-3 | 低 | 单证**列表**缺 `no-token 401` 用例（detail/render-data/confirm/pdf/patch 均有 401 断言） | 端点有 `Depends(_get_current_user)`，风险低；建议补 |
| D-4 | 低 | render-data 缺单独 401 断言（可见性矩阵已覆盖 404） | 同上 |
| D-5 | 低 | internal 跨团队**写**（S2 对 team B 单据 PATCH→200）未单列；A1 用 S2(team=None) 对 team A 单据 200，等价覆盖 internal bypass | 语义等价，可接受 |
| D-6 | 观察（不在 F1–F4） | `ws_docs_hardening.py` 写端点（facts confirm / doc-set PUT / receipts POST / verify-export）本次只加**可见性 404**（`_doc_404(..., user)`），未见"团队管理员/internal"角色闸门——与 F3「签发类动作」口径可能不一致 | Lead 决定是否另立待办 |
| D-7 | 观察 | `GET /trade-docs/{id}/files` 等 ws_files 附属读端点仍按 `file_objects.team_id` 过滤（不存在的单证也 200 空列表），不泄露存在性；未纳入 F2 | 备查 |

### 10.2 复核结论

**条件通过：5/5 验收项达成（①②③④⑤ 均有代码+测试双证据）。**
- ① 5 个测试文件齐备且为**状态码参数化断言**（含阳性/阴性对照），非"只跑通过数"；② 404 先于 403 在 patch/confirm/pdf 三处均有 `*_before_403` 用例且代码顺序正确；③ 列表过滤在 SQL 谓词（`main.py:4272-4290`，测试断言 SQL 文本 + 行为双重验证）；④ 公章写侧断言未回退；⑤ 全量 `1523+12skip` 与 Lead 期望一致。
- 未覆盖项仅 D-1（前端页面级用例）与 D-2~D-5（矩阵逐格轻微缺口），不改变"4 类越权已修"结论。
- 建议 Lead：**接受本次验收**；D-1 视需要补一条前端测试；D-6（hardening 写端点角色口径）评估是否另立待办；D-7 备查。

## 11. 验收后的文档同步（由 Lead/align-b 决定，本清单不执行）

1. `docs/QA_TEST_ACCOUNTS.md` §4 的 7 条期望按新口径更新（审计文 §4 的 D-1～D-4：错误码、单租户、`seed_qa.py` 缺失、前端入口）；
2. 审计文 §1 总表补「修复状态 ✅（commit/日期）」列；
3. `docs/TODO.md` C27 销账（本清单不碰 TODO）。

_编制：DSH branch-audit（只读，未改代码、未提交）· v2 2026-10-21（并入 Lead 裁决 D1–D6 + R-1）_
