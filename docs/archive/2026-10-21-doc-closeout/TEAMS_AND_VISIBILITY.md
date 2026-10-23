# 三层组织与数据可见性（管理员 / 团队 / 成员）

> ⚠️ **已归档（2026-10-21）· 历史留档，不代表当前口径。** 归档理由与替代指针见 [`README.md`](./README.md)（本批归档说明）；
> 规则真源是代码 `backend/kaas_common/workstation/scope.py`（可见性）/ `teams.py`（团队规则）。当前交接入口：[`../../README.md`](../../README.md)。

> 2026-10-11 落地。业务规则由产品确认，**判定只有一份实现**：
> `backend/kaas_common/workstation/scope.py`（可见性）与 `.../teams.py`（团队规则），
> orchestrator 与 Worker 共用。

## 1. 业务规则

租户内分三层：**管理员 / 团队 / 成员**。

| 规则 | 说明 |
|---|---|
| 团队由**第一个成员创建** | 创建者即**团队管理员**，可管理本团队（改名、邀请、移除成员） |
| 成员创建的数据**本团队可见** | 成员录入的客户/询盘/报价/订单/单证，**其他团队不可见** |
| 一个用户同一时刻只属于一个团队 | 已有团队就不能再建或再加（先退出/被移除） |
| **加入现有团队必须凭邀请码** | 否则 A 公司的人可以自由进入 B 公司团队、看到 B 的数据 |
| 邀请两条路 | **邮箱点名**（已注册→直接入队；未注册→发码）＋**通用邀请码**（谁拿到谁用） |
| 平台管理员（system_admin） | 全租户可见、可管任何团队（运维兜底） |

> 「客户」指的是**业务记录**（例如"给 Tim 录了一条报价单，Tim 就是我的客户"），
> 不是账号行。规则作用在记录上：记录带 `team_id`，可见性按团队判定。

## 2. 可见性判定（任一成立即可见）

```
1. 管理员（role 映射后 = system_admin，含历史 admin）   → 全可见
2. owner_scope = 'tenant'                              → 显式声明为全租户共享
3. owner_id = 我                                       → 我自己的数据
4. 行的 team_id 非空 且 = 我的 team_id                  → 本团队（本次新增）
```

**零回归约定**：`team_id IS NULL` 的行**不因规则 4 改变可见性** —— 仍按 1~3 判定，
也就是上线前的行为。所以本次上线不会让任何人突然看到/看不到数据；只有**显式带上团队**
的记录才真正按团队隔离。历史数据因此不需要回填。

**读与写是两条规则**：同团队可见 ≠ 同团队可改。写权限仍是"管理员全可改 / 成员只改自己
名下的"（`scope.can_write`），否则"谁改的"就说不清了。

## 3. 数据模型

| 表/列 | 说明 |
|---|---|
| `teams(id, tenant_id, name, created_by, …)` | 团队；`created_by` = **团队管理员**（创建者）；`UNIQUE(tenant_id, name)` |
| `team_invites(id, team_id, email, token, invited_by, status, expires_at, accepted_at, accepted_by, …)` | 邀请；`token` 全局唯一；`status ∈ pending/accepted/revoked` |
| `users.team_id` | 成员所属团队（NULL = 未分组） |
| 8 张业务表的 `team_id` | `customers`/`cust_inquiries`/`orders`/`quote_orders`/`trade_docs`/`shipments`/`payment_schedules`/`receivables` |

**为什么行上直接记 `team_id`**（而不是靠 `owner_id` 反查属主的团队）：

- 判定无需 JOIN，两端 SQL 都简单一档；
- 成员换团队/离职后，数据仍留在原团队，不跟着人走；
- 历史数据可以**显式指定**归属团队，不需要编造一个"属主"。

迁移：`202610110001`（teams + 各表 team_id）、`202610110002`（建某团队）、
`202610110003`（团队管理员 + 邀请表）。

## 4. API（两端一致）

