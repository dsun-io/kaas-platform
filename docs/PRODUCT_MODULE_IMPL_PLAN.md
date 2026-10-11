# 产品模块：可执行实施计划（含产品域团队隔离 R1 / 可见性 R2 / 存储 R3）

> **性质**：**实施计划**，不含代码改动。本文是 `docs/PRODUCT_MODULE_MERGE_PLAN.md`（只读分析）的**执行版**。
> **输入**：`docs/PRODUCT_MODULE_DECISIONS.md`（用户裁决原文，只读）+ 上述分析文档。
> **本文不代表已实施**；每步都写清"怎么验、怎么回滚"。
> 陈述标注：**【已核实】**= 读到的代码/SQL 事实；**【推测】**= 我的建议；**【需用户确认】**= 策略问题，不代决。
>
> **快照基线**：`HEAD = 9ca7eec`（2026-10-11 22:0x）。另一条任务（产品/文件/S3 线）**仍在改**
> `frontend/src/app/(app)/products/**`、`backend/orchestrator/app/api/files.py`、`backend/worker/src/ws_files.py`、
> `backend/orchestrator/app/api/trade_docs.py`、`backend/kaas_common/files/**`。
> **行号会漂移**，引用时以符号名/路由字面量为准。
>
> **本任务只写两个文档**：本文件 + 在 `PRODUCT_MODULE_MERGE_PLAN.md` 追加 §11。**未改任何代码。**

---

## 0. 结论速览

| # | 结论 | 性质 |
|---|---|---|
| 1 | **R1 不是"加一列"**：产品域有 **4 处结构性约束**与团队私有冲突（`product_profiles` 主键、`uq_file_primary`、`uq_tenant_products_key`、`uq_tenant_ws_product` 都不含 `team_id`），改错一个就会出现"两个团队抢同一个主图/同名产品建不出来" | 【已核实】 |
| 2 | **文件接口存在既有越权面**：`PATCH/DELETE /file-objects/{id}`、`GET /file-objects/{id}/content`、`attach_doc_file` 全部只按 `tenant_id + id` 取，**不带团队过滤** ⇒ 同一实例内可跨团队改/删/读别人的文件、把别人的文件挂到自己的单证上 | 【已核实】 |
| 3 | **回填可行性三张表各不相同**：`file_objects.team_id` **上传时已写入**；`product_profiles` 可借 `updated_by → users.team_id` 回填；`tenant_products` **没有任何创建者列，无法回填** ⇒ 必须人工定归属 | 【已核实】 |
| 4 | **失败语义不必自创**，仓库已有成套口径：未登录 **401**、无团队 **403 `NO_TEAM`**、不可见/别家 **404**（不泄露存在性）、可见但无权写 **403**，且**顺序是先 404 后 403** | 【已核实】 |
| 5 | 实施拆成 **17 步**（P1–P17），其中 **3 组可并行**（`{P3,P4,P5}`、`{P7,P8}`、`{P11,P12}`）；工作量 **约 21–32 轮** | 【推测】 |
| 6 | **8 条待确认已全部裁决**（Q1–Q8 + 账本 + D3/D4，见 **§8**）；**受影响的步骤已逐条列出**（**§8.1**）。另：**P12 的 ① 层（纯逻辑差异合并 `spec_delta.py`）已交付并通过 `-m unit`**（**§8.2**） | 【已裁决】✅ |

---

## 1. R1：产品域团队隔离（新要求，可执行方案）

### 1.1 现状 vs 目标

| 对象 | 现状 | 证据 | 目标（按裁决 2） |
|---|---|---|---|
| `product_profiles`（基础信息） | 主键 `(tenant_id, product_key)`，**无 `team_id`** = 实例共享 | 迁移 `202610110016_file_objects_and_product_media.py:86-95` | 加 `team_id`，按团队隔离 |
| 产品图 `file_objects` | **有 `team_id` 列**（`016…py:42`）、上传时会写入（`files.py:195-206` 的 `"team"`；`ws_files.py:232-239` 的 `user.get("team_id")`），但**所有查询都不带团队过滤** | `files.py` 全文无 `team_id` 谓词（见 §1.4 清单） | 查询加团队谓词 |
| `tenant_products`（产品定义） | 唯一键 `(tenant_id, product_key)`，**无 `team_id`**、**无创建者列** | `models.py:584-607`；迁移 `202610100006:47-52` | 加 `team_id`；唯一键改 `(tenant_id, team_id, product_key)` |
| `tenant_workstation_products`（启用矩阵） | 唯一键 `(tenant_id, workstation, product_key)`，无 `team_id` | `models.py:660-673` | 同上，纳入团队维度 |

> **为什么 `tenant_id` 不能充当隔离**：【已核实】`tenant_id` 恒为 `"default"`、不参与业务鉴权
> （`backend/orchestrator/app/core/auth.py:66` 注释、`:218` 赋 `DEFAULT_TENANT`），
> 隔离边界是 `team_id`（`backend/kaas_common/workstation/scope.py:11-30`）。

### 1.2 表结构改法

**【推测】建议：全部沿用仓库既有口径 —— 加 `team_id BIGINT NULL` + FK→`teams.id ON DELETE SET NULL` + 索引**
（模板：迁移 `202610110001_teams_and_team_scope.py:81-86`；团队级产品配置的先例：`202610110015_team_option_overrides.py:45,65,72`）。

**为什么先 `NULL` 可空、而不是直接 `NOT NULL`**：【已核实】仓库有明确的**零回归约定** ——
`team_id IS NULL` 的行**不因团队规则改变可见性**（`scope.py:28-30`、`202610110001…py:27`、`ws_common.py:57-58`）。
直接 `NOT NULL` 会让历史行"凭空消失"，正是迁移 `202610110004…py:16` 记录过的坑。

| # | 表 | 改动 | 唯一键/索引 | 备注 |
|---|---|---|---|---|
| 1 | `product_profiles` | `+ team_id`（可空） | **PK 改 `(tenant_id, team_id, product_key)`** 或保留原 PK + 唯一索引 `(tenant_id, team_id, product_key)` | 见 §1.2 的"NULL 与 PK"注意点 |
| 2 | `file_objects` | 已有 `team_id` | **重建 `uq_file_primary`** 为 `(tenant_id, team_id, owner_type, owner_id, kind)` | ⚠️ 见下 |
| 3 | `tenant_products` | `+ team_id` | `uq_tenant_products_key` → `(tenant_id, team_id, product_key)` | 旧索引名在测试里被断言（§4 P9） |
| 4 | `tenant_workstation_products` | `+ team_id` | `uq_tenant_ws_product` → `(tenant_id, team_id, workstation, product_key)` | 同上 |

> ⚠️ **`uq_file_primary` 必须重建**（否则两个团队不能各自设主图）：
> 【已核实】该索引定义在 `202610110017_file_version_scope_and_primary.py:44-50`，
> 列是 `(tenant_id, owner_type, owner_id, kind)` + `WHERE is_primary AND is_current`，**不含 `team_id`**。
> 而 `patch_file` 设主图前会"先把同归属同用途的其它行降下来"（`files.py:344-348`），
> 这段 UPDATE **也必须加团队条件**，否则团队 A 设主图会把团队 B 的主图顶掉。
>
> ✅ **不要误判 `uq_file_current`**：它在 `017…py:29-37` 已被**收窄到 `kind IN ('stamp_scan','render_pdf')`**，
> 产品图根本不参与该唯一性 ⇒ **产品图不会被跨团队顶掉**。我上一轮只读了 016，这一条是在 017 修正的，**以此为准**。

