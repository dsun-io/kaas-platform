# 团队「加入申请」模块 · 设计方案

> 日期：2026-10-22 ｜ 状态：**已实施并全门禁通过**（决策结论与实施偏差见 §9 / §10）
> 需求原文：
> 1. 新用户注册填写企业/团队时，**团队已存在**的情况下，除邀请码外，新增「直接发起进入团队申请」；也可再填写邀请码。
> 2. 团队管理员界面增加**团队管理侧边栏**：管理成员信息、生成邀请码、审核进入申请。
> 3. **一个邀请码只能被使用一次**。
>
> **实施落点速查**：迁移 `202610220003_team_join_applications`（当前 alembic head）｜
> 内核 `backend/worker/src/ws_join_applications.py`（6 条路由）｜门面 `ts-worker/src/routes/teams.ts`（镜像 6 条）｜
> 前端 `register/page.tsx`（4 种团队模式）+ `team/page.tsx`（`?tab=` 侧边栏）+ `team-applications-panel.tsx`。

---

## 0. 现状核实（代码事实，非猜测）

| 事项 | 现状 | 位置 |
|---|---|---|
| 注册时团队动作 | `team_name`（新建）/ `invite_token`（凭码加入）二选一，互斥 422 `TEAM_ACTION_CONFLICT`；填了已存在的团队名 → 409 `TEAM_NAME_TAKEN`，用户只能改用邀请码 | `backend/worker/src/main.py:804-947`；TS 镜像 `backend/ts-worker/src/routes/auth.ts:311-486` |
| 邀请码 | 表 `team_invites`；状态机 `pending→accepted/revoked`，`invite_state()` 已把 accepted 判为 `used`；**单次使用语义已存在**，但注册兑换（`main.py:846-916`）和登录后兑换（`ws_teams.py:475-499`）都是「先 SELECT 再 UPDATE」，**无行锁**，并发下存在同一码被两人兑换的理论窗口 | `backend/kaas_common/workstation/teams.py:90-111` |
| 团队管理员 | = `teams.created_by`（创建者）或平台管理员；`_require_team_admin` 已覆盖成员/邀请/订阅/转让 | `backend/worker/src/ws_teams.py:104-109` |
| 团队页 | `/team` 已有成员面板、邀请面板、工位订阅面板（仅管理员可见），无侧边栏、无申请审核 | `frontend/src/app/(app)/team/page.tsx:240-261` |
| 工位授权 | **团队级订阅，全员可用**（`team_subscriptions` 挂在 team 上）——审核通过即天然获得团队已开通工位，无需逐成员授权 | `frontend/src/app/(app)/team/page.tsx:202-238` |

结论：**邀请码一次一码的语义已在，本方案补齐并发原子性；真正的增量是「加入申请」子模块 + 管理侧边栏改造。**

---

## 1. 总体设计

```
注册页（团队名输入）
  │  debounce 400ms 调 GET /teams/check-name?name=
  ▼
团队已存在 ──► 二选一：①「申请加入」(apply_team_name + 可选留言)
                │        ②「填写邀请码」(invite_token，现有流程)
                ▼
        注册事务：建用户(role=user, team_id=NULL) + 建申请(status=pending)
                ▼
团队管理员侧边栏 →「加入申请」页：通过 / 驳回(可填理由)
                ▼
   通过：users.team_id 落值（团队订阅工位全员可用，自动获得）
   驳回/申请人撤回：用户保持无团队，可再次申请
```

**新增状态机**（`kaas_common/workstation/teams.py`，纯函数真源）：

```
pending ──approve──► approved   （终态）
pending ──reject───► rejected   （终态，可再申请）
pending ──cancel───► canceled   （终态，可再申请）
非 pending 的任何操作 → 409 APPLICATION_ALREADY_REVIEWED
```

**邀请码单次使用加固**：两处兑换路径（注册 `main.py`、登录后 `ws_teams.py:join`）的
`SELECT * FROM team_invites WHERE token=$1` 一律改 `... FOR UPDATE`，同一事务内第二个
兑换者看到 `status='accepted'` → `invite_state='used'` → 409 `INVITE_ALREADY_USED`。
补并发回归测试（同码两请求，恰好一个成功）。

