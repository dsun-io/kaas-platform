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
| **P5** | 新迁移 **`202610110019`**（⚠️ 号已改：实测 `alembic heads` = `202610110018`，见 §8.1）。**已交付（§8.4）**：3 张表加 `team_id`（可空 —— "新写入强制、历史容忍 NULL" 由**写路径**强制，**不能**写 `NOT NULL`）、重建 `uq_file_primary` 含团队、`uq_tenant_products_key` 改按团队并折叠 NULL。**两处唯一键（`product_profiles` 主键、`uq_tenant_ws_product`）故意留给 P9**：它们的调用方用 `ON CONFLICT` 锁定了那几列，只改库不改代码会让 INSERT 直接报错（证据见 §8.4） | `backend/orchestrator/alembic/versions/202610110019_*.py`、`backend/orchestrator/app/db/models.py` | **离线 DDL**（已跑）：`alembic upgrade 202610110018:202610110019 --sql` + `downgrade 202610110019:202610110018 --sql` 逐条核对；`pytest -m unit` | `alembic downgrade 202610110019:202610110018`（离线可渲染；⚠️ 若库里已出现"同租户同 key、不同团队"的行，回滚会因唯一冲突失败 —— 如实记录） | P1、P2、Q3、Q4、D4 | ✅ 与 P3/P4 并行（文件不相交） |
| **P6** | 迁移语义测试。**已交付（§8.4）**：**DB-free 的离线 DDL 断言**（`tests/test_product_team_scope_migration.py`，**13 条 `-m unit`**）——程序化跑 `alembic upgrade/downgrade --sql`，逐条核对 DDL，并断言**"故意不做的必须仍然没做"**。**仍待**：需要真库的**回填语义**验证（本机无 Postgres，见 §6 前置 5）⇒ 由 CI `db-tests` 或装库后补 | `backend/orchestrator/tests/test_product_team_scope_migration.py` | `pytest -m unit`（已绿）；**DB 版验收信号（待）**：① 回填后 `product_profiles.team_id` = `updated_by` 所属团队；② 无法归因的行仍 NULL 且**行数一条不少**；③ 两团队同名 `product_key` 并存（须 P9 改完唯一键后才成立） | `git revert` | P5 | — |

### 阶段 3：R1 两端查询过滤

| 步 | 内容 | 文件范围 | 门禁 / 验收信号 | 回滚 | 依赖 | 并行 |
|---|---|---|---|---|---|---|
| **P7** | orchestrator 侧：`files.py` 的团队谓词。**已交付（§8.7 + §8.8）**：`product_profiles` 两条读路径 + **`file_objects` 全部落点**（含 `media_count`、`content`/`url`、`PATCH`/`DELETE`、`list_files`、`list_doc_files`、`attach_doc_file`、`_fetch_current`）。**仍待**：`trade_docs.py`（⚠️*正被另一条任务改*） | `backend/orchestrator/app/api/files.py`、`backend/orchestrator/app/api/trade_docs.py` ⚠️*正在被另一条任务改* | `pytest -m unit`（已绿 **1047**）；`route-parity`（已绿）；**验收信号**：团队 A 的 token 调 `GET /file-objects/{团队B的文件id}/content` → **404 `FILE_NOT_FOUND`**（§8.8 已在 HTTP 层证）；`PATCH`/`DELETE` 同 → 404 | `git revert` | P5、P6 | ✅ 与 P8 并行开发，但**必须同批验收** |
| **P8** | worker 侧：`ws_files.py` 同构。**已交付（§8.8）**：`product_profiles` 两条 + `file_objects` 全部落点。**仍待**：`main.py:3691`（product_profiles）与**装配层 `resolve_photo_refs`**（无 auth 上下文、调用方在 `main.py`，⚠️*未授权*）；`main.py` 干净后补 | `backend/worker/src/ws_files.py`、`backend/worker/src/main.py` ⚠️*正在被另一条任务改* | worker `pytest`（已绿 **231**）；**验收信号**：与 P7 同一组用例在 worker 上同样 404（两端同构 ✓，§8.8 已证） | `git revert` | P5、P6 | ✅ 与 P7 并行 |
| **P9** | 产品定义/矩阵隔离：`tenant_products.py`、`workstation_products.py`、worker `ws_products.py`；唯一键断言更新。**唯一键部分已交付（§8.6）**：唯一键按团队收敛 + **两端 `ON CONFLICT` 与断言同批改**；"跨团队改/删 → 404；系统级 → 403"的**越权面**仍待（属 P7/P8 的读路径过滤） | 上述 3 文件 + `backend/worker/tests/test_ws_products_seals.py` | `pytest -m unit`（已绿 **1017**）+ worker `pytest`（已绿 **217**）；**验收信号**：跨团队改/删 → 404；系统级 → 403；**两团队各建同名 key → 均 201**（唯一键已允许；行为验证见 §8.6 的验收 SQL）；⚠️ **这些测试断言了 SQL 字面量**（`test_ws_products_seals.py`），改 SQL 必须同步改断言（**本轮已同步**） | `git revert` | P5、P6、P7 | — |
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
| **P16** | 可视化编辑器（**分 2–3 小步**）：① `numeric_inputs`/`variants`/`derived` → ② `columns`/`invariants`/`space_deduction` → ③ `params`/`notes`/`constants` + 公式试算。⚠️ **Q8 的"建试算接口"已复核完毕（§8.5）：不新建接口，改为给现有 `/explain` 加"草稿定义"入参 + 汇总键** | `frontend/src/app/(app)/products/**`（新组件）+ **改造** `app/api/export_quote.py` 的 `/explain`（**不是**新接口） | 前端 `typecheck`/`lint`/`test` + 构建；后端 `pytest -m unit`；**验收信号**：逐字段 round-trip（表单 → API → DB → 回显）与 `ProductSpec` 逐字段相等；**且草稿（未保存）能试算**（§8.5 的 6 条缺口逐条关闭）；⚠️ **不许按 `Axis` 设计**（三产品 `axes=[]`，`products/chain_link.py:76`、`field_fence.py:80`、`deer_net.py:83`） | 每小步 `git revert` | P13、P14、Q8（已复核） | 三个小步之间**串行** |

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

### 8.4 已落地的第 3 个增量：**P5 + P6（离线部分）** —— 迁移 `202610110019`

**交付**：`backend/orchestrator/alembic/versions/202610110019_product_team_scope.py`（新迁移）
+ `backend/orchestrator/tests/test_product_team_scope_migration.py`（**13 条 `-m unit`，DB-free**）。