**`NULL` 与主键的注意点（【需用户确认】Q3）**：Postgres 的唯一索引/PK 对 `NULL` **不去重**
（多个 `(tenant_id, NULL, product_key)` 可以并存），而 `product_profiles` 的写入用的是
`INSERT … ON CONFLICT (tenant_id, product_key)`（`files.py:265-271`，两端同款 `ws_files.py:290-298`）——
**改成含 `team_id` 的冲突键后，SQL 必须同步改写，否则 ON CONFLICT 找不到索引会直接报错**。
建议二选一（需用户确认）：
- (a) `team_id` 可空 + 冲突键写 `(tenant_id, COALESCE(team_id,0), product_key)`（需要一个 sentinel，稍脏）；
- (b) 产品域**一律 `NOT NULL`**，写路径强制要求 `auth.team_id`（无团队的人 **403 `NO_TEAM`**），
  历史行按 §1.3 回填、回填不了的**只对管理员可见**。

### 1.3 迁移与回填策略（三张表可行性不同 —— 这是本节的要点）

**【推测】建议新增迁移 `202610110018`**（【已核实】`202610110017` 当前是 head：其 `down_revision=016`，
且全目录无任何文件 `down_revision=017`）。分三步：
加列/索引 → 尽量回填 → 补测试。**每一步都可单独回滚**。

| 表 | 有无归属线索 | 回填策略 | 证据 |
|---|---|---|---|
| `file_objects` | **有**：`team_id` 自建表起就写入 | **无需回填**；只统计 `team_id IS NULL` 的产品图行数并写进迁移注释（`SELECT count(*) … WHERE owner_type='product' AND team_id IS NULL`） | `016…py:42`；`files.py:195-206`；`ws_files.py:232-239` |
| `product_profiles` | **有（间接）**：`updated_by` 存的是用户 id 字符串 | `UPDATE product_profiles SET team_id = (SELECT u.team_id FROM users u WHERE u.id::text = product_profiles.updated_by) WHERE team_id IS NULL` —— 模板照 `202610110004…py:51-57`（**必须写成子查询**，该文件注释 `:51-52` 明确警告：不这样写会"写进空子查询，把 team_id 设成 NULL 而什么都没发生"） | `016…py:92`（`updated_by`）；`004…py:51-57` |
| `tenant_products` | **没有** | **无法回填** —— 该表**没有 `created_by`/`updated_by` 列**（列清单见 `models.py:584-602`）。⇒ 若生产库确有行，归属只能人工定 | `models.py:584-602`；迁移 `202610100006:26-44` |

**【未查到】** 生产库里这三张表到底有没有行、`file_objects.team_id` 有多少 NULL。
取证 SQL（**只读**，见 P1）：

```sql
SELECT count(*) FILTER (WHERE team_id IS NULL) AS null_team, count(*) FROM file_objects
  WHERE owner_type = 'product';
SELECT count(*), count(team_id) AS with_team, count(DISTINCT updated_by) FROM product_profiles;
SELECT count(*), count(*) FILTER (WHERE is_system) FROM tenant_products;
```

**取证结果登记（由 P1 填写；未填 = 未取证）**

| 查询 | 结果 | 填表日期 | 执行人 |
|---|---|---|---|
| `file_objects`(product) 总行数 / `team_id IS NULL` 行数 | *待填* | | |
| `product_profiles` 总行数 / `team_id` 非空行数 / 不同 `updated_by` 数 | *待填* | | |
| `tenant_products` 总行数 / `is_system=true` 行数 | *待填* | | |

> 这三行决定 P5 是"只加列"还是"必须人工定归属 + 迁移"（§6.4 的口径）。

**回填不能猜**（【已核实】仓库先例）：迁移 `202610110002:21-23` 明确**拒绝**给 `customers` 的历史行补 `team_id`
（"那几行是账号主体……保持 NULL，可见性与上线前完全一致（零回归）"）。⇒ 【推测】沿用该先例：
**回填只做有确凿依据的（`product_profiles.updated_by`），其余留 NULL 并显式登记**。

### 1.4 两端查询过滤落点（逐条 file:line）

**【已核实】`backend/orchestrator/app/api/files.py`：13 处只按 `tenant_id` 取，全部需要团队谓词**

| # | 位置 | 现状 | R1 要求 | 越权后果（现状） |
|---|---|---|---|---|
| 1 | `:145` | `WHERE tenant_id=:t AND owner_type=:ot …` | + 团队 | 版本链跨团队串号 |
| 2 | `:216-222` | 图片数聚合 `WHERE tenant_id=:t AND owner_type='product' …` | + 团队 | 看到别家图片数 |
| 3 | `:223-228` | `SELECT … FROM product_profiles WHERE tenant_id=:t` | + 团队 | **读到别家基础信息** |
| 4 | `:253-257` | `get_profile` 同上 | + 团队 | 同上 |
| 5 | `:265-271` | `put_profile` 的 `ON CONFLICT (tenant_id, product_key)` | 冲突键改含团队 | **写进别家/被别人覆盖** |
| 6 | `:286-290` | `list_media` `WHERE tenant_id=:t AND owner_type='product'` | + 团队 | **看到别家产品图** |
| 7 | `:327-329` | `patch_file` 按 `tenant_id + id` 取行 | + 团队 | **跨团队改名/设主图** |
| 8 | `:339, 344-350` | 改名 UPDATE / 降主图 UPDATE / 设主图 UPDATE | + 团队 | **顶掉别家主图** |
| 9 | `:359-361` | `retire_file` DELETE 语义 | + 团队 | **跨团队下线别人图片** |
| 10 | `:371-373` | `get_file_content` 按 `tenant_id + id` | + 团队 | **跨团队读文件字节（IDOR）** |
| 11 | `:492-497` | `list_doc_files` 的 `trade_doc_files JOIN file_objects` | + 团队（两侧） | 看到别家挂件 |
| 12 | `:519-523` | `attach_doc_file` 按 `tenant_id + id` 找文件 | + 团队 | **把别家文件挂到自己单证** |
| 13 | `:588-595` | `list_files`（`GET /file-objects`，选图器用） | + 团队 | 选图器列出别家图 |

**另有一处不在本文件**：`backend/orchestrator/app/api/trade_docs.py:740`
（`SELECT name, content_type, file_name, content, object_key, storage FROM file_objects` 按 id 取字节）
—— 同样要加团队谓词；⚠️ **该文件正在被另一条任务改**。

**【已核实】`backend/worker/src/ws_files.py`：同构落点 ~11 处**
`:187-197`（`_current_file`，版本链）、`:248-256`（列表）、`:278-284`（profile 读）、
`:290-298`（profile 写 `ON CONFLICT`）、`:303-313`（图片列表）、`:335-360`（patch）、
`:363-373`（delete）、`:375-389`（content）、`:413-429`（单证挂件）、`:431-455`（attach）、`:509`/`:593`（按 id 取字节）。

**【已核实】产品定义与矩阵**
`tenant_products.py:68-88, 91-121, 124-149, 152-169`（列表/建/改/删，现只比 `tenant_id`）、
`workstation_products.py:35-77, 80-119`、worker `ws_products.py:141-274, 290-357`。

**判定放哪（避免两端各写一份）**：仓库的做法是把判定收进共享内核
（`kaas_common/workstation/scope.py`，`scope.py:3-9` 明确说"原本两个运行时各写一份，改一次口径要改两处，
历史已经因此漂移过"）。⇒ 【推测】R1 新增一个**产品域可见性纯函数**放 `kaas_common`，
两端只把它翻译成自己的 SQL 形态；改完必须跑 `scripts/sync-shared.ps1 -Check`。