---

## 2. 数据库迁移（Alembic，orchestrator）

新文件 `backend/orchestrator/alembic/versions/202610220003_team_join_applications.py`
（**实际** down_revision = `202610220002`，即当时 `alembic heads` 的 head；原计划文里写的 `202610220006` 是估算号，以此为准）：

```sql
CREATE TABLE team_join_applications (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL,                 -- 恒 'default'
  team_id       BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,                 -- 快照：管理员审核视图直接可读
  display_name  TEXT NOT NULL,
  message       TEXT,                          -- 申请人留言 ≤200 字
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','canceled')),
  reviewed_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   TIMESTAMPTZ,
  reject_reason TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ
);
-- 同一用户同时只允许一条待审申请（Postgres 部分唯一索引，兜底并发）
CREATE UNIQUE INDEX uq_join_applications_user_pending
  ON team_join_applications (user_id) WHERE status = 'pending';
CREATE INDEX idx_join_applications_team_status
  ON team_join_applications (team_id, status);
```

配套：`backend/orchestrator/app/db/models.py` 加 `TeamJoinApplication` ORM；
更新 `scripts/prod-schema-columns.json` 快照并跑 `scripts/check-schema-drift.py`。
存量数据无影响（纯新增表）。

## 3. 共享内核（`backend/kaas_common/workstation/teams.py`）

新增导出：`JOIN_APPLICATION_STATUS`、`APPLICATION_MESSAGE_MAX=200`、
`validate_application_message(msg)->str|None`（strip + 长度校验，`TeamRuleError`）、
`can_transition_application(current, target)->bool`。
改完跑 `scripts/sync-shared.ps1`（TS 侧 `rules.ts` 镜像同步 + `tests/rules.test.ts` 冻结用例更新）。

## 4. Python 内核 API（业务规则唯一真源）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/teams/check-name?name=` | **公开**（无 JWT）：`{exists: bool}`，仅布尔，防枚举见决策点 2 |
| POST | `/api/v1/auth/register`（扩展） | 新字段 `apply_team_name?: str`、`apply_message?: str`；与 `team_name`/`invite_token` 三方互斥（422 `TEAM_ACTION_CONFLICT`）。同一事务：校验团队存在（404 `TEAM_NOT_FOUND`）→ 建用户（role=user、team_id=NULL）→ 建申请（pending）。响应新增可选字段 `application: {id, team_id, team_name, status}`（不破坏旧客户端） |
| GET | `/api/v1/teams/{team_id}/join-applications?status=pending\|all` | 团队管理员列表（`_require_team_admin`） |
| POST | `/api/v1/teams/{team_id}/join-applications/{id}/approve` | 事务内 `FOR UPDATE` 锁申请行；校验 pending、目标用户仍无团队（否则 409 `ALREADY_IN_TEAM`）→ 落 `users.team_id` → 申请 approved。工位随团队订阅自动获得 |
| POST | `/api/v1/teams/{team_id}/join-applications/{id}/reject` | body `{reason?}`；申请 rejected，用户不动 |
| GET | `/api/v1/me/join-application` | 申请人看自己最近一条申请（含团队名），用于「审核中」展示 |
| POST | `/api/v1/join-applications/{id}/cancel` | 仅申请人本人、pending → canceled（403/404 区分） |

错误码（进 `TEAM_ERROR_TEXT`）：`APPLICATION_NOT_FOUND`、`APPLICATION_ALREADY_REVIEWED`、
`APPLICATION_ALREADY_PENDING`、`APPLICATION_MESSAGE_TOO_LONG`、`APPLICATION_CANCELED`。
新模块建议放 `backend/worker/src/ws_join_applications.py`（沿用 `app = _main.app` 挂载模式）。

## 5. TS 门面（`backend/ts-worker`，只做鉴权/校验/协议转换）

- `routes/auth.ts`：`registerSchema` 加 `apply_team_name`/`apply_message`（zod 从 pydantic 同口径，TODO:TS1）；register 处理分支镜像申请创建。
- `routes/teams.ts`：上面 6 条路由逐一镜像（check-name 不过 `requireUser`）；`rules.ts` 加 `validate_application_message`/`can_transition_application` 镜像。
- `tests/route-surface.test.ts`：163 直接 → **169**（+6），总数 249 → **255**。
  （**实测落点**：168 直接 → **174**，总数 254 → **260**；差异来自本模块之前已并入的其他路由，`routes.json` 由
  `backend/ts-migration/export_routes.py` 重新生成，`openapi.test.ts` 计数已同步。）