**离线证明**（本机无 Postgres，走 task-5 验过的 L0 通路）：
`alembic upgrade 202610110018:202610110019 --sql` 与 `downgrade 202610110019:202610110018 --sql` **都 exit 0**，
渲染出的 DDL 已逐条核对：

| 承诺 | DDL 实际渲染 | 核对 |
|---|---|---|
| 3 张表加 `team_id` 且**可空** | `ALTER TABLE {product_profiles,tenant_products,tenant_workstation_products} ADD COLUMN team_id BIGINT;`（无 `NOT NULL`） | ✅ 裁决"历史容忍 NULL"要求可空 |
| 外键指向 `teams` | `ADD CONSTRAINT fk_*_team FOREIGN KEY(team_id) REFERENCES teams (id) ON DELETE SET NULL` | ✅ 与迁移 001 同口径 |
| `uq_tenant_products_key` 改按团队（Q7 允许重名） | `CREATE UNIQUE INDEX uq_tenant_products_key ON tenant_products (tenant_id, COALESCE(team_id, 0), product_key)` | ✅ |
| `uq_file_primary` 重建含团队（Q1=B：两团队各有主图） | `CREATE UNIQUE INDEX uq_file_primary ON file_objects (tenant_id, COALESCE(team_id, 0), owner_type, owner_id, kind) WHERE is_primary AND is_current` | ✅ |
| 迁移图 | `alembic heads` = **`202610110019 (head)`**，`alembic branches` 空（线性） | ✅ |

**两个关键设计点（都写进迁移 docstring + 有用例钉住）**：

1. **`team_id` 一律可空，不做 `NOT NULL`**：裁决是"**新写入**强制、**历史容忍 NULL**"，
   两者同时成立只能靠**写路径**强制（P7/P9 用 `product_scope` 的判定 + 403 `NO_TEAM`）；
   库上写 `NOT NULL` 会让历史行违反约束（或被迫给历史行编一个 team，而 D3/D4 **不允许**编）。
2. **用 `COALESCE(team_id, 0)` 表达"至多一行无归属"**：Postgres 认为 `NULL` 互不相等，
   把**可空列**直接放进唯一键 ⇒ 同一租户能有**多行** NULL ⇒ "一个产品多行基础信息"。
   折叠成 0 才让这条约束可表达。用例里正/反两面都断言了（含"不许出现裸 `team_id` 的唯一键"）。

**⚠️ 故意留给 P9 的两处（附证据）—— 只改库不改代码会直接崩**：

| 约束 | 依赖它的代码 | 为什么不能现在改 |
|---|---|---|
| `product_profiles` 主键 `(tenant_id, product_key)` | `app/api/files.py:283`、`backend/worker/src/ws_files.py:319`（都是 `ON CONFLICT (tenant_id, product_key)`） | 换掉唯一键后这两条 INSERT 报 `there is no unique or exclusion constraint matching the ON CONFLICT specification` ⇒ **两端保存产品基础信息全挂**；且 `files.py` 正被另一条任务改、worker 在本任务禁碰 |
| `uq_tenant_ws_product` | `backend/worker/src/ws_products.py:347`（`ON CONFLICT (tenant_id, workstation, product_key)`）、`backend/worker/tests/test_ws_products_seals.py:149`（断言该字面量） | 同上（worker 禁碰） |

⇒ **如实记录的后果**：在 P9 完成之前，**两个团队仍不能各自持有同一 `product_key` 的基础信息**
（Q1=B 的"每团队一份"还差这一步）；本轮只把**列 + 索引 + 两处可安全切换的唯一键**落地。
**P9 的必做清单**（P9 与两端代码同批）：① 换 `product_profiles` 主键 + 同步 `put_profile` 的冲突目标；
② 换 `uq_tenant_ws_product` + 同步 worker 的 `ON CONFLICT` 与那条测试断言。

**给 P13 的硬提醒**：`TenantProductLoader._fetch_tenant_product` 按 `(tenant_id, product_key, is_active)`
查且用 `scalar_one_or_none()`（`services/export_quote/tenant_products.py:87-98`）。
本轮放宽唯一键后，同租户同 key 的多团队行会让它抛 `MultipleResultsFound` —— 它现在**没有调用者**（已核实），
**接线时必须先补 team 过滤**，否则一接就炸。

### 8.5 已落地的第 4 个增量：**P16 复核 + P12 ② 层契约**（两项都零冲突、可离线证明）

#### A. `/explain` 够不够做编辑器的公式试算 ⇒ **不够**（但**不该新建接口**）

**它现在返回什么（实测，权威 JSON 键；不是靠子串）**
一次**真实只读调用**（直接调 `explain_product`，该端点**不需要 DB**：定义来自代码注册表
`_get_product_or_404 → get_product`，签名里根本没有 `db` 会话）：

| 层级 | JSON 键 | 说明 |
|---|---|---|
| 顶层（固定 7 个） | `product_key` / `product_name` / `spec` / `total` / `space_deduction` / `space_deduction_ratio` / `steps` | `spec` 是**解析后的作用域**（实测 14 键：数值入参被串化 `"2.0"`，并含变体选项字段 `code`/`raw_price`/`zinc_g_m2`/`wave_factor`） |
| 顶层（条件 2 个） | `price_metrics_omitted`（5 个价格指标名）/ `price_hint` | 只在未显式请求价格指标时出现 |
| `steps[i]`（固定 8 个） | `code` / `label` / `stage` / `expr` / `unit` / `decimals` / `note` / `value` | `stage` ∈ `derived`\|`piece`\|`order`；实测 field_fence：14 步（derived 10 + order 4），**0 步求值失败** |
| `steps[i]`（失败时） | **`error`** 取代 `value` | `formulas.py:334-339`：公式挂了就回 `error`，但**整个响应仍 200** |

入参 `ExplainIn`（`app/api/export_quote.py`）：`spec`（**取值**字典）/ `total` / `constants` / `metrics`。
`steps` 由 `worked_example(spec, scope, only)` 产出（`services/export_quote/formulas.py:313-359`）。

**编辑器需要什么**（按 P16 目标反推）：改一个数值/公式后**即时**看到"取值代入 + 结果" ——
且要作用于**正在编辑的草稿定义**，还要能看出**公式是否写坏**、**是否违反 `invariants`**。

**差什么（6 条，逐条带证据）**