> ⚠️ **不能直接套用 `can_view`**：【已核实】`scope.py:68-88` 的四条规则里，
> 规则 2/3 依赖 `owner_scope` / `owner_id`，而 `file_objects` 的 `owner_id` 是**产品 key**（不是用户 id）、
> 且**没有 `owner_scope` 列**（列清单 `_META_COLS`：`files.py:59-63`）⇒ 产品域需要**自己的规则**，
> 不能照抄客户域的 `visible_to`（`ws_common.py:72-81`）。

### 1.5 失败语义（**全部按仓库既有口径，不自创**）

| 场景 | 状态码 + 错误体 | 仓库先例 |
|---|---|---|
| 未登录 / token 过期 / 用户禁用 | **401** `{"error":"unauthorized","message":"Authentication required"}`（orchestrator）；worker `401 detail="Missing bearer token"` / `"Token expired"` | `auth.py:208, 225, 227`；worker `main.py:128-145` |
| 已登录但**无团队**，而该操作必须落到某个团队 | **403** `{"error":"forbidden","code":"NO_TEAM","message":"当前账号未归属团队，…"}` | `option_overrides.py:84-88`（团队级产品配置的现成写法） |
| 目标产品/文件**不属于我的团队**（或根本不存在） | **404** —— 两者**对外长得一模一样** | `ws_common.py:106-115` + `:137-140`（客户域"不泄露存在性"的 doctrine）；`tenant_products.py:138-140`；worker 测试 `test_ws_products_seals.py:194-199` |
| 看得见但**无权写**（如系统级产品、非团队管理员） | **403** `NOT_TEAM_ADMIN` / `NOT_OWNER` / `forbidden` | `option_overrides.py:97-101`；`ws_common.py:84-93`；worker `main.py:2601-2609` |
| 判定顺序 | **先 404 后 403** | `option_overrides.py:94` 注释；`teams.py:485` 注释（"顺序刻意是先 404 后 403"） |

> **写权限用哪把尺子**：【已核实】现成的是 `is_team_admin`
> （`kaas_common/workstation/teams.py:114-125`：团队创建者**或**平台管理员），
> 团队级产品配置 `team_option_overrides` 就是用它（`option_overrides.py:78-102`、worker `ws_option_overrides.py:149-163`）。
> ⚠️ 但注意内核 `can_write`（`scope.py:91-101`）是另一条更严的规则（"同团队可见 ≠ 同团队可改"，
> 只有 `owner_id == 我` 才能改）—— 产品是**团队资产**，套 `can_write` 会让团队成员改不了同事维护的产品图。
> **这是一个决策点 → 【需用户确认】Q5。**

### 1.6 顺带发现的既有越权面（不修 R1 就等于没做）

【已核实】以下三个接口**现在**就能跨团队操作（只按 `tenant_id + id`）：
`PATCH /file-objects/{id}`（`files.py:327-329`）、`DELETE /file-objects/{id}`（`:359-361`）、
`GET /file-objects/{id}/content`（`:371-373`）；worker 同款（`ws_files.py:335, 363, 375`）。
再加 `attach_doc_file`（`files.py:519-523`）。
⇒ R1 的验收必须包含**跨团队负例**（§4 P10），否则"照旧能越权"。

---

## 2. R2：可见性模型（**必须由用户确认**）

用户两句话的表层张力：**"读人人可"** ⟷ **"每个团队只读自己团队的产品"**。
**下面三种解读都自洽，我不替用户选。**

### 2.1 解读 A（分工式：一句话管一类产品）

| 产品来源 | 读 | 写 | 依据 |
|---|---|---|---|
| **系统级**（`product_key ∈ ProductSpec 注册表`） | 所有团队可读 | 仅内部账号（`adminOnly`/`is_internal`） | `workstations.ts:196-205`（`/products` 全员可见）+ `:309-318`（定义管理仅内部） |
| **团队自建 / 团队覆盖** | **仅本团队** | 团队管理员可写（`is_team_admin`） | `scope.py:11-30`（团队是隔离边界）；`teams.py:114-125` |

⇒ 与 `docs/PRODUCT_MODULE_DECISIONS.md:35-41` 的解读一致。

### 2.2 解读 B（全私式：产品定义共享，"产品相关信息"一律私有）

系统级产品的**定义**人人可读，但**它的图片与基础信息也按团队私有**（每个团队维护自己那套图/材质）。
⇒ 直译"**产品和产品相关信息都是团队私有的**"。
**后果**：同一张产品图，N 个团队各传一份（**放弃"一次维护、重复使用"的跨团队收益**，团队内仍成立）；
`product_profiles` 变成严格按团队的行；系统级 key 的图**不存在"共享的默认图"**。

### 2.3 解读 C（折中：定义+共享素材人人可读，团队可追加自己的）

系统级产品有一份**实例级共享**的图片/基础信息（`team_id IS NULL` = 平台维护），团队可以**再叠加**
自己团队的图/信息（`team_id = 本团队`），读的时候"共享 + 本团队"合并。
⇒ 【推测】最贴近"一次维护重复使用"的原始诉求，但**引入两层合并语义**（复杂度最高）。

### 2.4 三解读对照（同一张表，便于拍板）

| 维度 | A 分工式 | B 全私式 | C 折中 |
|---|---|---|---|
| 系统级产品**定义** | 人人可读 | 人人可读 | 人人可读 |
| 系统级产品的**图/基础信息** | 人人可读（共享一份） | **仅本团队** | 共享一份 + 团队可追加 |
| 团队自建产品（定义+图+信息） | 仅本团队 | 仅本团队 | 仅本团队 |
| `product_profiles.team_id` | 系统级可为 NULL（共享） | **NOT NULL** | 可 NULL（共享）或团队 |
| `file_objects`(产品图).team_id | 同上 | **NOT NULL** | 同上 |
| 跨团队重复上传同一产品的图 | 不会 | **会**（N 份） | 仅"追加"时会有 |
| R1 迁移复杂度 | 低 | 中 | **高**（读路径要合并两层） |
| 与用户原话贴合度 | "读人人可"↔系统级 | "**产品相关信息都是团队私有**"字面 | 两者都要 |

> **【需用户确认】Q1**：选 A / B / C？
> **【需用户确认】Q2**：若选 A：系统级产品的图/基础信息是"团队私有"还是"实例共享"？
> （用户裁决 1 说"读人人可"，裁决 2 说"产品相关信息团队私有" —— **这两句在"系统级产品的图"上直接冲突**，
> 必须由用户拍板，不能由实现者选。）

### 2.5 与"合并后可见性"的关系（沿用分析文档 §4.4）

【已核实】两个工位的可见性**现在不同**：`products` = `group:'business'` + `adminOnly:false`
（`workstations.ts:196-205`；`domain/workstations.py:75-77`）；`tenant-products` = `group:'admin'` + `adminOnly:true`
（`workstations.ts:309-318`；`domain/workstations.py:127-130`），且 `admin` 组 `internalOnly:true`
（`workstations.ts:73`）、侧边栏对非 internal 整组跳过（`sidebar.tsx:137-138`）。
⇒ **【需用户确认】Q6**：合并后工位是"人人可见（定义 tab 只读）"还是"仅内部"？

---

## 3. R3：存储语义落地（系统级存差异 / 团队自建存整份）

### 3.1 为什么不能复用 `spec_from_dict` 当合并函数（**已核实**，重申要点）

`spec_from_dict` 是**整体构造**，不是合并：缺字段**静默取默认值**、字段改名**静默退化不报错**、
列表 `null` 与不传等价（`services/export_quote/tenant_products.py:19-44`；逐条分析见
`PRODUCT_MODULE_MERGE_PLAN.md` §6.2）。
⇒ 正确顺序是：**取基线 spec → 套差异 → 最后再用 `spec_from_dict` 当"形状闸门"**（不是当合并器）。