前缀 `/api/v1`，除注册外都需要登录。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/teams` | 建团队（创建者成为团队管理员并自动入队）；已有团队 → 409 `ALREADY_IN_TEAM` |
| GET | `/teams/me` | 我的团队（未加入时 `team=null`），前端据此显示引导 |
| PATCH | `/teams/{id}` | 改名（团队管理员 / 平台管理员） |
| GET | `/teams/{id}/members` | 成员列表（含 `is_admin` 标记） |
| DELETE | `/teams/{id}/members/{user_id}` | 移除成员；**不能移除管理员自己** → 409 `CANNOT_REMOVE_SELF` |
| POST | `/teams/{id}/invites` | 邀请：`email` 为空 → 通用码；已注册 → 直接入队；未注册 → 发码 |
| GET | `/teams/{id}/invites` | 邀请列表（含 token，方便再复制链接） |
| DELETE | `/teams/{id}/invites/{invite_id}` | 撤销邀请 |
| POST | `/teams/join` | 凭邀请码加入；无效/撤销/已用/过期 → 404/410/409/410 |
| POST | `/auth/register` | 注册，新增可选 `invite_token`（加入）或 `team_name`（新建，成为管理员） |

加入的四态由共享内核 `invite_state()` 判定，两端同一份；邀请码用
`generate_invite_token()` 生成（24 位、去掉 `0O1lI` 等易混字符——邀请码要靠人转述），
`normalize_invite_token()` 兼容用户整条链接粘进来。

## 5. 为什么生产端尤其需要它

生产 Worker 是**单租户**部署：所有数据 `tenant_id='default'`，账号之间**没有
`tenant_id` 隔离**。团队就是提供"公司级隔离"的那一层 —— 这也是本次把团队做出来的直接原因。

> 顺带说明：orchestrator 的注册流程会给每个新账号新建一个 UUID `tenant_id`，
> 而 Worker 的查询一律按 `DEFAULT_TENANT` —— 那套 tenant 隔离在 Worker 口径下不可见，
> 所以生产端注册**不复制**它，账号隔离改由团队承担。

## 6. 客户域也执行同一套过滤（2026-10-11 补齐）

原先只有订单/报价/单证/询盘执行可见性，**客户域不执行**，于是同一个客户会出现
「列表里看得见、点进去 404」——因为：

| 接口 | 原先 | 现在 |
|---|---|---|
| `GET /customers`（列表） | ❌ 完全不判 | ✅ §10.3 + 团队 + 排除已删除 |
| `GET /customers/{id}`（详情/联系人/询盘/阶段日志） | ❌ 完全不判 | ✅ 不可见 → 404 `CUSTOMER_NOT_FOUND` |
| `PATCH /customers/{id}/stage`、`+/contacts`、`+/inquiries` | ❌ 只判"存不存在" | ✅ 同上（不可见即 404，跨团队不能写） |
| `PATCH /customers/{id}`、`GET /customers/{id}/inquiries` | ✅（新补时已按 §10.3） | ✅ |

**顺带修掉一个真缺陷**：`is_deleted`（客户软删除，2026-10-10 发布的功能）**两端都只写不读**
—— 软删除标记了，但列表/详情/子资源照样能查到，等于删除功能完全没生效。
本次在两端补上 `is_deleted = false` 过滤（orchestrator 的 `list_customers` /
`_get_customer_or_404`；Worker 的列表 + 新增 `_customer_or_404` 助手）。

配套数据（迁移 `202610110004`）：`某丝网` 归入某团队；`客户B`、`[BUYER COMPANY NAME]`
软删除（用软删除而非物理删除：单证的 `customer_id` 是 TEXT 引用，物理删除会让历史
报价/单证指向不存在的客户）。

## 7. 一个需要产品决策的发现：数据里其实是多租户

迁移时发现这三行的 `tenant_id` **各不相同**：

| 客户 | tenant_id | 说明 |
|---|---|---|
| `某丝网`（code=lianjia） | `lianjia` | 某的租户 |
| `客户B`（code=client_b） | `client_b` | 客户B 的租户 |
| `[BUYER COMPANY NAME]` | `default` | 平台默认租户 |

`tenant_subscriptions` 里也确实有 `default` 与 `lianjia` 两个租户。

但**生产 Worker 是单租户实现**：所有查询硬编码 `tenant_id = 'default'`，
`_get_current_user` 也不解析租户。后果：

- 生产环境里 `某丝网`（tenant=`lianjia`）**对任何人都不可见**（包括某自己）；
- 反过来，某在生产新建的数据落在 `default` → 其他公司也能看到（这正是团队要解决的隔离问题）；
- 开发环境因为按租户过滤，看不到这个矛盾（开发里 u3 的租户来自其绑定的
  `客户.tenant_id = 'lianjia'`，所以 dev 里 u3 恰好能看到自己的那一行）。

**需要你定**：`某丝网` 这一行要不要把 `tenant_id` 改成 `default`（即统一到"单租户 + 团队隔离"
的模型）？改的话它在生产也可见；不改则它在生产不可见（开发可见），且两套隔离模型并存。
本次**没有**擅自改——这属于租户模型层面的决定。

## 10. 工位订阅（能力边界：用户只能使用开通了的工位）

授权模型（业务确认）：**业务逻辑不以租户做鉴权边界**。两层边界各司其职：

| 边界 | 负责 | 实现 |
|---|---|---|
| **数据可见性** | 谁能看到哪条数据 | 团队（`scope.py`） |
| **能力边界** | 谁能用哪个工位 | **工位订阅**（`subscriptions.py`） |

- **团队为主**：团队开通 = 全员可用（`team_subscriptions`）
- **个人可额外开通**（`user_subscriptions`）
- 平台管理员不受限
- 未开通的工位 API → **404**（不暴露工位存在性）；前端用 `GET /me/workstations` 隐藏入口/显示开通引导
- 付费暂时**手动开通**（`source='manual'`），支付渠道以后接

**工位清单**与 `shared/contracts/workstations.ts`（前端侧边栏真源）对齐：
`customers / quotes / orders / trade-docs / shipments / leadgen / outreach / intel / research`；
`full_chain` 是全工位套餐。路径→工位映射也在这份内核里（`WORKSTATION_PATHS`）。

**接口**（两端一致）：`GET /me/workstations`、`GET|PUT|DELETE /teams/{id}/subscriptions[/{code}]`、
`GET|PUT|DELETE /users/{id}/subscriptions[/{code}]`（个人级仅平台管理员）。

**拦截**：两端各一个中间件 —— 路径→工位→查生效编码（进程内缓存 30 秒，开通/撤销时主动失效）；
`ALWAYS_ALLOWED_PREFIXES`（账号/团队/订阅/管理/字典/健康检查）永远放行，否则用户没法"去开通"；
**没有 token 或任何异常一律放行**（认证是路由依赖的职责；订阅校验出问题不该让服务不可用）。

**存量访问**：迁移给已有团队补了 `full_chain`，上线不会把人锁在门外；
**新建团队不给**（要走开通流程）。

⚠️ **待你定**：新注册/新建的团队要不要给一点"试用工位"？现在是没有的——
新用户建完团队后所有工位都是未开通状态，必须由管理员手动开通。

## 11. 落地状态

**已完成**

- 判定收敛共享内核：`scope.py`（管理员/团队/成员）、`teams.py`（名称/邀请码/权限）
- 两端读过滤：orchestrator `ws_common.scope_filter`/`visible_to`；Worker `_can_see_all`/
  `_owner_visible`/`_check_write_access` + 4 处内联 SQL 片段
- 两端写入归属：orchestrator 9 处创建点、Worker 8 处 INSERT 均写入创建者的 `team_id`
- **客户域补齐过滤**（§6）+ 修掉 `is_deleted` 只写不读的缺陷
- 团队 API：Worker `ws_teams.py`（生产）+ orchestrator `app/api/teams.py`（9 条，两端契约一致）
- 生产端 `/auth/register`（**此前缺失，注册在线上直接 404**）＋ 团队选择
- 测试：Worker **108 passed**、orchestrator **429 passed**（含 21 条共享内核规则单测）

**未完成**

- **前端界面**：注册页的"加入/新建团队"选择、团队管理页（成员列表/邀请/移除）
- `POST /auth/logout`（前端会调，线上仍 404；无状态 JWT 下可做成空操作）
- 团队管理员转让（当前创建者固定；换人需平台管理员介入或后续加"转让"接口）
- **工位开通的前端界面**（我的工位/开通引导页）与**在线支付**（现为手动开通）
- §7 的租户模型决定

## 12. 验证

- **共享内核规则单测**：`backend/orchestrator/tests/test_team_scope_rules.py`（15 例，CI unit 组）
- **生产端行为测试**：`backend/worker/tests/test_teams_api.py`（22 例）+ 客户域过滤
  （`test_four_domains.py` 新增 8 例），全部无 DB 假连接
- **SQL 真实库 PREPARE**：团队/注册 22 条 + 客户域过滤 5 条，全部通过（只编译不执行）
- **端到端（事务内，验证完回滚）**：

```
u3 某账号（团队=某某网业有限公司）→ 可见 1 条   ✅ 本团队可见
u4 客户B账号（无团队）                        → 可见 0 条   ✅ 其他团队不可见
u1 平台管理员                                 → 管理员分支直接放行
回滚后 quote_orders 仍为 3 行（无残留）
```