| # | 缺口 | 证据 |
|---|---|---|
| 1 | **入参只有"取值"，没有"定义"** ⇒ **草稿无法试算**（决定性缺口） | `ExplainIn` 无 spec 定义字段；定义来自 `_get_product_or_404(product_key)` |
| 2 | **只取系统级注册表** ⇒ 团队覆盖/差异**不参与**，对已定制的团队等于**答非所问** | `_get_product_or_404` → `get_product`（代码注册表）；端点**无 db 参数** ⇒ 拿不到 `tenant_products`/团队差异 |
| 3 | **`invariants` 不求值** | `worked_example` 只走 `derived`+`piece_metrics`+`order_metrics`（`formulas.py:325-329`）；约束校验在 `verify.py:184 verify_invariants`，但它吃 `QuoteResult`（完整价链）且 `/verify` 是**管理员**端点 + 需要 DB |
| 4 | 缺**静态检查**（引用不存在的量、循环依赖）——只能在求值后以每步 `error` 暴露，且必须先给一组完整取值 | `expr.py:153` `未定义变量: {name}`；无任何 `validate_*`/静态校验入口（已检索） |
| 5 | **失败不体现在状态码**：200 + per-step `error`；且**没有顶层汇总**（`ok`/`errors`） | `formulas.py:334-339`；顶层只有上面 9 个键 |
| 6 | 价格类指标**有意**被剔除（`price_metrics_omitted` + `price_hint`）⇒ 编辑器若想试算价格需走 `/calculate`（客户视图）或 `/calculate-internal`（管理员+DB） | `export_quote.py:378-404`；这是**设计**不是缺陷 |

**结论：不够**（作为"编辑器公式试算"的完整通路），但**基础很好 ⇒ 不要新建重复接口**。
P16 应改为"**改造 + 接线**"：

1. **给现有 `/explain` 加一个可选入参 `spec_override`（草稿定义）**，语义："用这份**未保存**的定义代替注册表里的定义试算，只在本次请求内生效、**不落库**"。
   - **向后兼容、零风险**：可选字段 ⇒ 既有请求不变；而且**当前前端与 e2e 对 `explain` 零命中**（已用检索工具核实）⇒ **没有既有调用方**。
   - 解析草稿必须走**严格**路径（照 `spec_delta` 的口径：未知字段/结构不对要**报错**，不许静默取默认）。
2. **补两个加性键**（不改既有键）：`ok: bool` + `errors: [{code, error, expr}]`；`warnings: [...]` 沿用 `verify.py:89` 的既有契约。
3. **约束校验**别在 `/explain` 里重写：把 `verify_invariants`（`verify.py:184`）**抽出一个只吃 spec + scope 的纯函数**再复用（后续步骤）。
4. **不要**新增 `/explain-draft` 之类并行接口 —— 会变成"两套解释器"。

#### B. `remove` 指向不存在条目 ⇒ 上层应当 **200 + `warnings[]`**（建议），**不是**拒绝、**不是**静默

**建议与理由**（契约已用 15 条测试钉住：`tests/test_spec_delta_warning_contract.py`）

1. **目标状态已达成**（该条目本来就没被覆盖）⇒ 属**幂等成功**；用 4xx 拒绝会逼用户去"修"一条其实已满足的差异。
2. **但绝不能静默**：miss 通常意味着**上游改名/删除** —— 用户以为在覆盖 `X`，而上游可能已改成 `Y` 并**继续生效** ⇒ "我定制过"是**错觉**，必须提示人工复核。
3. **沿用仓库既有口径**：`verify.py:89` 的 `to_dict()` 就是 `{"ok":…, "warnings":[…]}`；`rates.py:121 RateSet.warnings()`、`importers.py:179`、`pricing.py:414` 都是"警告不阻断" ⇒ 不发明新词汇。

**必须与"真非法"分开**（这是最容易做错的一点）：`remove` miss ⇒ **200 + warning**；
未知字段 / 未知 `spec_version` / `base_spec_hash` 不匹配 / 结构矛盾 ⇒ **422**。
把后者也降级成 warning，等于让"公式被静默忽略"重新长回来。

**⚠️ 本轮顺带发现的缺口（待办，未改引擎：写入范围不含引擎包）**：
`notes` / `hs_codes` 是**标量列表**（元素是字符串），而 `item_identity()` 要求条目是带 `key`/`name` 的对象
⇒ 对它们做 `remove`/`add` 会**抛 `SpecDeltaError`**（"列表条目必须是对象（dict），实际是 str"），
而不是像 dict 列表那样给 warning。**不是静默**（它报错了），但报错文案没说清"这两个字段不支持按条增删" ⇒ **体验缺口**。
两种修法：① 标量列表的身份 = 值本身；② 明确把这两个字段从 `add`/`remove` 排除并在文案里说明。
**注意缺口范围**：`lists.notes` 的**整体替换**（含 `[]` 清空 / `null` 取消）**完全可用** ✓（已用例覆盖）。

**"上层还没实现"的现状**：`app/api` 里还没有"存差异"的端点 ⇒ 本任务**只钉契约 + 记录结论，不改上层**。

### 8.6 已落地的第 5 个增量：**P9** —— 唯一键按团队收敛 + 两端 `ON CONFLICT` 同批

**这是什么**：task-20 留白的那两处（`product_profiles` 主键、`uq_tenant_ws_product`）。
它们是 **Q1=B 的最后一块** —— 改完才谈得上"两个团队各自持有同一 `product_key` 的基础信息"。

**迁移选择：就地修订 019（不新增 020）**，依据（三条，都可复查）：
1. **没有任何 workflow/脚本会跑 `alembic upgrade`** —— `.github/workflows/*.yml` 全仓检索 **0 命中** `alembic`
   （`deploy.yml` 只部署 Worker/静态资源、只监听 push main）；仓库脚本里也没有；
2. 本地**无 Postgres** ⇒ 不可能有库把 019 记进 `alembic_version`；
3. 019 提交于 **2026-10-12 01:59:37**，距本次修订十余分钟。
⇒ 若拆成 020，会出现"019 先把唯一键留成旧形态、020 立刻改掉"的中间态，历史更难读。

⚠️ **前提条件（部署前必须确认一次）**：任何要跑的库执行
`SELECT version_num FROM alembic_version;` **不得已经是 `202610110019`**。
若已是（说明该库跑过 019 首版）⇒ **必须改用增量迁移 020**，其 DDL 备忘如下：