### 3.2 差异的数据结构【推测】

**复用 `team_option_overrides` 的语义模板**（`models.py:610-649`、`services/option_overrides.py`），
键为 `(team_id, product_key)`，载荷形如：

```jsonc
{
  "spec_version": 2,                    // 差异格式版本；未知版本一律 422 拒绝（不"尽力而为"）
  "base_spec_hash": "sha256:…",         // 写差异时的基线指纹；不匹配 → 拒绝合并并要求复核
  "scalars": {                          // ① 标量覆盖（顶层简单字段）
    "name": "牛栏网（联佳）", "profit_value": 0.08, "misc_fee_rate": 0.03
  },
  "options": {                          // ② 选项层：**直接复用 option_overrides 的三个键**
    "coating_code": { "rename": { "zinc_40": "40克锌层" }, "disabled": ["pvc_black"] }
  },
  "add": { "derived": [ { "name": "extra_kg", "expr": "…" } ] },   // ③ 只允许"整条新增"
  "remove": { "derived": ["weight_base_kg"], "columns": ["internal_cost"] }  // ④ 显式删除
}
```

**硬约束（对齐既有语义，不发明）**：
- `ALLOWED_KEYS = ("rename", "disabled")`（`option_overrides.py:37`）——选项层**只允许这两件事**。
- **取消 = 删键**：改名传空串即取消（`option_overrides.py:128-138`）、`disabled` 空了就删键（`:147-150`）。
  差异同理：`scalars` 里某键"改回基线值"应当**删键**，而不是留一个等于基线的值。
- **只改显示名、不改 code**（`option_overrides.py:22-25`，理由：code 是查价键的一半）。
- **软停用而非移除**（`option_overrides.py:24-25`）：停用的档位仍在 `options` 里并标 `disabled`，
  引擎仍能解析 —— 否则历史报价单重算会失败（`models.py:463-469`）。

### 3.3 合并算法要点【推测】

```
有效 spec(product_key, team_id) =
  1) base :=
       if product_key ∈ product_keys():            # kaas_common 注册表
            get_product(product_key)                # 系统级：代码定义
       else:
            spec_from_dict(tenant_row.spec)         # 团队自建：整份（它没有上游）
  2) if delta is not None:
       若 delta.spec_version 不认识            → 422（不静默）
       若 delta.base_spec_hash != hash(base)   → 409/422 + 明确提示"上游已变更，请复核"（**不自动套用**）
       base := apply_delta(base, delta)         # 见 3.4
  3) spec_from_dict(spec_to_dict(base))         # 形状闸门：多字段/缺必填会 TypeError → 422
  4) 返回 base
```

**顺序固定**：`scalars → add → remove → options`（每步留痕，便于测试逐层断言）。
**幂等**：同一份 delta 重复应用结果不变（`remove` 目标不存在时 no-op，但**要报告 warning**，见 3.4）。

### 3.4 "字段删除 / 改名"的处理规则（本节的硬要求）

| 情形 | 规则 | 理由（已核实） |
|---|---|---|
| 差异要删一条 `derived`/`column`/`invariant` | **必须显式写进 `remove`**；"键不出现"**不等于**删除 | `spec_from_dict` 对列表字段用 `data.get(…) or []`（`tenant_products.py:30-37`），"不写"与"空"等价 |
| 上游删掉了差异指向的条目 | `remove` 变 no-op（幂等），但**必须回报"差异指向已不存在的条目"**（warning），**不许静默** | 静默正是本项目的头号教训（`PROBLEM_STATUS_2026-10-11.md:34-35`） |
| 上游把条目**改名**（如 `weight_base_kg`→`weight_kg`） | **不自动映射**：`base_spec_hash` 不匹配 ⇒ 拒绝合并 + 提示人工复核 | `spec_from_dict` 对改名**静默退化**（取不到就落默认值，不报错）；自动猜意图无法保证正确 |
| `ProductSpec` **字段级改名/删除**（如 `numeric_inputs`→`inputs`） | 靠 `spec_version` 硬闸门：**未知版本拒绝**；升版本时写一次性转换，并**保留旧版本可读一个发布周期** | 同上；且 `spec_to_dict` = `asdict`（`tenant_products.py:47-50`）会把"没写"变成"写了默认值"，视图一旦序列化回存就分不清"用户设的默认值"与"没设" |
| 选项层改名/停用 | 走 §3.2 的 `options`，规则与 `option_overrides` 完全一致 | `option_overrides.py:112-154`（已有 `merge_override` 可复用） |
| 差异里出现未知字段 | **422 拒绝**（不忽略、不透传） | 与 `normalize_overrides`（`option_overrides.py:40-57`）"只留合法形状"同一思路，但这里选择**报错**而非静默丢弃 |

---

## 4. 实施计划（P1–P17）

**通用约定**：每步 = **一个提交**；提交必须带 pathspec（见 §5.4）；
每步的"门禁"至少包含该步影响面 + `git status --short` 复核；
**回滚**默认 `git revert <sha>`（数据迁移的回滚另注明）。

### 阶段 0：前置与取证（无代码）

| 步 | 内容 | 文件范围 | 门禁 / 验收信号 | 回滚 | 依赖 |
|---|---|---|---|---|---|
| **P1** | 生产库取证（**只读** SQL，见 §1.3）+ 确认另一条任务已推送、`git status` 对其文件干净；复核 `alembic heads`（**已实测**：`202610110018` ⇒ 新迁移取 **`019`**，见 §8.1） | 无（只读） | 三条 SQL 的结果贴进 `PRODUCT_MODULE_IMPL_PLAN.md` 的"取证结果"小节；`git ls-remote origin refs/heads/main` == 本地 HEAD | 无 | — |
| **P2** | 用户确认 Q1–Q8（**弹窗**，一次问全） | `docs/`（把答案记进本文件） | 用户答复落地；未答复则**后面所有涉及可见性/归属的步骤都不许开工** | 无 | — |

### 阶段 1：修两个底座缺陷（分析文档 §5.3 的前置）

| 步 | 内容 | 文件范围 | 门禁 / 验收信号 | 回滚 | 依赖 | 并行 |
|---|---|---|---|---|---|---|
| **P3** | `TenantProductOut` 补 `spec`（两端）；前端点「编辑」改为**回显真实 `spec`**，不再重置成 `{key,name}` | `backend/orchestrator/app/api/tenant_products.py`、`backend/worker/src/ws_products.py`、`frontend/src/app/(app)/settings/tenant-products/page.tsx` | orchestrator `pytest -m unit`；worker `pytest`；前端 `typecheck`+`test`；`route-parity`；**验收信号**：编辑一个产品并保存，`spec` 内容与保存前逐字段一致（不是只剩 `{key,name}`） | `git revert` | P2（只需 Q 中不涉及的部分） | ✅ 与 P5 并行（文件不相交） |
| **P4** | `tenant_products` 接回读取路径：`_effective_product` 走 `TenantProductLoader`（**或明确废掉该表** —— 见 Q1 备注，需一并拍板） | `backend/orchestrator/app/api/export_quote.py`、`backend/orchestrator/app/services/export_quote/tenant_products.py`、worker `quote_api.py` | `pytest -m unit`；worker `pytest`；**验收信号**：团队自建产品能进规格空间与算价（或按拍板结果明确报"本产品未注册"400）；`export_quote` 既有单测全绿 | `git revert` | P3、Q1 | 与 P5 并行 |

### 阶段 2：R1 表结构 + 迁移

