# 前端生产可用性改造清单

> 2026-10-11。目标：**用户在生产能正常使用**（不是"接口通了"就行）。
> 背景：本轮后端做了三层组织（团队/用户/业务客户）、工位订阅授权、单据关联业务客户。
> 前端的对应改造必须同步，否则用户会遇到"点了 404""注册后什么都没有""看不到自己的数据"。

## 0. 优先级总览

| 优先级 | 块 | 不做会怎样 |
|---|---|---|
| **P0** | A. 工位订阅可见性 | 用户点未开通的工位 → **404 报错**，以为是系统坏了 |
| **P0** | C. 认证信息契约 | 顶栏团队名空白、权限判断失效 |
| **P1** | B. 团队生命周期（注册选团队/工位、团队管理页） | 注册后没有团队 → **看不到任何数据**，且无法自救 |
| **P1** | E. 报价选客户 + 往来记录树 + 导入 | 无法建立客户与单据的关联，客户页查不到历史 |
| **P2** | D. 单证类型补齐 `quotation` | 报价单无法归类展示 |

---

## A. 工位订阅可见性（P0）

**接口**：`GET /api/v1/me/workstations` →
`{"workstations":["customers","quotes"], "codes":["full_chain"], "is_admin":false, "has_team":true}`

**改造**：

1. 登录后拉一次「我的工位」，**按已开通工位过滤侧边栏**。
   映射真源：`shared/contracts/workstations.ts`（`workstation.key` ↔ `route`）
2. **全局识别未开通错误**：工位 API 未开通时返回
   ```
   HTTP 404  {"error":"not_found","code":"WORKSTATION_NOT_SUBSCRIBED","workstation":"customers"}
   ```
   → 前端拦截该 `code`，渲染「该工位未开通」引导页（跳到团队管理页的工位开通区），**不要**弹通用错误
3. 平台管理员（`is_admin=true`）不受限，不显示任何未开通提示
4. `has_team=false` 时，工位入口引导先"创建/加入团队"（没有团队就没有订阅主体）

**验收**：把团队订阅改成只开 `customers` → 报价入口消失；直接输入报价路由 → 显示开通引导而不是报错。

---

## B. 团队生命周期（P1）

### B1. 注册页（首次使用就要用）
- 团队二选一（互斥，对应 `POST /api/v1/auth/register` 的可选参数）：
  - **新建团队**：填团队名 + **勾选要开通的工位**（当前全部免费，多选）→ `team_name` + `workstations: string[]`
  - **加入团队**：填邀请码 → `invite_token`（**要接受整条邀请链接**，后端会自己取 `?token=`）
  - 都不填：允许，但进去后引导"创建/加入团队"
- 注册成功响应已变：`{user_id, email, display_name, account_type, role, team_id, team_name, console_access, access_token}`

### B2. 团队引导与团队页
- `GET /api/v1/teams/me` → `{"team": null | {id,name,created_by,is_admin,member_count}, "is_admin":bool, "member_count":n}`
  - `team=null` → 显示「创建团队 / 加入团队」引导
- 团队管理页（`is_admin=true` 可见）：
  | 功能 | 接口 |
  |---|---|
  | 成员列表（含 `is_admin`、`console_access`） | `GET /teams/{id}/members` |
  | 邀请 | `POST /teams/{id}/invites` body `{"email"}` |
  | 邀请列表 / 撤销 | `GET /teams/{id}/invites`、`DELETE …/{invite_id}` |
  | 移除成员 | `DELETE /teams/{id}/members/{user_id}` |
  | **官网数据后台开关** | `PUT /teams/{id}/members/{user_id}/console-access` body `{"allowed":bool}` |
  | 工位开通/撤销 | `GET/PUT/DELETE /teams/{id}/subscriptions[/{code}]` |

- **邀请的两个分支要分清**（容易做错）：
  - 邮箱**已注册** → `200 {"joined":true,"user_id":..}` → 提示"已直接加入"
  - 邮箱**未注册** / 通用码 → **`201 {"joined":false,"invite_id":..,"token":".."}`** → 展示**可复制的邀请链接**
- 错误码要给人话：
  | code | 文案 |
  |---|---|
  | `ALREADY_IN_TEAM` | 你已属于一个团队 |
  | `TEAM_NAME_TAKEN` | 已有同名团队 |
  | `NOT_TEAM_ADMIN` | 只有团队管理员可以操作 |
  | `CANNOT_REMOVE_SELF` | 不能移除团队管理员本人 |
  | `INVITE_NOT_FOUND/REVOKED/EXPIRED/ALREADY_USED` | 邀请无效 / 已撤销 / 已过期 / 已被使用 |
  | `MEMBER_NOT_FOUND` | 该成员不在本团队 |
  | `WORKSTATION_NOT_SUBSCRIBED` | 该工位未开通 |

---

## C. 认证信息契约（P0）

后端已改（本轮）：登录 / 注册 / `/me` 返回
`{user_id, email, display_name, account_type, role, plan, team_id, team_name, console_access, access_token?}`