```sql
-- 020（仅在"某库已应用过 019 首版"时才需要；正常情况不要建）
DROP INDEX uq_tenant_ws_product;
CREATE UNIQUE INDEX uq_tenant_ws_product ON tenant_workstation_products
    (tenant_id, COALESCE(team_id, 0), workstation, product_key);
ALTER TABLE product_profiles DROP CONSTRAINT product_profiles_pkey;
CREATE UNIQUE INDEX uq_product_profiles_scope ON product_profiles
    (tenant_id, COALESCE(team_id, 0), product_key);
-- downgrade：反向还原 007 的 (tenant_id, workstation, product_key) 与 016 的主键
```
（`revision="202610110020"`, `down_revision="202610110019"`；两端 `ON CONFLICT` 目标已经是新形态，无需再改。）

**改了哪 5 个文件 / 各自为什么**

| 文件 | 改动 | 为什么必须同批 |
|---|---|---|
| `alembic/versions/202610110019_*.py` | 主键 → `uq_product_profiles_scope`；`uq_tenant_ws_product` 改按团队（含 downgrade 还原） | 库侧的"真相" |
| `app/api/files.py` | `put_profile` 写入 `team_id` + 冲突目标换新形态 | 只改库不改它 ⇒ INSERT 报"no unique or exclusion constraint matching" |
| `backend/worker/src/ws_files.py` | 同上（worker 侧） | 两端同构，缺一边就是半边坏 |
| `backend/worker/src/ws_products.py` | `set_workstation_product` 写入 `team_id` + 冲突目标换新形态 | 同上 |
| `backend/worker/tests/test_ws_products_seals.py` | 那条**断言 SQL 字面量**的用例同步 | 它是"同批"的可见信号：漏改就红 |

**`ON CONFLICT` 的写法（照 PG16 官方文法，已取证）**
`conflict_target := ( { index_column_name | ( index_expression ) } [, …] )`
⇒ 表达式**必须加括号**：`ON CONFLICT (tenant_id, (COALESCE(team_id, 0)), product_key)`。
少了那层括号 ⇒ 推断失败 ⇒ 运行时报错。**离线**由 §8.6 的跨文件用例把"索引键列表"与
"三处冲突目标"逐元素比对（含"旧形态已彻底消失"），这是本步最关键的自动化守卫。

**写入必须带 team（否则收窄唯一键等于没收）**：`team_key = COALESCE(team_id, 0)` ⇒
若 INSERT 不写 `team_id`，所有团队都落进 `team_key=0` 桶，**照样互撞**。三条写路径都已补 `team_id`。

**⚠️ 诚实交代：Q1=B 的验收点只做到了"结构性证明"，行为证明仍需真库**
- **已证（离线、可复跑）**：① DDL 里 `product_profiles` 已无 `(tenant_id, product_key)` 主键，
  唯一性 = `(tenant_id, COALESCE(team_id,0), product_key)`；② 三条写路径都写 `team_id`；
  ③ 三处 `ON CONFLICT` 目标与索引表达式逐元素一致；④ 旧形态零残留；
  ⑤ `upgrade`/`downgrade` 离线渲染 `--sql` 均 exit 0、`heads` 单一。
- **未证（需要 Postgres）**："真的能插入两行"。**本机没有库** ⇒ 我把验收 SQL 放在这里，交给有库的环境/CI：

```sql
-- 验收：两团队各持同一 product_key 的基础信息（Q1=B）
INSERT INTO product_profiles (tenant_id, team_id, product_key, info) VALUES ('default', 1, 'field_fence', '{}'::jsonb);  -- 成功
INSERT INTO product_profiles (tenant_id, team_id, product_key, info) VALUES ('default', 2, 'field_fence', '{}'::jsonb);  -- 必须成功（019 之前会撞主键）
-- 同团队同 key 第二次必须仍然被挡（唯一性没被放宽成"人人可重复"）
INSERT INTO product_profiles (tenant_id, team_id, product_key, info) VALUES ('default', 1, 'field_fence', '{}'::jsonb);  -- 期望 23505
-- 无归属（历史）行：至多一行
INSERT INTO product_profiles (tenant_id, team_id, product_key, info) VALUES ('default', NULL, 'chain_link', '{}'::jsonb);  -- 成功
INSERT INTO product_profiles (tenant_id, team_id, product_key, info) VALUES ('default', NULL, 'chain_link', '{}'::jsonb);  -- 期望 23505（COALESCE 折叠成 0）
```
**为什么不顺手写一个 `db`-marked 测试**：本机无库 ⇒ 我**无法真跑它**，写下去就是"没验证过的测试"，
在 CI 里红了我也不会知道 —— 风险大于价值。因此改为把可复制的验收 SQL 写进文档（属 §1.4 的 L2 通路）。

**测试工程上的一条教训（值得记）**：跨文件一致性用例的第一版**用正则扫原始源码**，
对 `ws_products.py` 的两条断言**全红** —— 因为仓库 SQL 普遍写成**相邻字符串字面量隐式拼接**
（`"INSERT INTO x"` 换行 `" (a, b)"`），原始文本里夹着引号与换行 ⇒ 任何"整串去 in 一下"都是**假阴性**。
改用 `ast.parse`（它会把隐式拼接**合并成一个 Constant**）后 26 条全绿。
⇒ **凡是要从源码里取 SQL/字面量做断言，先过 AST，别扫文本。**

### 8.7 已落地的第 6 个增量：**产品基础信息的读路径团队谓词**（Q6 后半句落地）

**这是什么**：P9 让**写入**带上了 `team_id`，但**读取**还是 `WHERE tenant_id AND product_key`
⇒ **别家团队的"产品基础信息"读得到** ✗。Q6 裁决原话"**工位人人可见，但用户创建的业务数据
仅团队内部可见**"⇒ 本次把后半句落到读路径（**已决策项的直接落地**，不是新决策）。

**四条语义各用什么判断、依据哪条裁决**

| 情形 | 判断 | 依据 | 期望 |
|---|---|---|---|
| 本团队行 | `product_info_access(role, viewer_team_id, row_team_id)` → `allowed` | Q1=B + Q6 | **200** |
| 别团队行 | 同上 → `other_team` | Q6；失败语义照 §1.5 | **404** |
| 历史 `team_id IS NULL` | 同上 → `legacy_unattributed`（非管理员） | **D3/D4** | **404** |
| 访问者没有团队 | 同上 → `no_team` | §1.5（403 在 404 之前） | **403 `NO_TEAM`** |
| 系统级**定义** | **不经过**上面的判定（走代码注册表 `product_keys()`/`get_product`） | Q1=B 第一句 | **仍人人可读** |