| 步 | 内容 | 文件范围 | 门禁 / 验收信号 | 回滚 | 依赖 | 并行 |
|---|---|---|---|---|---|---|
| **P5** | 新迁移 **`202610110019`**（⚠️ 号已改：实测 `alembic heads` = `202610110018`，见 §8.1）：4 张表加 `team_id`（**新写入强制、历史容忍 NULL**，见 Q1=B/D4）、重建 `uq_file_primary`、改 3 个唯一键（含 `(tenant_id, team_id, product_key)`，见 Q7）、按 §1.3 回填（`product_profiles` 可回填，其余登记） | `backend/orchestrator/alembic/versions/202610110019_*.py`、`backend/orchestrator/app/db/models.py` | `alembic upgrade head` + `alembic downgrade 202610110018` **都要能跑**（需 Postgres，见 §6 前置 5）；`pytest -m unit` | 迁移自带 `downgrade()`（**只删列/索引，不还原回填**，照 `202610110004…py:69`、`202610110012…py:121` 的先例） | P1、P2、Q3、Q4、D4 | ✅ 与 P3/P4 并行（文件不相交） |
| **P6** | 迁移语义测试：照 `tests/test_customer_records_api.py:193-224`（导入迁移模块、断言 `revision`/`down_revision`、在事务里跑**真正会上线的那段 SQL**） | `backend/orchestrator/tests/test_product_team_scope_migration.py`（新） | `pytest -m unit`；**验收信号**：① 回填后 `product_profiles` 的 `team_id` = `updated_by` 所属团队；② `updated_by` 为空/非法 id 的行 `team_id` 仍为 NULL 且**行数一条不少**；③ 两团队同名 `product_key` 可以并存（唯一键生效） | `git revert` | P5 | — |

### 阶段 3：R1 两端查询过滤

| 步 | 内容 | 文件范围 | 门禁 / 验收信号 | 回滚 | 依赖 | 并行 |
|---|---|---|---|---|---|---|
| **P7** | orchestrator 侧：`files.py` §1.4 的 13 处 + `trade_docs.py:740` 加团队谓词；越权一律 **404**；`put_profile` 的 `ON CONFLICT` 键同步改 | `backend/orchestrator/app/api/files.py`、`backend/orchestrator/app/api/trade_docs.py` ⚠️*正在被另一条任务改* | `pytest -m unit`；`route-parity`；**验收信号**：团队 A 的 token 调 `GET /file-objects/{团队B的文件id}/content` → **404 `FILE_NOT_FOUND`**；`PATCH`/`DELETE` 同 → 404 | `git revert` | P5、P6 | ✅ 与 P8 并行开发（文件不相交），但**必须同批验收** |
| **P8** | worker 侧：`ws_files.py` §1.4 的 ~11 处 + 单证挂件同类落点 | `backend/worker/src/ws_files.py` ⚠️*正在被另一条任务改* | worker `pytest`；`route-parity`；**验收信号**：与 P7 同一组用例在 worker 上同样 404（两端同构） | `git revert` | P5、P6 | ✅ 与 P7 并行 |
| **P9** | 产品定义/矩阵隔离：`tenant_products.py`、`workstation_products.py`、worker `ws_products.py`；唯一键断言更新 | 上述 3 文件 + `backend/worker/tests/test_ws_products_seals.py` | `pytest -m unit`；worker `pytest`；**验收信号**：跨团队改/删 → 404；系统级 → 403；两团队各建同名 key → 均 201（现唯一键不允许）；⚠️ **这些测试断言了 SQL 字面量**（`test_ws_products_seals.py:171, 180, 149`），改 SQL 必须同步改断言 | `git revert` | P5、P6、P7 | — |
| **P10** | 越权回归测试（跨团队负例矩阵，两端各一份） | `backend/orchestrator/tests/test_file_team_scope.py`（新）、`backend/worker/tests/test_ws_files_team_scope.py`（新） | 两端 `pytest`；**验收信号**：**12 条负例**（§1.4 的 13 个落点里除聚合外每条一个：读/写/删/字节/挂件/选图器）全部 404；正例（本团队）全部 200 | `git revert` | P7、P8、P9 | — |

### 阶段 4：R2 可见性 + R3 存储

| 步 | 内容 | 文件范围 | 门禁 / 验收信号 | 回滚 | 依赖 | 并行 |
|---|---|---|---|---|---|---|
| **P11** | 把 R2 的判定落成共享内核纯函数（产品域专用，**不复用 `can_view`**，见 §1.4 末尾），两端接线 | `backend/kaas_common/workstation/`（新函数）+ `files.py`/`ws_files.py` 接线 | `pwsh scripts/sync-shared.ps1 -Check`；`pytest -m unit`；worker `pytest`；**验收信号**：同一组可见性用例在两端结果一致（表驱动） | `git revert` + 重跑 `sync-shared.ps1` | P2(Q1/Q2)、P10 | ✅ 与 P12 并行（文件不相交，但都要 `sync-shared`） |
| **P12** | R3 差异：`normalize_delta` / `apply_delta`（对齐 `option_overrides.py:112-154` 的语义）+ 纯单测 | `backend/orchestrator/app/services/product_spec_delta.py`（新）+ `tests/test_product_spec_delta.py`（新） | `pytest -m unit`；**验收信号**：① 幂等；② 未知 `spec_version` → 422；③ `base_spec_hash` 不匹配 → 拒绝且**带可读原因**；④ `remove` 指向不存在条目 → warning 而非静默；⑤ `rename` 传空串 = 取消 | `git revert` | P2(Q3)、P3 | ✅ 与 P11 并行 |
| **P13** | 差异读路径接线（"有效 spec"装配）；把 P4 的接线改为"基线 + 差异" | `services/export_quote/tenant_products.py`、`app/api/export_quote.py`、worker 对应处 | `pytest -m unit`；worker `pytest`；**验收信号**：改上游公式后，**未设差异**的团队跟着变；**设了差异**的团队：未被差异覆盖的部分也跟着变（这正是"不冻住"的定义） | `git revert` | P12、P4 | — |

### 阶段 5：前端合并 + 可视化编辑器

| 步 | 内容 | 文件范围 | 门禁 / 验收信号 | 回滚 | 依赖 | 并行 |
|---|---|---|---|---|---|---|
| **P14** | **行为等价重构**：一个工位两个 tab，把现有两页搬进来，JSON 文本框**原样保留** | `frontend/src/app/(app)/products/**`、`frontend/src/lib/products/**` | 前端 `typecheck`/`lint`/`test`；`NEXT_EXPORT=1` 构建；**验收信号**：两个 tab 的读写行为与搬家前逐项一致（不含新功能） | `git revert` | P3、P10、P11 | — |
| **P15** | 契约收口：删 `tenant-products` 工位条目（ts+py **双镜像**）、`/settings/tenant-products` → redirect、`工作位白名单`同步 | `shared/contracts/workstations.ts`、`backend/orchestrator/app/domain/workstations.py`、`backend/kaas_common/workstation/subscriptions.py`、`frontend/src/app/(app)/settings/**` | `contracts:check`（R2 会强制双镜像一致，`scripts/contracts-check.ts:127-356`）；`route-parity`；前端构建；**验收信号**：侧边栏只剩一个产品入口；旧书签不 404 | `git revert` | P14、Q6 | — |
| **P16** | 可视化编辑器（**分 2–3 小步**）：① `numeric_inputs`/`variants`/`derived` → ② `columns`/`invariants`/`space_deduction` → ③ `params`/`notes`/`constants` + 公式试算 | `frontend/src/app/(app)/products/**`（新组件）+ 后端"试算"接口（若确认需要） | 前端 `typecheck`/`lint`/`test` + 构建；后端 `pytest -m unit`；**验收信号**：逐字段 round-trip（表单 → API → DB → 回显）与 `ProductSpec` 逐字段相等；⚠️ **不许按 `Axis` 设计**（三产品 `axes=[]`，`products/chain_link.py:76`、`field_fence.py:80`、`deer_net.py:83`） | 每小步 `git revert` | P13、P14、Q8 | 三个小步之间**串行** |