- **`customer_id` / `customer_code` / `customer_name` 已不存在**
- 已同步：`lib/auth/types.ts`、`lib/auth/auth-context.tsx`、`lib/auth/session-cache.ts`
- 还需检查：
  1. 顶栏/侧边栏**显示团队名**（`team_name`），未加入团队时显示引导入口
  2. 全局搜索 `customer_code` / `.customer_id` 中**属于登录态**的用法（业务单据里的 `customer_id` 是正确的，别误改）
  3. `session-cache.ts` 不再往 `X-Tenant-Id` 写值（账号已无租户）

---

## D. 单证类型补齐（P2）

- `doc_type` 新增 **`quotation`（报价单）**，与 `pi` / `ci` / `pl` / `bl` 并列
- 类型筛选、标签、图标统一支持；**所有单证在同一处展示**（报价单不与 CI 分家）

---

## E. 客户与单据（P1，与 `docs/CUSTOMER_DOCUMENTS_VIEW.md` 配套）

1. **报价新建必选业务客户**（可搜索选择器，抽成公用组件）
2. **订单/单证新建必选客户**；报价/订单父对象**可选**（互斥）—— 支持手动新建
3. **导入已有数据**入口（选客户 + CSV），接口未上线时降级提示
4. **客户详情「往来记录」树**：报价 → 报价单 chip + 订单 → 单证 chips；
   「直接挂客户」分组固定渲染（手动新建/导入的正规数据，不是脏数据）

---

## 全局优化（生产体验）

| 项 | 说明 |
|---|---|
| 401 统一处理 | token 失效 → 清 session + 跳登录（不能停在白屏） |
| 网络/500 降级 | 每个页面有骨架/空态/错误态（**接口没上线也不能白屏**） |
| 未开通工位 | 见 A，统一引导页，不弹通用错误 |
| 权限差异 | 平台管理员 / 团队管理员 / 普通成员 三种视角，按钮该藏的藏（团队管理、工位开通、console-access 开关） |
| 加载态 | 团队与工位信息要在首屏加载完成前给骨架，避免入口闪现后消失 |

---

## 实施顺序与门槛

1. **A + C**（P0，先保证"不报错、信息正确"）
2. **B**（P1，保证注册后能自救：有团队、有工位）
3. **E**（P1，客户与单据关联 + 往来记录）
4. **D**（P2，类型补齐）
5. 全局优化收尾

**硬门槛**：`npx tsc --noEmit -p tsconfig.json` **exit 0**；所有新接口调用 try/catch + 降级；
不引入新依赖；**同一时刻只有一个人在写 `frontend/**`**。

## 认证契约残留清单（只读扫描结果，2026-10-11）

扫描 `frontend/src/lib`，**不影响功能**（`tsc` exit 0，值均为空/可选），但要清：

| 位置 | 残留 | 处理 |
|---|---|---|
| `lib/auth/session-cache.ts:10,21,34,41-42,75` | 仍有 `tenant` 结构与 `user?.tenant_id` 读取 | 账号已无租户 → 删掉该结构（或保留空壳但不再读取） |
| `lib/api/client.ts:31-32` | 仍会注入 `X-Tenant-Id`（值恒为空，实际不发） | 死代码，删除 |
| `lib/schemas/responses.ts:10`、`lib/events/*` | 事件/响应 schema 里残留可选 `tenant_id` | 后端事件里还在传就保留；否则清 |
| `lib/workstation/use-upstream.ts:21,38` | `customer_name` | 属上游数据，**确认后保留** |

**明确不要动的**（这些 `customer_id` 是**业务客户**，正确）：
`lib/schemas/responses.ts:37-38,56`、`lib/form/__tests__/*`、`lib/schemas/__tests__/*`、
以及各业务页面（报价/订单/单证里"这笔业务属于哪个客户"）。

## 当前执行状态

| 块 | 状态 |
|---|---|
| C（认证契约） | ✅ 已改（`types.ts` / `auth-context.tsx` / `session-cache.ts`）；残留清理清单见本文档上一节 |
| 契约补充 | ✅ `shared/contracts/quote-order.ts` 的 `QuoteOrderPatch` 补 `customer_id`（"建单后改客户"原先做不到） |
| E（选择器 / 往来记录树 / 导入骨架 / 单证 chip） | ✅ 已交付 —— `tsc` exit 0、`next lint` 0 error、vitest 228 passed（1 个失败为**既有** `niulanwang` 用例） |
| A（工位可见性，P0）· B（团队生命周期）· D（`quotation` 类型） | 🔄 执行中（`frontend/**` 单写者） |
| 全局优化（401 跳登录 / 每页降级 / 权限差异 / 首屏骨架） | ⏳ 随 A、B 一并落地 |

**依赖提醒**：A、B 依赖后端已就绪的接口（`/me/workstations`、`/teams/**`、订阅接口）——这些**两端都已实现**；
E 依赖的 `GET /customers/{id}/records` **生产端已就绪**，dev 端待收口（见 `docs/PLAN_CUSTOMER_RECORDS.md`）。