**复用同一把尺（不造第二套）**：判定直接调 `kaas_common/workstation/product_scope.py` 的
`product_info_access()`（task-19 交付）—— **没有**复用 `is_team_admin` 当成员尺，**没有**新起
`can_write`，端点里也**没有**第二份 `if team_id == ...` 的判断。管理员分支同样走它内部的
`is_admin_role`（与 P11 一致）。

**改了哪两处**
| 位置 | 改动 |
|---|---|
| `files.py` `get_profile` | SELECT 多取 `team_id`；行存在时调 `_require_profile_visible()` ⇒ 不可见抛 403/404 |
| `files.py` `list_products` | 基础信息查询改走 `_visible_profiles_query()`：管理员不加谓词（含历史 NULL），其余 `AND team_id = :team` |

**⚠️ 两处如实标注（没做/没证）**
1. **`list_products` 的 `media_count` 仍是全租户计数**（`files.py` 的 `file_objects` 聚合）——
   它也是"产品相关信息"，属 **P7 的 13 个落点**之一（`file_objects`），**本任务写入范围是
   `product_profiles`**，故**没动**（避免与另一条任务在同一文件里抢改）。
   有一条用例**钉住"当前还没有团队谓词"这个事实**，防止被误读成"已经隔离好了"。
2. **worker 侧同类读路径仍未做**（本任务写入范围不含 worker）：实测仍有 3 处无团队谓词 ——
   `backend/worker/src/ws_files.py:270`（列表）、`:294`（单条）、`backend/worker/src/main.py:3691`；
   另有 `app/api/trade_docs.py:829`（⚠️ 正被另一条任务改）⇒ 都列进 **P8/P7** 的剩余清单。

**为什么"别团队 ⇒ 404"**（与 lead 的四条语义一致）：404 与"历史 NULL 非管理员"用**同一个错误码**
`PROFILE_NOT_FOUND` ⇒ 这两种拒绝原因对外**不可区分**，不额外泄露"别家有没有存过这一行"。
（仅有的一点信息差是"有行但不可见(404)" vs "根本没有行(200 `{}`)"：`product_key` 本身是公开的
定义标识，所以这不泄露"产品是否存在"，只泄露"别家是否存过基础信息"。若要求**严格零信息差**，
可改为"查询直接按团队过滤 ⇒ 两者都 200 `{}`"；此处按裁决选了 404，**记下这个取舍不代决**。）

**测试**（`tests/test_product_profiles_team_scope.py`，**15 条**，`pytestmark=unit`，**不需要 Postgres**）
覆盖：本团队 200 / **别团队 404 且响应体一个字节不漏** / 别团队与历史 NULL **对外不可区分** /
**换团队身份能读到自己的行（阳性对照，证明 404 不是"路径写错"）** / 历史 NULL 普通成员 404、管理员 200 /
管理员可读别团队 / 无团队 403 `NO_TEAM` / **列表 SQL 真的带上谓词（含参数）** / 管理员不加谓词 /
无团队时谓词为 NULL / **无团队仍能看到产品定义（Q6 两层不许压平）** / media_count 现状。

**测试工程上又踩了两个坑（记下来省下一次）**：
1. **覆盖 `get_db_session` 必须给 async 生成器函数本身**；给"返回 async 生成器的普通 lambda"
   会拿到 `async_generator` 对象 ⇒ 端点上 `.execute()` 直接 AttributeError（15 条一起红）。
2. **不要用 monkeypatch 换 `AuthContextMiddleware.dispatch` 来注入身份** —— 实测同进程里会
   **错位一拍**（某个用例拿到上一个用例的身份，表现为"单独跑绿、一起跑红"）。
   改为覆盖 FastAPI 依赖 `get_auth_context`（端点就是 `Depends(get_auth_context)`）⇒ 确定性。
3. 断言 SQL 时**必须用词边界**：`"team_id" in sql` 会被 **`tenant_id`** 误命中（子串）
   ⇒ 用 `re.search(r"\bteam_id\b", …)`。

**门禁**：orchestrator `pytest -m unit` ⇒ **1032 passed, 1 skipped, 324 deselected, exit 0**；
worker `pytest` ⇒ **217 passed**（本轮未改 worker，跑一遍证明无连带）；`route-parity` ⇒ PASS；
`sync-shared -Check` ⇒ exit 0（本轮未改 `kaas_common`）。

### 8.8 已落地的第 7 个增量：**file_objects 落点**（P7 剩余 + P8 worker 同构）

**范围**：`files.py` 的 `file_objects` 读写点 + worker `ws_files.py` 同构（`main.py` 未授权 ⇒ 跳过）。

**做法：一个行级谓词，两端各一份同名实现（都走共享内核的角色尺）**

| 端 | 辅助函数 | 说明 |
|---|---|---|
| orchestrator | `_team_scope(auth, col=…)` → `(" AND <col>=:team", {"team": …})` | 管理员 ⇒ `("", {})`；有团队 ⇒ 谓词；**无团队 ⇒ 403 `NO_TEAM`** |
| orchestrator | `_team_scope_soft(auth, col=…)` | **不抛错**版，**只给"公开层+私有层混在一起"的端点**（产品列表） |
| worker | `_team_scope(user, next_index, col=…)` / `_team_scope_soft(…)` | asyncpg **位置占位符**：约定"片段用 `$next_index`、参数追加到列表末尾"，调用方先算 `next_index = len(params)+1` |

**⚠️ 一个当场发现并修掉的设计错误（值得记）**：`list_products` 一份响应里同时有
**产品定义**（人人可读）与**基础信息/图片计数**（仅团队内可见）。第一版对"无团队"统一
**403** ⇒ 连**定义**也被挡掉，**把 Q6 的两层压平了** ✗（两条既有用例立刻变红，正是它们的价值）。
⇒ 该端点改用 `_team_scope_soft`：无团队时谓词为 `= NULL`（恒不成立）⇒ **私有部分为空、定义照旧返回** ✓。

**改了哪些落点**（两端同构）