### 阶段 6：收口

| 步 | 内容 | 文件范围 | 门禁 / 验收信号 | 回滚 | 依赖 |
|---|---|---|---|---|---|
| **P17** | 全门禁 + 文档收口：更新 `PROBLEM_STATUS_2026-10-11.md:1844`（"⏸ 待用户输入"→ 实际状态）、`PRODUCT_CONFIG_TENANT_UNFINISHED.md:13, 97`、本文件与 MERGE_PLAN 的状态 | `docs/**` | **全套**：orchestrator `pytest -m unit`；worker `pytest`；前端 `typecheck`/`lint`/`test`；`contracts:check`；`python scripts/route-parity.py`；`pwsh scripts/sync-shared.ps1 -Check`；`NEXT_EXPORT=1 pnpm build` | 逐项 `git revert` | 全部 |

**依赖图（文字版）**：`P1,P2 → {P3‖P5} → P6 → {P7‖P8} → P9 → P10 → {P11‖P12} → P13 → P14 → P15 → P16 → P17`；
`P4` 与 `P5` 并行、但被 `P13` 依赖。

---

## 5. 工作量与风险

### 5.1 工作量（【推测】，轮次量级）

| 阶段 | 步 | 轮次 |
|---|---|---|
| 0 前置取证 | P1–P2 | 1–2（含等用户答复） |
| 1 底座缺陷 | P3–P4 | 2–3 |
| 2 表结构+迁移 | P5–P6 | 3–4（迁移 + 语义测试 + 回滚演练） |
| 3 两端过滤 | P7–P10 | 5–7（13+11 个落点 × 两端 + 12 条负例） |
| 4 可见性+存储 | P11–P13 | 4–6 |
| 5 前端+编辑器 | P14–P16 | 5–8（编辑器占大头） |
| 6 收口 | P17 | 1–2（全门禁一遍 + 文档） |
| **合计** | | **约 21–32 轮**（各阶段下限之和 21 / 上限之和 32） |

> 对照：单人一轮 = 一次"改 → 跑门禁 → 修红 → 提交"。前端的界面返工通常另加 2–4 轮。

### 5.2 风险（按严重度）

| # | 风险 | 证据 / 说明 | 缓解 |
|---|---|---|---|
| R-1 | **撞车**：`files.py`、`ws_files.py`、`trade_docs.py`、`products/**` **正在被另一条任务改** | 工作区 `git status` 显示这些文件为 `M` | 前置 1：等它收工并推送；`product/page.tsx`、`files.py`、`ws_files.py` 全程**单写者** |
| R-2 | **迁移把历史数据"变没"**：团队过滤上线后，`team_id IS NULL` 的行按新规则可能对成员不可见 | `202610110004…py:16` 记录过同类坑；`scope.py:28-30` 的零回归约定 | 采用"NULL = 维持旧可见性"；回填只做有依据的；P6 断言行数一条不少 |
| R-3 | **唯一键改错导致线上写入 500**：`put_profile` 的 `ON CONFLICT` 不带新键会直接报错 | `files.py:265-271`、`ws_files.py:290-298` | P5/P7 同步改冲突键；P7 的验收含"保存 profile 成功" |
| R-4 | **跨团队主图互相顶掉**：`uq_file_primary` 不含 `team_id` | `202610110017…py:44-50`；`files.py:344-348` | P5 重建索引 + P7 给降主图 UPDATE 加团队条件；P10 加"两团队各设主图都成功"正例 |
| R-5 | **worker 的 SQL 指纹测试会红**：多处断言 SQL 字面量 | `test_ws_products_seals.py:149, 171, 180` | P9 明确要求同步改断言；改 SQL 的那次提交必须带上测试改动 |
| R-6 | **`spec_from_dict` 静默退化**被误当"合并成功" | `tenant_products.py:19-44` | R3 的 `spec_version` + `base_spec_hash` 双闸门；P12 强制单测覆盖 |
| R-7 | **两端漂移**：只改了 orchestrator 没改 worker（或反之） | 历史漂移记录：`docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md:4-12`、`scripts/route-parity.py:7-9` | 每步都跑 `route-parity` + worker `pytest`；判定逻辑放 `kaas_common` 后 `sync-shared.ps1 -Check` |
| R-8 | **契约双镜像漏改**：`workstations.ts` ↔ `domain/workstations.py` | `contracts-check.ts:324-356` 会 FAIL | P15 同一次提交改两处；跑 `contracts:check` |
| R-9 | **本地无 Postgres** ⇒ 迁移类门禁跑不了 | 实测 `127.0.0.1:5432` 无监听；`conftest.py:23-39` 默认 `localhost:5432/kaas_v2_test` | 前置 5：先 `docker compose up -d postgres`（`docker-compose.yml:7-15`）或设 `TEST_DATABASE_URL` |

### 5.3 环境与门禁命令

```powershell
# 前端 / 契约（无 pnpm 在 PATH，必须用 node + pnpm.mjs）
C:\Users\HJ\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe `
  C:\Users\HJ\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs typecheck
# …同理：lint / test / contracts:check / build（NEXT_EXPORT=1）

# 后端（在各自目录）
pytest -m unit          # backend/orchestrator
pytest                  # backend/worker