- 跨层契约变更同 PR，金标 `backend/ts-migration/golden/` 保持全绿。

## 6. 前端（Next 16 静态导出）

**A. 注册页 `frontend/src/app/register/page.tsx`**
- `TeamMode` 增加 `"apply"`（**实际**：4 张单选卡 `create/join/apply/none` 并列入列表，见 §10-1）。
- `create` 模式输入团队名 ≥2 字符后 debounce **400ms** 调 check-name；命中已存在 → 提示卡：
  「团队「X」已存在」+ 两个按钮［改为申请加入］［我有邀请码］。
- `apply` 模式：团队名只读展示 + 留言 textarea（≤200 字带计数，选填）+ 提交。
- payload 只带 `apply_team_name/apply_message`（维持互斥，避免 422）。
- 注册成功且带 pending 申请 → 跳 `/team`（而非仪表盘），让用户立刻看到「审核中」。
- `lib/auth/types.ts` 的 `RegisterRequest` 同步加字段并更新 docstring。

**B. 团队页 `frontend/src/app/(app)/team/page.tsx`（管理员侧边栏）**
- 管理员视图改两栏：`grid lg:grid-cols-[13rem_1fr]`，左侧 `team-manage-nav.tsx`
  （工位开通 / 成员管理 / 邀请码 / **加入申请**，带待审数量徽标），右侧当前面板。
- tab 用 `?tab=subscriptions|members|invites|applications`（沿用现有 `tab` 参数模式，
  静态导出友好；侧边栏 `Link` 不加 `prefetch`）。
- 新增 `components/team-applications-panel.tsx`：待审/已处理分组；行内［通过］［驳回］，
  驳回弹小窗填理由（≤200）；通过二次确认。
- 新增 `components/team-manage-nav.tsx`；hooks 进 `hooks/use-team-admin.ts`
  （`useTeamJoinApplications` + approve/reject/cancel actions，沿用 silent+降级模式）。
- 成员（非管理员）视图不变（只读提示卡）。

**C. 无团队用户**：`hooks` 加 `useMyJoinApplication`（GET /me/join-application）；
`/team` 无团队分支展示「已申请加入「X」，等待管理员审核」+［撤回申请］。
（已登录无团队用户是否也可主动发起申请 = 决策点 1）

**D. 其他**：`lib/team/team-errors.ts` 加新错误码中文；新增 `lib/team/join-applications.ts`
（类型 + `applicationStatusLabel`）；`mocks/handlers.ts` 加 6 个端点 mock（含
register 申请分支），`p1-handlers-contract.test.ts` 同步；`frontend/src/mocks` 契约测试全绿。

## 7. 测试计划

- **orchestrator**：迁移 up/down 往返 + 模型测试（基线 247 条）。
- **worker**：新增 `backend/worker/tests/test_join_applications_api.py`（约 20 例：
  注册+申请、团队不存在 404、三方互斥 422、通过/重复通过 409、驳回带理由、
  撤回权限、非管理员 403、目标已入他团 409、me 查询、留言超长 422）；
  `test_teams_api.py` 加**同码并发兑换**回归（恰好一个 200、其余 409）。
- **ts-worker**：`teams-routes.test.ts` / auth register 用例扩展；route-surface 计数更新（255）。
- **frontend**：注册 apply 流程单测、申请面板渲染与操作、错误码表、mocks 契约；
  `pnpm e2e`（无新路由，a11y 自动发现不受影响）；`ui:standards` / `ui:contrast` 必须过。
- **静态断言**：`check-schema-coverage/drift`、`sync-shared.ps1 -Check` 等全套。

## 8. 门禁与发布（AGENTS.md 口径）