| 落点 | 处理 |
|---|---|
| `_fetch_current` / `_current_file`（版本化取"当前件"） | 加谓词（**只在本团队内找当前件**，别团队的不会被顶掉） |
| 产品列表的 `media_count` 聚合 | 加谓词（**soft**：端点混两层） |
| `GET /products/{key}/media` | 加谓词 |
| `PATCH /file-objects/{id}`（读 + 改名/设主图/排序 4 条 UPDATE） | 读加谓词 ⇒ 别团队 404；**每条写也加谓词**（别团队改不动、也 404） |
| `DELETE /file-objects/{id}`（下线） | 加谓词（影响 0 行 ⇒ 404） |
| `GET /file-objects/{id}/content`、`/url` | 加谓词 |
| `GET /file-objects`（列表） | 加谓词 |
| `GET /trade-docs/{id}/files`（JOIN `f`） | 加谓词（`f.team_id` 显式限定列） |
| `POST /trade-docs/{id}/files`（挂件前的文件读取） | 加谓词 |
| 产品基础信息两条（worker `:270`/`:294`） | 列表用 soft 谓词；**单条**按 orchestrator 同法"取回后判可见性" ⇒ 别团队/历史 NULL ⇒ **404**、无团队 ⇒ **403** |
| 上传 INSERT（两端） | 本来就已经写 `team_id` ✓（审计现在会强制这一点） |

**四项语义**（与 §8.7 一致，同一把尺）：本团队 ⇒ 200/204；**别团队 ⇒ 404**；
历史 `team_id IS NULL` ⇒ **仅管理员**（非管理员 404）；无团队 ⇒ **403 `NO_TEAM`**。
行级端点用"谓词过滤 ⇒ 查不到 ⇒ 404"，因此**别团队与不存在对外完全同形**（零存在性泄露 ✓）。

**测试**（两端都**真跑**，各含**阳性对照**）

| 端 | 文件 | 条数 | 内容 |
|---|---|---|---|
| orchestrator | `tests/test_files_team_scope.py`（新） | **14** | HTTP 层：本团队 200/204、**别团队 404（content/patch/delete）**、**阳性对照**（换本团队身份就可见）、历史 NULL 成员 404 / 管理员可见、无团队 403、列表谓词（含参数）；**静态审计**：`files.py` 每处 `file_objects` 落点必须带谓词、**写入必须带 `team_id`**（带"审计本身有效"的阳性对照） |
| worker | `tests/test_ws_files_team_scope.py`（新） | **14** | 直调端点：基础信息四条语义 + 阳性对照 + 行不存在仍 200 `{}`；read/retire 谓词与参数、管理员不加谓词、无团队 403；**静态审计**（同规则）+ "已知缺口必须留注释"用例 |
| 既有用例适配 | `tests/test_ws_files_profile_shape.py` | — | 假 user/假行补 `team_id`（这些用例考的是 `info` 的形状，不是权限）；**意图不变** |

**⚠️ 如实标注的缺口（本轮没做）**
1. **`resolve_photo_refs`（worker，装配层）没有 auth 上下文** —— 调用方在 `main.get_trade_doc_render_data`
   （**`main.py` 未授权：正被另一条任务改**）。硬加谓词会 `NameError` ⇒ **已回退并在源码里留注释**，列入待办。
   *这条是"先写错 → worker 门禁抓到（4 条红）→ 再回退"的，说明测试网有效。*
2. **`main.py:3691`**（worker 的另一处 `product_profiles` 读）—— 同上，未授权。
3. **`app/api/trade_docs.py:829`** —— 他人文件在飞，未动。

**门禁（完整摘要）**：orchestrator `pytest -m unit` ⇒ **1047 passed, 1 skipped, 324 deselected, exit 0**；
worker `pytest` ⇒ **231 passed, exit 0**；`route-parity` ⇒ PASS；`sync-shared -Check` ⇒ exit 0（本轮未改 `kaas_common`）。

**测试工程上又踩两个坑**
1. **静态审计第一版按"字符串常量"扫** ⇒ 本文件的谓词是**拼在调用处**的
   （`text("… WHERE x=:v" f"{team_sql}")` / 先 `sql += _frag` 再 `text(sql)`）⇒ 常量里看不到谓词，
   **全部假阳性**。改成**行窗口扫描**（看落点后 14 行，等价于人肉复核）才对。
2. **假库要"按谓词过滤"**：让假库按 `params["team"]` 决定那行是否"存在"，404 才是**真的被谓词挡掉**
   （否则只测到"路径对不对"，测不到隔离）—— 这也是阳性对照能成立的前提。

### 8.9 已落地的第 8 个增量：**P16 改造第一步** —— `/explain` 的草稿试算（`spec_override`）+ 汇总键

**依据**：§8.5（task-21 A）的结论 —— **不新建接口**，改造现有 `/explain`。做完的是**决定性缺口之一**：
"入参只有取值、没有定义 ⇒ 草稿根本无法试算"。

**改了什么**

| 项 | 内容 |
|---|---|
| 新入参 | `ExplainIn.spec_override: Optional[dict]`（**草稿定义**）：用这份**未保存**的 ProductSpec 代替注册表定义试算，**只本次请求生效、不落库** |
| 新引擎模块 | `services/export_quote/spec_override.py`（纯标准库：绝对导入只有 `__future__/dataclasses/typing`） |
| 新键 | `ok: bool`（本次试算有没有坏）、`errors: [{code, error, expr}]`、`warnings: [str]` |
| 兼容性 | 老键（`product_key`/`product_name`/`spec`/`total`/`space_deduction`/`space_deduction_ratio`/`steps` [+`price_metrics_omitted`/`price_hint`]）**一个不改、不改名**；`steps[i]` 的 8 个键也不动 |

**草稿解析为什么单独一层（`spec_override.py`）**：`spec_from_dict` 是**宽松构造**（`tenant_products.py:19-44`），
三处静默 —— 缺字段取默认、**顶层未知字段被忽略**、列表 `null` 与缺失等价。
编辑器传来的是"人正在敲的半成品"⇒ 静默会把"打错字段名"变成"一份看起来正常的试算结果"。
本层契约：**结构错 ⇒ 422**（未知字段 / `null` / 类型不对 / `key` 与路径不符 / 嵌套不符）；
**合法但缺字段 ⇒ 允许**，但把**被默认掉的字段名**放进 `warnings` **如实回传**（不静默）。

**⚠️ 本轮查出的一个真问题（已修，且留了兜底）**：`spec_from_dict` **静默丢弃 3 个字段** ——
`numeric_inputs` / `piece_inputs` / `params`（实测它只覆盖 22 个键）。
草稿里写了数值入参，构造出来却是空的 ⇒ 公式报"未定义变量"。
⇒ `spec_override` 手动带上这 3 个字段（`_CARRIED_MANUALLY`），并做**兜底检查**
（提供了的字段必须真的进了 spec，否则抛内部错误）—— 防止将来又吞字段而无人察觉。

**`ok`/`errors` 的一个关键选择**：先算**全部**步骤再过滤 `steps`。
`metrics` 只影响**返回哪些步骤**，而 `ok`/`errors` 覆盖**所有**步骤 ——
否则"只看过滤后剩下的"会得出"没问题"的错觉（有用例钉住）。