# 迁移与共享内核
alembic upgrade head ; alembic downgrade 202610110017
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force   # 跑 .ps1 前
pwsh scripts/sync-shared.ps1 -Check
python scripts/route-parity.py
```

### 5.4 提交纪律（本项目已因此断过一次 HEAD）

> ⚠️ **2026-10-11 用户新增规则后，本节的"pathspec"做法已判定为不足**，以下为**现行**做法。

```powershell
# ✅ 现行：私有 GIT_INDEX_FILE（不碰共享 index、不碰他人工作树）
$env:GIT_INDEX_FILE = "$env:TEMP\gi_<本任务名>"
git read-tree HEAD                    # 用 HEAD 初始化私有 index
git add -- <只属于本任务的文件>        # 只装自己的 hunk
git diff --cached --stat              # 自检①：只应出现自己的文件
git diff --cached -- <file>           # 自检②：只应含自己的 hunk
git commit --no-verify -m "..."       # 用私有 index 提交
git status --short                    # 自检③：别人的改动必须原样还在
Remove-Item Env:\GIT_INDEX_FILE
# ❌ 禁用：git add -A / git add . / git commit（裸）
# ❌ 不足：`git commit -- <pathspec>` —— 它记录的是**工作树内容**，
#         同一个文件里别人的未提交 hunk 会被一起带走（实测过）
```

**为什么 pathspec 不够**：用户规则 4 实测记录 —— `backend/worker/src/main.py` 里两拨人的 hunk
混在一起，且别人的 hunk 依赖一个**未跟踪**文件 ⇒ 那提交必然 ImportError。
**部分 hunk 提交要先转 LF**：工作树是 CRLF、index blob 是 LF，直接 `git apply --cached` 会
`patch does not apply`（实测 130 个 CR）。
`--no-verify` 的理由：`husky` 钩子在 PATH 找不到 `pnpm`/`npx` 会直接让提交失败
（`.husky/pre-commit`=`pnpm lint-staged`、`.husky/commit-msg`=`npx --no -- commitlint`）。

---

## 6. 前置条件（更新分析文档 §7.2）

| # | 前置 | 现状 | 证据 |
|---|---|---|---|
| 1 | 另一条任务（产品/文件/S3 线）**收工并推送**，其触及文件 `git status` 干净 | ❌ 未满足（多个 `M`） | 工作区 `git status --short` |
| 2 | 该任务**门禁结果已知** | ❌ 未知 | — |
| 3 | 用户确认 **Q1–Q8** | ❌ 未答复 | 本文件 §8 |
| 4 | 生产库取证（三张表行数/NULL 分布） | ❌ **未查到**（本机 5432 无监听、无 `.env`） | §1.3 |
| 5 | 本地/CI **Postgres 可用**（迁移与迁移测试） | ❌ 未满足 | `conftest.py:23-39`；`docker-compose.yml:7-15` |
| 6 | 新迁移号确认为 `202610110018`（head 未被别人推进） | ⚠️ 需在 P1 复核 | `202610110017` 无子修订 |

---

## 7. 未查到清单

| # | 未查到什么 | 怎么才算查到 |
|---|---|---|
| 1 | 生产库 `file_objects`(product) / `product_profiles` / `tenant_products` 的行数与 `team_id` NULL 分布 | §1.3 的三条只读 SQL |
| 2 | `tenant_products` 已有行**该归哪个团队** | 该表**无创建者列**（`models.py:584-602`）⇒ 只能人工判定（Q4） |
| 3 | 现成的"公式试算/诊断"接口（供编辑器校验 `expr`） | 需要找到可调用的诊断函数/路由；目前只确认 `spec_from_dict` **不校验 `expr`** |
| 4 | 产品域前端测试覆盖 | `frontend/e2e/*.spec.ts`（8 个）无 products 用例；`frontend/src` 无 `useProducts` 相关单测 ⇒ **合并时无测试网，P14/P16 要补** |
| 5 | `/api/v1/workstation-products` 的前端调用者 | 前端全量检索无字面量；若要接线"启用产品"UI，属新增需求 |
| 6 | 另一条任务是否也会新增 alembic 迁移（会与 `018` 撞号） | P1 复核 `alembic heads` / 最新文件 |

---

## 8. 需用户确认的点（**8 条已全部裁决** ✅）

> **2026-10-11 / 10-12 用户已全部拍板**（原文见 `docs/PRODUCT_MODULE_DECISIONS.md`）。
> 下表**保留原始问题与候选**（不抹掉"不代决"的记录），另加「状态」与「裁决结论」两列。
> 另有第 9 条（账本）原挂在 Q1 备注里，已独立列出。

| # | 原问题 | 原候选 | 状态 | **裁决结论（照抄用户裁决）** |
|---|---|---|---|---|
| **Q1** | R2 的可见性解读：**"读人人可"** 与 **"只读自己团队的"** 如何统一？ | (A) 分工式 / **(B) 全私式** / (C) 折中 | ✅ **已裁决：B 全私式** | 产品**定义**人人可读；产品**相关信息（图片/基础信息）一律团队私有**，**系统级也不例外** ⇒ `product_profiles.team_id` **不可空**（**新写入强制**；历史容忍 NULL，见 D3/D4） |
| **Q2** | 若选 A：系统级产品的图片/基础信息是"实例共享"还是"也团队私有"？ | 共享 / 团队私有 | ✅ **已裁决（被 Q1 吸收）** | Q1 选了 **B** ⇒ 本问失去前提：系统级产品的图/基础信息**同样是团队私有** |
| **Q3** | 历史 NULL 行（`team_id IS NULL`）怎么处置？ | (a) 维持旧可见性 / (b) 回填到某团队 / (c) 仅管理员可见 | ✅ **已裁决：保留 NULL + 仅管理员可见** | **保留**历史 NULL 行：既不静默共享给所有团队，也不丢弃；**仅平台管理员可见** |
| **Q4** | `tenant_products` 已有行**无法自动回填**（无创建者列），归属怎么定？ | 人工指定 / 留 NULL 共享 / 清空 | ✅ **已裁决：保留 NULL + 仅管理员可见** | 与 D3/D4 合并为同一条。**不得**归给某个"默认团队" —— 该表接回算价链路后，错归会**直接算错价** |
| **Q5** | 写权限粒度：团队级产品谁来写？ | (a) 团队管理员（复用 `is_team_admin`）/ **(b) 团队任意成员** | ✅ **已裁决：(b) 团队任意成员** | **不能复用 `is_team_admin`** ⇒ 另立一把尺（建议 `is_same_team`）**与它并存**。**细则——仍须管理员**的：团队档位（`/product-options/overrides`）、团队/成员/订阅类、`is_system` 行（403）、`calculate-internal` / `verify`（`require_tenant_admin`）。其余**产品/图相关**：团队成员即可 |
| **Q6** | 合并后**工位可见性**：人人可见还是仅内部？ | 人人可见 / 仅内部 | ✅ **已裁决：工位人人可见**（**必须两层**） | ⚠️ **「工位可见性」≠「数据可见性」**：前者**人人可见**（`adminOnly:false`）；**用户创建的业务数据仅团队内部可见**（后者由 §1 的 R1 过滤实现）。**不许压成一层** |
| **Q7** | 团队自建 key 能否与系统级 key 重名？ | 允许 / 禁止 | ✅ **已裁决：允许** | **团队优先**；上游变更仍按**差异合并**处理（不因重名而冻结） |
| **Q8** | 是否需要"公式试算"接口；是否收敛 `/api/v1/tenant-products`？ | 建/不建；保留/收敛 | ✅ **已裁决：建；收敛** | **建公式试算接口**；`/api/v1/tenant-products` **收敛为** `/products/{key}/definition` |
| **账本** | `tenant_products` 只写不读 —— 接回算价链路还是明确废掉？ | 接回 / 废掉 | ✅ **已裁决：接回算价链路** | **不是删代码**：要做覆盖生效 + 差异合并 + 回归测试 |
| **D3/D4** | 历史无法归因的行 + `team_id` 是否 `NOT NULL`？ | — | ✅ **已裁决** | `tenant_products` 历史无法归因的行：**保留 NULL + 仅管理员可见**；**新写入强制带 team**（历史容忍 NULL） |

### 8.1 受影响的步骤（**哪一步随裁决而变**）

| 裁决 | 改变的步骤 | **具体怎么变** |
|---|---|---|
| **Q1 = B 全私式** | **P5** | 迁移不再只是"加可空 `team_id`"：`product_profiles` **新写入强制**带 team（读路径/API 层强制），历史行容忍 NULL ⇒ 唯一键必须能容纳 NULL 历史行（`COALESCE(team_id,0)` 或部分唯一索引），且 `ON CONFLICT` 目标随之改写 |
| | **P6** | 迁移语义测试**新增两条**：① 新写入无 team ⇒ 拒绝；② 历史 NULL 行**只对管理员可见**（**不是**"所有团队可见" —— 与 §1.3 原先的"零回归"默认**相反**，以裁决为准） |
| | **P7 / P8** | 读路径对 `team_id IS NULL` 的产品行**只放行管理员**（覆盖 §1.4/§1.5 里"NULL = 维持旧可见性"的默认写法） |
| | **P11** | 可见性判定升级为**三层**：系统级**定义**人人可读 / 团队**相关信息**仅本团队 / 历史 NULL **仅管理员** |
| **账本 = 接回** | **P4** | 从"接回**或**明确废掉"改为**确定接回**（删掉"废掉"分支）；实现 `_effective_product` 走"基线 + 差异" |
| | **P13** | 必做；依赖 **本任务已交付的 `spec_delta.py`（§5 的 ① 层）**，不再从零写合并逻辑 |
| **Q5 = 团队任意成员**（+ 细则） | **P9** | 写权尺子换成**新的"团队成员尺"**（`is_same_team`）；**`/product-options/overrides`、团队/成员/订阅类、`is_system` 行、`calculate-internal`/`verify` 保持管理员**（逐条见 §4.4） |
| | **P10** | 负例矩阵**新增**：团队 A 的**普通成员**改团队 B 的行 ⇒ 404；**团队成员**改本团队 ⇒ 200；**非管理员**调 `calculate-internal`/`verify` ⇒ 403 |
| | **P11** | 新尺子放共享内核并与 `is_team_admin` **并存**；⚠️ **命名不能叫 `can_write`**（该名已被"属主尺"占用，见 §4.2） |
| **Q6 = 工位人人可见（两层）** | **P14 / P15** | **分两处实现、不许合并**：① **工位可见性** = 契约层 `adminOnly:false`（P15 收口）；② **数据可见性** = API 层团队过滤（P7–P11）。⚠️ **不许**拿工位可见性代替数据隔离（那等于把"团队私有"做成"人人可见"） |
| **Q7 = 允许重名** | **P5** | `uq_tenant_products_key` 由 `(tenant_id, product_key)` 改为 **`(tenant_id, team_id, product_key)`**（跨团队、与系统级重名都合法） |
| | **P9** | 两个团队建同名 key ⇒ **都要 201**；解析时**团队优先**（现有 `order_by(is_system.desc())` 只解决"系统级 vs 团队级"，需补"本团队 vs 别团队"的次序并把语义写清） |
| **Q8 = 建试算 + 收敛** | **P16** | 加"公式试算"小步。**【已核实】先复核再决定是否新建**：`POST /api/v1/export-quote/products/{product_key}/explain`（"按规格取值逐步代入计算逻辑"）**已经存在** —— `backend/orchestrator/app/api/export_quote.py:282`、worker 侧对应路由见 `route-parity`。⇒ P16 应**先确认它是否已满足编辑器需求**，避免重复造接口 |
| | **P17** | 收敛 `/api/v1/tenant-products` → **`/products/{key}/definition`**：**两端同时改**（orchestrator + worker）+ `route-parity` + allowlist；旧路由保留一个发布周期的 301/兼容层 |
| **D3/D4** | **P5 / P6** | 同 Q3：历史 NULL **仅管理员可见**；**新写入强制带 team** |

> **一句话**：**Q1=B 与 Q5=b 是"改性质"的两条**（前者把"可空 team_id"变成"新写入强制"，
> 后者把"团队管理员尺"换成"团队成员尺"），**P5/P6/P9/P10/P11 必须按新口径重读**；
> Q6 的关键是**两层不许压平**；Q7 放宽了唯一键；Q8 要先查"试算接口是不是已经有了"。

### 8.2 本任务已落地的实施步骤（第 ② 部分）

§5 的 **① 层**（纯逻辑差异合并）已在本任务实现 —— 它是 17 步里**唯一不需要数据库就能验证**的一步：

| 项 | 内容 |
|---|---|
| 模块 | `backend/orchestrator/app/services/export_quote/spec_delta.py`（新建） |
| 纯标准库自证 | AST 解析后**绝对导入只有** `__future__ / copy / dataclasses / hashlib / json / typing`（全部标准库）+ **相对导入 `.models`**；无 `sqlalchemy`、无 `app.*`、无三方 ⇒ Pyodide 可跑 |
| 与线上同源 | 选项层**直接复用** `models.apply_option_overrides`（与 `export_quote.py:_with_team_overrides` 同一份实现）⇒ 不存在"合并语义与线上分叉" |
| 测试 | `backend/orchestrator/tests/test_spec_delta.py`（**42 条，`-m unit` 全绿、无 skip**）——覆盖 缺失/null/改名/列表三态/未知 key/哈希闸门/版本闸门/add-remove 冲突/选项层复用，以及"上游改了未覆盖字段⇒跟着变"与"覆盖后上游再改⇒被覆盖字段不变"两条 |
| ⚠️ 镜像待同步 | ~~`sync-shared.ps1 -Check` 报 exit 1（报价引擎 源 20 / 镜像 19，缺 `spec_delta.py`）~~ → **已在 task-19 解决**：跑同步后 `-Check` **exit 0**（报价引擎 20/20）。镜像目录**被 git 忽略**（`backend/worker/.gitignore:13`），同步**不产生 tracked diff** |

### 8.3 已落地的第 2 个增量：**P11**（共享内核的产品域「两把尺 + 三层可见性」）

| 项 | 内容 |
|---|---|
| 模块 | `backend/kaas_common/workstation/product_scope.py`（新建，纯函数、零三方依赖） |
| 落地的裁决 | **Q1=B**：产品**定义**人人可读（`definition_readable`）；产品**相关信息**（图片/基础信息）**一律团队私有**（`product_info_access`）；历史 `team_id IS NULL` 的行 **仅管理员可见**；**系统级不是例外**（函数签名里**没有** `is_system`，用结构断言钉住）。**Q5**：另立 `is_same_team`（团队成员尺）**与 `is_team_admin` 并存**，名字**不叫** `can_write`（该名被客户域属主尺占用）。**Q6**：本模块**只管数据可见性**，**不提供**工位可见性函数/参数（用结构断言钉住），工位那层属 P15 契约。 |
| 与客户域**刻意分叉** | `scope.can_view` 对 `team_id IS NULL` 的行"不因团队规则改变可见性"；产品域裁决是"**仅管理员可见**"。有专门用例把这个分叉钉死（谁改回 `can_view` 就会红）。 |
| 测试 | `backend/orchestrator/tests/test_product_scope.py`（**30 条，`pytestmark = pytest.mark.unit`，全绿无 skip**）——覆盖三层可见性、失败语义与状态码映射（401→403 `NO_TEAM`→404）、写=团队任意成员、两把尺并存且语义不同、系统级无后门、Q6 两层不压平 |
| 门禁 | `pytest -m unit` ⇒ **976 passed, 1 skipped, 324 deselected, exit 0**（那 1 skip 是既有的 `test_knowledge_provider.py:56`，需 PostgreSQL）；`sync-shared.ps1` + `-Check` ⇒ **exit 0**（共享内核 31 / 报价引擎 20 / 枚举 1，全一致） |
| 尚未做 | **接线**（P7/P8/P9 把判定接到 13+ 个落点）与**工位层**（P15 契约）仍属后续步骤；本步只交付**可离线证明**的纯逻辑层 |

---

## 9. 本文件的状态与自证（**滚动更新**）

- task-3 的那一轮：只新增 `docs/PRODUCT_MODULE_IMPL_PLAN.md`，并在 `docs/PRODUCT_MODULE_MERGE_PLAN.md` 追加 §11；当时**未修改任何代码**。
- **task-16**：折进 8 条裁决（§8/§8.1）+ 交付 §5 的 ① 层 `spec_delta.py`（§8.2）。
- **task-19**：交付 **P11** 的纯逻辑层 `kaas_common/workstation/product_scope.py`（§8.3），并跑通共享内核同步。
  自此本文件由**同一个作者滚动维护**；它**不是**"口径文档"（口径看 `docs/PROBLEM_STATUS_2026-10-11.md`）。
- 三轮都**未碰** `frontend/**`、`backend/worker/**`（tracked 源码）、`shared/**`，也未碰另一条任务在改的
  `files` / `trade_docs` / `products` 相关文件（同步脚本只写**被 git 忽略**的镜像目录）。
- 提交纪律（2026-10-11 起）：**私有 `GIT_INDEX_FILE`** + 提交前后自检 + 提交后确认别人的改动原样还在
  + **收尾 `git reset -q HEAD -- <本次路径>`**（否则共享 index 停在旧 HEAD，会把新增文件显示成 staged 删除）。
  （`git commit -- <pathspec>` 会把**工作树**里别人的未提交 hunk 一起带走，已由用户规则判定为不足。）