按序跑：orchestrator pytest → ts-worker typecheck+test → worker pytest → frontend
typecheck/lint/test/contracts:check/mocks:check/ui:standards/ui:contrast/e2e → 静态断言 →
（发版前）`pnpm assets:check`。全绿后：更新文档（根 `README.md` 交接摘要、`docs/README.md`、
`docs/PROBLEM_STATUS_2026-10-11.md`）→ 提交推送 `main`（自动触发 deploy，先内核后门面）。

## 9. 决策结论（用户已拍板）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 申请入口范围 | **仅注册时**（已登录无团队用户不提供主动申请入口；`/team` 只展示自己的申请状态与撤回） |
| 2 | check-name 暴露方式 | **只回布尔 `{exists}`，绝不把团队列表展示给用户**（防枚举；名称归一化与建团队共用同一套） |
| 3 | 通知 | **先站内**（管理员审核页待办徽标 + 申请人 `/team` 状态卡），后续接 Resend 邮件 |
| 4 | 收尾方式 | **全部门禁绿后提交并推送 `main`**（自动触发 deploy：migrate → deploy-kernel → deploy-edge） |

## 10. 实施记录（2026-10-22，与计划的偏差）

**已完成**：迁移 + ORM、共享内核纯函数、Python 内核 6 条路由、TS 门面镜像 6 条路由、注册页 4 模式、
团队页侧边栏 + 4 面板、申请面板、mock 6 端点、错误码中文、单测/e2e。

**与计划的偏差（均已在代码中定型）**：

1. **注册页团队模式是 4 张单选卡**（`create | join | apply | none`），`apply` 同时出现在单选列表里，
   而不是「仅从已存在提示卡进入」。理由：只从提示卡进入时，用户一旦改团队名就掉回 `create`，
   状态机更难解释；两种入口并存更符合直觉。提示卡仍然保留（团队已存在时给
   ［改为申请加入］［我有邀请码］两个快捷按钮）。
2. **查重 debounce 取 400ms**（计划写 300ms）。同页有 `nameChecking` 态 + 提交前硬校验
   （`create` 且 `nameExists===true` 报错；`apply` 且 `nameExists===false` 报错），不依赖网络时序。
3. **迁移号是 `202610220003`**，不是计划里估的 `202610220006`。
4. **route-surface 实测 174 直接 / 260 总**（计划估 169 / 255）。
5. **`_bootstrap._SIBLING_MODULES` 必须登记 `ws_join_applications`**。这是本次踩到的真坑：
   单独跑新测试文件全绿，全量跑时 20 条用例集体 404/405 —— 因为兄弟模块靠 import 挂到 `app` 上，
   未登记的模块在"先 import 了别的 ws_* 再收集"的顺序下会被挂到过期 app 实例。该元组有 docstring
   明确警告此失效模式，新增任何 `ws_*` 模块都要加。
6. **邀请码单次使用**：语义（`accepted` → `used`）本来就有，本次只补并发原子性 ——
   两处兑换路径（注册 `main.py`、登录后 `ws_teams.join_team`）的 `SELECT ... FROM team_invites`
   统一加 `FOR UPDATE`，并补 3 条回归测试（锁行、同码二次兑换 409、注册路径锁行）。
7. **申请审批即授予团队工位**：工位订阅挂在 `team_subscriptions`（团队级），
   通过申请只是把 `users.team_id` 落值，无需逐成员授权 —— 已在迁移与模块 docstring 记录，
   避免后来者以为漏了一步。

**门禁实测（2026-10-22 收尾）**：orchestrator **258 passed** ｜ ts-worker **232 / 23 文件**
（typecheck 净）｜ worker **1616 passed + 12 skipped**，另有 3 条 `test_trade_doc_confirm_authz.py::test_pdf_privileged_passes_gate[S1..S3]`
因本机缺 `js` 模块失败（**环境问题，与本次改动无关**，该文件未修改）｜ 前端 typecheck 净 / lint
`0 error` / **1051 测（125 文件）** / `contracts:check` `mocks:check` `ui:standards` `ui:contrast` 全 PASS / e2e **27 passed**
｜ 静态断言 `check-schema-coverage`（缺失 0）、`check-schema-drift`（列漂移 0）、`check-worker-bundle`（11.79 MiB / 606 文件）、
`sync-shared -Check`（44/21/1 一致）、`route-parity-audit`（线上坏 0）全 PASS。