**测试**：`tests/test_explain_spec_override.py`（**21 条 `-m unit`，全离线**：该端点不需要 DB/前端）——
草稿正常 / 8 类非法草稿各自 422 且 code 精确 / 坏公式 ⇒ **200 但 `ok=false` + `errors` 非空**（含语法坏、引用不存在的量）/
**老请求逐键不变**（顶层键集 + `steps` 键集 + 与直接调引擎的结果一致）/ `errors` 不被 `metrics` 过滤影响 /
**未注册的 key 带草稿能试算、不带草稿则 404**（新团队自建 key 的前置）。

**⚠️ 三项明确留待（本轮没做）**
1. **团队覆盖那一半**（§8.5 A 的第 2 条缺口："只取系统级注册表 ⇒ 团队覆盖不参与"）：需要 **db 会话** ⇒
   本任务（离线要求 + 不改端点签名以保零影响）**有意不做**；有用例**钉住"端点上仍没有 db 依赖"**，
   接进来时会变红以提醒同步文档。
2. **worker 侧未同构**：worker **也有** `/explain`（`ws_quote_ext.py:181` + 自己的 `_ExplainIn`，
   注释写着"与 orchestrator 逐字段一致"）⚠️ —— 但 `worker/src/**` 本任务**不授权** ⇒
   **worker 的 explain 目前不接受 `spec_override`、也没有 `ok/errors/warnings`**。
   两端**语义源已共享**（解析器在引擎包里、镜像已同步 21 文件 ✓），**只差接线**：
   照 `export_quote.py` 加字段 + 3 键即可（建议下一个授权 worker 的任务做）。
3. **编辑器侧**（前端）接线 —— 属 P16 后续小步。

**门禁**：orchestrator `pytest -m unit` ⇒ **1068 passed, 1 skipped, 324 deselected, exit 0**；
`contracts:check` ⇒ **PASS**（含 R6 openapi 新鲜度）；`sync-shared` + `-Check` ⇒ **exit 0**（引擎 21 文件一致；
镜像被 git 忽略 ⇒ **不产生 tracked diff** ✓）。未跑 build。

**测试工程上又踩一次同类坑（第 3 次了）**：测试函数名里带 `'`（引号）⇒ **SyntaxError 直接收集失败**。
（前两次分别是带 `.` 与带 `'`。）⇒ 写中文测试名**只用中文、数字、下划线**。

---

### 8.10 已落地的第 9 个增量：**worker `/explain` 与 orchestrator 同构**（task-26）

**这是什么**：补掉 §8.9 里如实报的"**唯一未同构**" —— worker 也有 `/explain`
（`ws_quote_ext.py:181`），但此前不接受 `spec_override`、也没有那 3 个汇总键。

**改了什么**（生产文件只 `ws_quote_ext.py` 一处 + 测试）

| 项 | 内容 |
|---|---|
| 入参 | `_ExplainIn.spec_override: Optional[dict] = None`（描述文案与 orchestrator 一致） |
| 解析 | **走引擎包的同一份实现**：把 `parse_spec_override` / `SpecOverrideError` 加进 `_ENGINE` 惰性符号表（该模块刻意**不在顶层 import 引擎** —— 镜像漏同步时不能让整个 Worker 起不来）⇒ **worker 里没有第二份解析器** ✓ |
| 新键 | `ok` / `errors: [{code,error,expr}]` / `warnings: [str]` —— **形状决定：照搬 orchestrator 的实测输出**（键名、类型、`errors` 元素三键完全一致）。理由：本任务目标就是两端同构；`warnings` 用字符串与仓库既有 `warnings()` 契约（`rates.py:121`、`spec_delta`）同形 |
| 步骤口径 | 先算**全部**再按 `metrics` 过滤 `steps`（`ok`/`errors` 覆盖全部）—— 与 orchestrator 同一处理 |
| 兼容性 | 老键与 `steps[i]` 的 8 个键**一字不动** |

**两端一致性怎么证的**（两个运行时无法在同一进程里同时加载两套 app）：
**用同一份期望字面量把两端各自钉住** —— worker 侧新增 6 条用例，断言的就是
**orchestrator 实测输出**（顶层键集恰好 = 老 9 ∪ 新 3；`steps[i]` 恰好 8 键；
草稿的 `warnings` 三项**逐项**（含文案）；`x2` 步骤**逐字段**相等；`errors[0]` 的 `{code,error,expr}` 键集）。
⇒ 任一端漂移都会红。

**⚠️ 如实列出的两处"对齐不了 / 需注意"**
1. **`errors[0]["error"]` 的尾部不逐字比对**：它是 Python 解析器的措辞
   （`表达式语法错误 '…': invalid syntax (<unknown>, line 1)`），**可能随运行时/Python 版本变**
   （CPython vs Pyodide）⇒ worker 侧只断言**包含** `表达式语法错误` 与该 `expr`；
   键集与 `code`/`expr` 仍精确比对。这是**刻意的不对齐**，不是遗漏。
2. **两端本就有一处行为差异（既有，不是本次引入）**：worker 的 explain 对 `numeric_inputs`
   做**上下界校验**（`min_value`/`max_value` ⇒ 400 `invalid_numeric`），**orchestrator 没有**
   （只做 `to_decimal`）⇒ 同一份草稿 + 同一组**越界**取值，两端状态码可能不同
   （worker 400 / orchestrator 200）。**未在本任务改**：属既有语义差异，且 worker 侧边界校验
   有既有用例钉着；要不要对齐需另开一项并明确取舍（放松 worker 的校验 / 给 orchestrator 加上）。

**测试**：worker 侧 6 条（追加进既有 `tests/test_four_domains.py`，复用其 harness）——
老请求逐键不变 / 草稿生效且 `warnings` 三项与 `x2` 步骤逐字段等同 orchestrator /
未知字段 422 非静默 / 坏公式 200 但 `ok=false` + `errors` / `errors` 覆盖被 `metrics` 过滤的步骤 /
草稿不要求已注册（对照：不带草稿 404）。
**"新测试真被收集"的自证**：`pytest tests/test_four_domains.py --collect-only -q` 列出
`test_explain_old_request_keys_unchanged` 等 6 条（该文件共收集 52 条）✓

**门禁**：worker `pytest -q` ⇒ **237 passed, exit 0**（231 + 6）；`sync-shared -Check` ⇒ exit 0
（本轮未改引擎，只使用它）；未跑 build。**未碰** `main.py` / `ws_docs_ext.py` / `dbjson.py` /
`app/api/{files,trade_docs}.py` / `frontend/**` ✓

---

### 8.11 已落地的第 10 个增量：**`/explain` 的 min/max 越界校验两端对齐**（task-27 · 今天最后一件代码改动）

**依据**：task-26 ④ 里如实报的**既有差异** —— worker 的 `/explain` 对 `numeric_inputs` 做上下界校验
（越界 ⇒ 400 `invalid_numeric`），orchestrator **没有**。**用户裁定：给 orchestrator 补上**（worker 行为与既有用例不动）。

**做法**：照 worker 的语义**逐字**补进 orchestrator 的 `explain_product` 入参校验
（`app/api/export_quote.py`），错误码与消息同形：

| 情形 | 两端一致的行为 | worker 原文位置 |
|---|---|---|
| 低于下界 | `400` + `{"error":"invalid_numeric","message":"<label>=<值> 小于下界 <min>"}` | `ws_quote_ext.py` 的 `invalid_numeric` 分支 |
| 高于上界 | `400` + `{"error":"invalid_numeric","message":"<label>=<值> 大于上界 <max>"}` | 同上 |
| **未声明界** | **完全不卡**（"自由数值"，用户 A2 裁决） | 同上（`is not None` 才判） |

**⚠️ 实测发现（留痕）**：**今天注册表里三个产品的数值入参全都声明了 min/max**
（chain_link 5/5、deer_net 9/9、field_fence 8/8）⇒ **"未声明界 ⇒ 完全自由"这一条无法用注册表产品验**，
只能用**草稿（`spec_override`）**验（正好也覆盖"与草稿组合"）。
为此加了一条**证据用例**：某天有人加了无界入参（那正是"自由数值"的设计），它会**变红**并提示补注册表侧用例。

**测试**（orchestrator 侧 6 条 + worker 侧 5 条，均真跑）
- orchestrator（`tests/test_explain_spec_override.py`，`pytestmark=unit`）：越界 ⇒ 400（上界/下界各一）／界内 200／
  **恰好等于上下界算界内**／**未声明界的字段完全自由（1e9 / -1e6 / 0 都不卡）**／**草稿里声明了界时越界同样生效**／
  注册表无界入参留痕用例。
- worker（`tests/test_four_domains.py`，worker 侧不注册 `unit` marker）：越界 400（上/下界）／界内 200／
  **未声明界完全自由**／**注册表产品越界 400** —— 与 orchestrator **同一份期望字面量**两端各钉一遍。
- **"新测试真被收集"自证**：`--collect-only -q` 列出那 5 条（worker）／`-m unit` 选中 27 条（orchestrator）。

**`openapi.json`**：按 `AGENTS.md` 的顺序做了 **改 → 重生成 →（提交）→ 再跑 `contracts:check`**。
本次只改 **handler 行为**、未动模型/路由 ⇒ 重生成后产物**无 diff**（`git status` 空）；
因此没有需要提交的产物 —— 这也正是那条门禁规则的边界：**改模型/路由才需要提交产物**。

**门禁**：orchestrator `pytest -m unit` ⇒ **1074 passed, 1 skipped, 324 deselected, exit 0**；
worker `pytest -q` ⇒ **242 passed, exit 0**（237 + 5）；`contracts:check`（提交后）⇒ **PASS R5 + PASS R6**；未跑 build。

---

## 9. 本文件的状态与自证（**滚动更新**）
- task-3 的那一轮：只新增 `docs/PRODUCT_MODULE_IMPL_PLAN.md`，并在 `docs/PRODUCT_MODULE_MERGE_PLAN.md` 追加 §11；当时**未修改任何代码**。
- **task-16**：折进 8 条裁决（§8/§8.1）+ 交付 §5 的 ① 层 `spec_delta.py`（§8.2）。
- **task-19**：交付 **P11** 的纯逻辑层 `kaas_common/workstation/product_scope.py`（§8.3），并跑通共享内核同步。
- **task-20**：交付 **P5/P6（离线部分）** 迁移 `202610110019`（§8.4）。
- **task-21**：**P16 复核**（结论：不够，不新建接口）+ **P12 ② 层契约**（§8.5）。
- **task-22**：**P9** —— 唯一键按团队收敛 + 两端 `ON CONFLICT` 同批（§8.6）；**就地修订 019**。
- **task-23**：**产品基础信息的读路径团队谓词**（§8.7）—— Q6 后半句落地；worker 侧与 `trade_docs.py`
  的同类读点列进 P8/P7 剩余清单。
- **task-24**：**file_objects 落点**（§8.8）—— `files.py` 的 19 处 + worker `ws_files.py` 同构，
  各带"静态审计"用例；`main.py`（含装配层 `resolve_photo_refs`）与 `trade_docs.py` 未授权 ⇒ 已清点。
- **task-25**：**P16 改造第一步**（§8.9）—— `/explain` 加 `spec_override`（草稿定义）+ `ok`/`errors`/`warnings`，
  向后兼容；**团队覆盖那半**（需 db）与 **worker 侧同构**（未授权）明确留待。
- **task-26**：**worker `/explain` 同构**（§8.10）—— 补掉 §8.9 的"唯一未同构"；解析器复用引擎包同一份，
  两端用**同一份期望字面量**各自钉住；如实列出两处差异（解析器措辞尾部、worker 的 min/max 校验）。
- **task-27**：**越界校验两端对齐**（§8.11）—— 用户裁定"给 orchestrator 补上"worker 的 min/max；
  两条差异中的第 2 条就此消失（第 1 条是刻意不对齐，见 §8.10）。**今天最后一件代码改动。**
  本文件由**同一个作者滚动维护**；它**不是**"口径文档"（口径看 `docs/PROBLEM_STATUS_2026-10-11.md`）。
- 各轮都**未碰**另一条任务在飞的 `trade_docs.py` / `worker/src/{main,dbjson,ws_docs_ext}.py` / `frontend/**`，
  也未碰 `shared/**`；task-22 按任务授权改了 `files.py` 与两个 worker 端点（当时实测均为 clean）。
- 提交纪律（2026-10-11 起）：**私有 `GIT_INDEX_FILE`** + 提交前后自检 + 提交后确认别人的改动原样还在
  + **收尾 `git reset -q HEAD -- <本次路径>`**（否则共享 index 停在旧 HEAD，会把新增文件显示成 staged 删除）。
  （`git commit -- <pathspec>` 会把**工作树**里别人的未提交 hunk 一起带走，已由用户规则判定为不足。）
