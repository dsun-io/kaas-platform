# 产品模块 P1 报告：基础设施、迁移号与三份政策

> **性质**：P1（`docs/PRODUCT_MODULE_IMPL_PLAN.md` §4 阶段 0）的**执行报告 + 政策备选**。
> **不含业务代码改动**：本轮只新增本文件（`docker-compose.yml` **未改**，理由见 §1.5）。
> **输入**：`docs/PRODUCT_MODULE_IMPL_PLAN.md`（17 步计划）、`docs/PRODUCT_MODULE_DECISIONS.md` §六（第二批裁决：Q1=B / 账本接回 / 写权=团队任意成员）。
> 标注：**【已核实】**= 有命令输出或 file:line；**【推测】**= 建议；**【需用户拍板】**= 不代决。
>
> **快照**：`HEAD = c119682`（2026-10-11 22:2x）。另一条任务仍在改 `files.py` / `ws_files.py` / `kaas_common/files/**` / `products/**`，
> **行号已实re-核实**（见 §4.3，与我上一版计划里的行号**已经不同**）。

---

## 0. 本轮结论速览

| # | 结论 | 性质 |
|---|---|---|
| 1 | **本地 Postgres 起不来** —— 本机**没有 docker / podman / nerdctl，也没有 psql/pg_ctl/postgres 服务**，5432 无监听，DB 环境变量为空。迁移类门禁**在本机跑不了** | 【已核实】 |
| 2 | **迁移号不是 018！** 实测 `alembic heads` = **`202610110018`**（另一条任务在 P1 期间新加了 `202610110018_file_sort_order.py`）⇒ 新迁移必须取 **`202610110019`**。我上一版计划里写的 018 **已作废** | 【已核实】 |
| 3 | **`alembic` 有离线通路**：`heads` / `history` / `branches` / `upgrade <a>:<b> --sql` 全部**不需要数据库**即可跑（实测 exit 0、打印真实 DDL）⇒ 可作为无库环境的部分替代 | 【已核实】 |
| 4 | **本地 `pytest -m db` 会静默 skip 且退出码 0**（实测 18 skipped / exit 0）⇒ **"本地全绿"对迁移毫无证明力**，这是最容易骗过自己的信号 | 【已核实】 |
| 5 | 即使有 Docker，`docker compose up -d postgres` **也跑不通**：conftest 要 `kaas_v2_test`，而 compose 只建 `kaas_dev`（库名不匹配，端口通 ⇒ 不 skip ⇒ 真报错） | 【已核实】 |
| 6 | **账本接回有三个必须先拆的雷**：缓存键不含 `team_id`（跨团队串味）、loader 里有 orchestrator-only import 却在被同步到 worker 的目录里、loader 需要 session factory 而调用点手里是 session | 【已核实】 |
| 7 | **待用户拍板 9 条**（D0 基础设施 + D1–D8 政策）。其中 D3（`tenant_products` 无法归因的行）**有改价风险**，且必须在"接回生效"之前定 | 【需用户拍板】 |

---

## 1. 本地 Postgres 可否跑起来（实测）

### 1.1 命令与输出（原样）

```powershell
PS> docker version
docker : 无法将“docker”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。
        + CategoryInfo : ObjectNotFound: (docker:String) [], CommandNotFoundException
PS> docker compose version      # 同上：CommandNotFoundException
PS> docker ps                   # 同上：CommandNotFoundException
```

```powershell
PS> where.exe docker ; where.exe podman ; where.exe nerdctl
INFO: Could not find files for the given pattern(s).        # x3 —— 三个都没有
PS> where.exe psql ; where.exe pg_ctl
INFO: Could not find files for the given pattern(s).        # x2
PS> Test-Path "C:\Program Files\Docker\Docker\resources\bin\docker.exe"          -> False
PS> Test-Path "C:\Program Files\Docker\Docker\resources\bin\docker-compose.exe"  -> False
PS> Test-Path "C:\Users\HJ\AppData\Local\Docker\wsl\docker.exe"                  -> False
PS> Get-ChildItem "C:\Program Files\PostgreSQL"                                  -> (无输出，目录不存在)
PS> Get-Service -Name "*postgres*"                                               -> (无输出，无服务)
PS> (Test-NetConnection -ComputerName 127.0.0.1 -Port 5432).TcpTestSucceeded     -> False
PS> "TEST_DATABASE_URL=[$env:TEST_DATABASE_URL] DATABASE_URL=[$env:DATABASE_URL] TEST_DB_HOST=[$env:TEST_DB_HOST]"
    TEST_DATABASE_URL=[] DATABASE_URL=[] TEST_DB_HOST=[]      # 三者皆空
```

**⇒ 结论【已核实】：本机 Postgres 起不来，`docker compose up -d postgres` 无法执行。**

### 1.2 证据链（为什么这不是"我没试"）

`docker-compose.yml:7-15` 定义了 postgres（image `postgres:16-alpine`、端口 `5432:5432`），
但**执行它的工具链在本机完全不存在**：docker/podman/nerdctl 三个容器运行时都没有，也没有任何本地 PostgreSQL 安装或服务。
`conftest.py:19-39` 的测试库解析即使给出 URL，也没有服务可连（§1.3 实测印证）。

### 1.3 实测：本地跑 `-m db` 会"绿着跳过"

```powershell
PS> cd backend\orchestrator
PS> & .\.venv\Scripts\python.exe -m pytest tests/test_customer_records_api.py -m db -q -rs
SKIPPED [1] tests\test_customer_records_api.py:214: 本地测试库不可用（localhost:5432 连不上（timed out））
        —— 需要 PostgreSQL 才能跑 db 类用例；可用 TEST_DATABASE_URL 指向别处，或启动本地库后重跑。
SKIPPED [3] tests\test_customer_records_api.py:370: （同上）
... (共 13 条 SKIPPED 行)
18 skipped, 3 warnings in 55.15s
PS> exit code = 0        ← 注意：退出码 0
```

**⇒ 结论【已核实】：迁移/DB 类用例在本机是"跳过"，而且退出码 0。**
任何"本地 `pytest` 全绿"的说法都**不能**作为迁移正确性的证据 —— 这正是本项目反复吃亏的那类信号。

对照（证明环境本身没问题）：`pytest tests/test_team_scope_rules.py -m unit -q` → **`17 passed in 1.26s`，exit 0**。

### 1.4 替代方案（三级，按"现在能不能用"排）

| 级别 | 手段 | 现在可用？ | 能证明什么 / 不能证明什么 |
|---|---|---|---|
| **L0** | **Alembic 离线模式**：`alembic heads` / `history` / `branches` / `alembic upgrade <base>:<rev> --sql` | ✅ **实测可用（见 §2）** | ✅ 证明：迁移脚本语法可解析、revision 链接正确、生成的 DDL 是什么<br>❌ 不能证明：DDL 在真实 PG 上执行成功、回填语义、唯一索引在 NULL 下的行为 |
| **L1** | 单机 Docker/Postgres + `docker compose up -d postgres` + **建 `kaas_v2_test` 库**（见 §1.5 的坑）+ `TEST_DATABASE_URL=... pytest -m db` | ❌ 本机无 docker | ✅ 完整的 `alembic upgrade/downgrade` + 迁移语义测试 |
| **L2** | **推到 CI**：`.github/workflows/backend-test.yml` 的 **`db-tests` job**（`postgres:16-alpine` service + `uv run pytest -m db`） | ✅ **今天就能用**（无需本机 Docker） | ✅ 与 L1 同等；**这是目前唯一真正会执行迁移测试的地方** |

L2 的证据（`backend-test.yml:84-122`）：job `db-tests` 起 `postgres:16-alpine`（`POSTGRES_DB: kaas_v2_test`，`:91-93`），
设 `TEST_DATABASE_URL=postgresql+asyncpg://kaas:kaas_dev_pw@localhost:5432/kaas_v2_test`（`:103`），
跑 `uv run pytest -m db --tb=short -q`（`:117-122`）。

**【推测】建议**：P5/P6 的迁移验收**默认走 L2（CI）**；本机只在需要快速迭代 SQL 时用 L0 打草稿。

### 1.5 附带发现：即使有 Docker，`docker compose up postgres` 也会失败（**库名不匹配**）

| 事实 | 证据 |
|---|---|
| compose 的 postgres 只创建 **`kaas_dev`**（用户 `kaas` / 口令 `kaas_dev`） | `docker-compose.yml:11-13`（`POSTGRES_DB: kaas_dev`）；健康检查也是 `-d kaas_dev`（`:19`） |
| 本机测试默认连 **`kaas_v2_test`** | `conftest.py:39`：`postgresql+asyncpg://kaas:kaas_dev@localhost:5432/kaas_v2_test` |
| CI 建的是 **`kaas_v2_test`**（口令 `kaas_dev_pw`） | `backend-test.yml:92-93, 103` |

⇒ 若本机有 Docker：`up -d postgres` 后端口**通了**，于是 `_probe_test_db()`（`conftest.py:45-65`）**不会 skip**，
`db_engine` 会去连 `kaas_v2_test` 并跑 `alembic upgrade head`（`conftest.py:234-252`）⇒ **`database "kaas_v2_test" does not exist` 真报错**。
这是"看似有环境、其实跑不起来"的第二种。

**最小修法（不改文件）**：起完容器补一条
```powershell
docker compose exec postgres createdb -U kaas kaas_v2_test
```
**不建议**把 `TEST_DATABASE_URL` 指向 `kaas_dev`：`db_engine` 会对它跑 `alembic upgrade head` + `create_all` + **写入 INT-R3 种子数据**（`conftest.py:234-252`），会污染开发库。

**为什么本轮不改 `docker-compose.yml`（task 允许改）**：
① 本机连 docker 都没有，**改了也无法验证**（本项目规则：不确定的不要擅自动手）；
② 要真正修好得新增 initdb 脚本（新文件，**超出本任务允许的写入范围**）；
③ 上面那条 `createdb` 一行命令即可，不动共享基础设施。
⇒ 把它登记为 **D-基础设施** 待拍板（见 §7 的 D0）。

---

## 2. 迁移号核对（实测）

### 2.1 命令与输出

```powershell
PS> cd backend\orchestrator
PS> & .\.venv\Scripts\python.exe -m alembic heads
202610110018 (head)

PS> & .\.venv\Scripts\python.exe -m alembic branches
（无输出 —— 没有任何分叉点）

PS> & .\.venv\Scripts\python.exe -m alembic history | Select-Object -First 3
202610110017 -> 202610110018 (head), 产品图排序：file_objects 增加 sort_order
202610110016 -> 202610110017, 修正文件域的版本化边界 + 补主图标记
202610110015 -> 202610110016, 文件域 + 产品媒体 + 验证文件域三表

PS> Get-ChildItem alembic\versions\*.py | Sort-Object Name | Select-Object -Last 2
202610110017_file_version_scope_and_primary.py
202610110018_file_sort_order.py
```

（注：终端为 GBK 代码页，中文描述显示为乱码；**revision id 是 ASCII，可靠**。已用文件清单交叉核对。）

### 2.2 结论

**【已核实】**
- **唯一 head = `202610110018`**（`202610110018_file_sort_order.py`，`down_revision = "202610110017"`，给 `file_objects` 加 `sort_order`）。
- `alembic branches` **空** ⇒ 线性链、**无并行分支**。
- ⇒ **新迁移必须取 `202610110019`**，`down_revision = "202610110018"`。

### 2.3 对计划的更正（重要）

`docs/PRODUCT_MODULE_IMPL_PLAN.md` 的 P1/P5 写的是"新迁移号取 `018`"——**该数字已作废**（另一条任务在本轮期间落了 018）。
⇒ 【推测】请把 P5 的迁移号改为 **019**，并把"**在真正写迁移文件之前再 `alembic heads` 复核一次**"写成硬动作：
**另一条任务仍在加迁移**（018 就是本轮新出现的），编号只能在动笔那一刻定。

### 2.4 离线门禁实测（L0 通路确实可用）

```powershell
PS> $env:DATABASE_URL = "postgresql+asyncpg://kaas:kaas_dev@localhost:5432/kaas_v2_test"
PS> & .\.venv\Scripts\python.exe -m alembic upgrade 202610110017:202610110018 --sql
BEGIN;

-- Running upgrade 202610110017 -> 202610110018

ALTER TABLE file_objects ADD COLUMN sort_order INTEGER DEFAULT 0 NOT NULL;

UPDATE alembic_version SET version_num='202610110018' WHERE alembic_version.version_num = '202610110017';

COMMIT;
PS> exit code = 0
```

**【已核实】**：`--sql` 离线模式**不需要数据库**（只是假设 `DATABASE_URL` 存在），能打印真实 DDL。
⇒ 这就是无库环境下**唯一**能验证"迁移脚本可解析 + 链接正确 + DDL 符合预期"的手段；**不能**替代真实执行。

---

## 3. Q1=B 的回填政策（选项与后果，**不代决**）

### 3.1 背景与现状（【已核实】）

Q1=B 裁决：**产品定义人人可读；产品相关信息（图片/基础信息）一律团队私有，系统级也不例外**
⇒ `product_profiles.team_id` **不可空**（`docs/PRODUCT_MODULE_DECISIONS.md:79`、`:85`）。

现状：
- `product_profiles` 主键 `(tenant_id, product_key)`，**无 `team_id`**（迁移 `202610110016…py:86-95`）。
- 但它**有一个间接归属线索**：`updated_by TEXT NULL`（`202610110016…py:92`），写入的是 `str(auth.user_id)`
  —— orchestrator 在 `files.py:279`、worker 在 `ws_files.py:305`（两端同款）。
- `users.team_id` 可为 NULL（迁移 `202610110001…py:76`，"NULL = 未分组"）。

⚠️ **行数未查到**：本机无库（§1），所以"能回填多少 / 不能归因多少"**没有实测数字**。

### 3.2 取证 SQL（待有库时执行；**只读**）

```sql
-- ① 分类清点：可归因 / 不可归因
SELECT
  count(*)                                                                   AS total,
  count(*) FILTER (WHERE pp.updated_by IS NULL OR btrim(pp.updated_by) = '')  AS no_updated_by,
  count(*) FILTER (WHERE btrim(pp.updated_by) <> '' AND u.id IS NULL)         AS unknown_user,
  count(*) FILTER (WHERE u.id IS NOT NULL AND u.team_id IS NULL)              AS user_without_team,
  count(*) FILTER (WHERE u.team_id IS NOT NULL)                               AS attributable
FROM product_profiles pp
LEFT JOIN users u ON u.id::text = btrim(pp.updated_by);

-- ② 回填（只在 ① 的数字清楚后执行）
UPDATE product_profiles pp
SET team_id = u.team_id
FROM users u
WHERE u.id::text = btrim(pp.updated_by)
  AND u.team_id IS NOT NULL
  AND pp.team_id IS NULL;
```

写法要点【已核实仓库先例】：**必须用子查询 / `UPDATE … FROM` 的形式**，不要裸 `SET team_id = (SELECT …)`；
迁移 `202610110004…py:51-52` 明确警告过："不这样写会写进空子查询，把 team_id 设成 NULL 而**什么都没发生**"。
另：用 `u.id::text = btrim(pp.updated_by)`（**右侧转文本**）可避开"脏值强转 bigint 报错"。

### 3.3 无法归因的行：四个选项与后果

| 选项 | 做法 | 好处 | 后果 / 代价 |
|---|---|---|---|
| **A. 人工定归属** | 出一份清单（`product_key` + `updated_at` + 图片数），由平台方人工指定团队；可能需要一个临时管理入口或脚本 | 结果最正确；数据零损失 | 需要**能判断归属的信息**（清单里常常没有）；在人工处理完之前这些行**必须不可见**（否则又回到实例共享）；可能拖很久 |
| **B. 丢弃** | 物理删 或 软删这些行（配套清理 `file_objects` 与对象存储字节） | 彻底消除"共享残留"；实现最简单 | **数据丢失**，与用户"一次维护、重复使用"的诉求冲突；若有对象存储字节，删行会留下**孤儿对象**（要一并清理，否则白占存储） |
| **C. 归默认团队** | 统一塞给某个团队（如最早创建的团队） | 零人工、零丢失 | **把 A/B 团队的素材静默给了 C 团队** —— 在"团队私有"下这是**新增越权**；C 团队可能根本不认识这些产品；若是 `tenant_products` 行还会**改价**（见 §3.5） |
| **D. 保留 `team_id = NULL` + 仅平台管理员可见** | 不回填，读路径对 NULL 行只放行 `is_admin_role` | 零丢失、零越权；与仓库既有的"NULL 行保持特殊可见性"先例同构（`scope.py:28-30`） | **与 Q1=B 的 NOT NULL 直接冲突**（要允许 NULL 过渡态 ⇒ `NOT NULL` 得延后加/改为部分约束）；这些行在"被认领"前对业务团队**不可见**（等于暂时不可用） |

**【推测】建议 D**（零丢失 + 零越权 + 与仓库零回归先例一致），把"认领"做成一个管理员动作；
但**这是用户的信息资产，不能由实现者替他丢或替他分配** ⇒ **D1**。

### 3.4 Q1=B 与"NULL 过渡态"的硬冲突（必须一起拍板）

`docs/PRODUCT_MODULE_DECISIONS.md:85` 要求 `team_id` **NOT NULL**。若选 D，则必须放宽为：
- 新写入路径**强制** `NOT NULL`（无团队 → **403 `NO_TEAM`**，与 `option_overrides.py:84-88` 同口径）；
- 历史 NULL 行**短期容忍**，并用一个后续迁移在"清零后"再加 `NOT NULL`。

这直接决定 P5 的迁移能不能一次写完 ⇒ **D4**。

### 3.5 三张表**不能**共用一条政策（风险不对称，本条是本报告的重点）

| 表 | 归属线索 | 错归的后果 | 是否与"账本接回"耦合 |
|---|---|---|---|
| `product_profiles`（基础信息） | ✅ `updated_by → users.team_id` | 别的团队看到/改到你的**材质、HS 编码、包装** | 否（展示层） |
| `file_objects`（产品图，`owner_type='product'`） | ✅ **上传时已写 `team_id`**（`files.py:209`；`ws_files.py:245`） | 别的团队看到/下线你的图；主图互顶 | 否（素材层） |
| `tenant_products`（产品定义覆盖/自建） | ❌ **没有创建者列**（`models.py:584-602`）：无法自动回填 | **覆盖套到错的团队 ⇒ 算价用错规格 ⇒ 报错价** | ✅ **强耦合**：裁决"接回算价链路"后，这些行**从"惰性"变成"活的"** |

⇒ **排序约束【已核实逻辑 + 推测】**：`tenant_products` 的归属政策**必须先于接回生效**落定（D3 → 再做 P13），
否则一条错归的覆盖会**静默算错价**。这比"看到别人的图"严重一个量级。
**并且** `file_objects` / `product_profiles` 的 NULL 行政策也要同期定（D1/D2），否则 R1 的团队过滤会把它们变成"谁都看不见"。

---

## 4. 写权尺子设计（Q写权 = 团队任意成员）

### 4.1 现有两把尺（【已核实】）

| 尺 | 定义 | 判定 | 证据 |
|---|---|---|---|
| **管理员尺** | 平台管理员 | 角色映射后为 `system_admin`（含历史 `admin`） | `kaas_common/workstation/scope.py:56-58`（`is_admin_role`） |
| **团队管理员尺** | 团队创建者 **或** 平台管理员 | `is_team_admin(team.created_by, user_id, role)` | `kaas_common/workstation/teams.py:114-125` |
| （参照）**属主尺** | 只能改自己名下的数据（"同团队可见 ≠ 同团队可改"） | `can_write(...)`：`owner_id == viewer_id` | `scope.py:91-101` |

### 4.2 新增第三把尺（【推测】，因裁决 Q写权 而必须新增）

裁决：**团队侧改产品 = 团队任意成员** ⇒ 不能复用团队管理员尺（`docs/PRODUCT_MODULE_DECISIONS.md:81`）。

**【推测】建议定义**（放共享内核，两端同一份，理由见 `scope.py:3-9` 的漂移教训）：

```
is_same_team(viewer_team_id, row_team_id, role) -> bool
  ① is_admin_role(role)                                  -> True    # 平台管理员（是否保留见 D5）
  ② viewer_team_id 非空 且 str(相等) row_team_id          -> True    # 团队成员
  ③ 否则 False
```

⚠️ **不要直接复用 `can_view`**：`can_view` 还包含 `owner_scope == 'tenant'` 与 `owner_id == 我` 两条
（`scope.py:80-83`），而产品行的 `owner_id` 是**产品 key**（不是用户 id）、且根本没有 `owner_scope` 列
（列清单 `_META_COLS`，`files.py:59-63`）⇒ 照抄会得到一个语义错误的放行条件（我把这条也写进了 `IMPL_PLAN` §1.4 末尾）。
同理**不要新增一个叫 `can_write` 的函数**（该名字已被"属主尺"占用，语义不同）。

**"团队成员"的判定口径**就是"**看得到就能改**"（`auth.team_id == row.team_id`）。这与"团队成员能看见同事的客户但不能改"（`scope.py:93-95`）**是两种资产模型**：
产品是**团队资产**（所以团队成员可改），客户是**个人资产**（所以只有属主可改）。⇒ 口径请确认：**D7**。

### 4.3 端点 × 尺 清单（**行号已按 `HEAD c119682` 重新核实**）

> ⚠️ 我上一版计划里的行号**已经全部位移**（`files.py` 因另一条任务的 S3/排序改动增长了 8 行并新增 3 个路由）。
> 下表是**实测**行号（`Select-String '^@router\.'`）；引用时仍建议以路由字面量为准。

#### orchestrator（`backend/orchestrator/app/api/`）

| # | 端点 | 装饰器行 | 现状守卫 | **该用哪把尺** | 备注 |
|---|---|---|---|---|---|
| 1 | `GET /products` | `files.py:220` | 仅 `get_auth_context` | 行级过滤（读） | Q1=B：**定义**人人可读、**素材**本团队；不是 ruler |
| 2 | `GET /products/{key}/profile` | `files.py:257` | 仅 auth | 行级过滤（读，本团队） | 别家 → 404 |
| 3 | `PUT /products/{key}/profile` | `files.py:268` | 仅 auth | **团队任意成员** | 写 `product_profiles` |
| 4 | `GET /products/{key}/media` | `files.py:290` | 仅 auth | 行级过滤（读，本团队） | |
| 5 | `POST /products/{key}/media` | `files.py:302` | 仅 auth | **团队任意成员** | |
| 6 | `POST /file-objects/presign` | `files.py:452` | 仅 auth | **团队任意成员**（`owner_type='product'` 时） | 新增（另一条任务） |
| 7 | `POST /file-objects/register` | `files.py:479` | 仅 auth | **团队任意成员** | 新增 |
| 8 | `PATCH /file-objects/{id}` | `files.py:331` | 仅 auth | **团队任意成员** + **团队过滤** | 现状可跨团队改名/设主图 |
| 9 | `DELETE /file-objects/{id}` | `files.py:371` | 仅 auth | **团队任意成员** + 团队过滤 | 现状可跨团队下线 |
| 10 | `GET /file-objects/{id}/content` | `files.py:384` | 仅 auth | 行级过滤（读，本团队） | **现状可跨团队读字节（IDOR）** |
| 11 | `GET /file-objects/{id}/url` | `files.py:401` | 仅 auth | 行级过滤（读，本团队） | 预签名直链，同 IDOR |
| 12 | `GET /file-objects` | `files.py:602` | 仅 auth | 行级过滤（读，本团队） | 选图器数据源 |
| 13 | `GET /trade-docs/{id}/files` | `files.py:505` | 仅 auth | 行级过滤（读，join 两侧） | 挂件清单 |
| 14 | `POST /trade-docs/{id}/files` | `files.py:524` | 仅 auth | **团队任意成员** + **被引文件必须本团队** | 现状可挂别家文件 |
| 15 | `DELETE /trade-docs/{id}/files/{link_id}` | `files.py:560` | 仅 auth | **团队任意成员** | |
| 16 | `POST /trade-docs/{id}/files/upload` | `files.py:573` | 仅 auth | **团队任意成员** | |
| 17 | `GET /tenant-products` | `tenant_products.py:68` | 仅 auth | 行级过滤（读） | 本团队行 + 系统级定义 |
| 18 | `POST /tenant-products` | `tenant_products.py:91` | 仅 auth | **团队任意成员** | 团队自建（整份） |
| 19 | `PUT /tenant-products/{id}` | `tenant_products.py:124` | 仅 auth；`is_system` → **403**（`:136-137`） | **团队任意成员**；`is_system` 行**保持 403** | 覆盖（差异） |
| 20 | `DELETE /tenant-products/{id}` | `tenant_products.py:152` | 仅 auth；`is_system` → **403**（`:163-164`） | **团队任意成员**；`is_system` 行**保持 403** | |
| 21 | `GET /workstation-products` | `workstation_products.py:35` | auth + `require_quote` | **待定 → D6** | 启用哪些产品 |
| 22 | `POST /workstation-products` | `workstation_products.py:80` | auth + `require_quote` | **待定 → D6** | |
| 23 | `GET /product-options/overrides` | `option_overrides.py:105` | auth + **`_require_team_admin`**（`:120`） | **保持团队管理员尺，不放宽** | 裁决明确"改团队档位仍应是管理员" |
| 24 | `PUT /product-options/overrides` | `option_overrides.py:159` | auth + **`_require_team_admin`**（`:174`） | **保持团队管理员尺，不放宽** | |

#### worker（`backend/worker/src/`）—— 逐条镜像，行号实测

`ws_files.py`：`253`(GET products)、`284`/`295`(profile 读/写)、`311`/`322`(media)、`582`/`598`(presign/register)、
`345`(PATCH)、`382`(DELETE)、`394`(content)、`611`(url)、`409`(GET file-objects)、`432`(GET doc files)、
`450`(POST doc files)、`480`(DELETE link)、`492`(upload) —— **尺与上表 1–16 一一对应**。
`ws_products.py`：`141`/`170`/`202`/`252`（tenant-products CRUD）、`290`/`322`（workstation-products）。
`ws_option_overrides.py`：`182`/`232` 用 `_require_team_admin`（`:149-163`）→ **保持**。

### 4.4 必须仍然是管理员的（**别顺手放开**）

| 对象 | 为什么必须保持管理员 | 证据 |
|---|---|---|
| `/product-options/overrides` GET+PUT（团队档位） | 用户裁决原话：改**团队档位**仍应是管理员；且它与 `team_option_overrides` 同尺 | `PRODUCT_MODULE_DECISIONS.md:81, 93`；`option_overrides.py:120, 174` |
| 团队/成员/订阅类（`/api/v1/teams/**`、`workstations.py` 的团队管理） | 与产品域无关，属组织治理 | `app/api/workstations.py:230-238`；`app/api/teams.py:178-180` |
| **`is_system=true` 行的改/删** | 系统级定义属平台；现状一律 403 | `tenant_products.py:136-137, 163-164` |
| **`POST /export-quote/calculate-internal`、`/verify`** | 含成本与利润率，是"对外不得暴露成本"铁律的落点；**写权放开绝不能波及定价内部视图** | `export_quote.py:942-945`（`require_tenant_admin`）、`:958-962` |
| 平台运维端点（`/api/v1/admin/**`） | 与产品域无关 | `route-parity-allowlist.txt:15-22` |

### 4.5 失败语义（沿用仓库口径，不自创）

顺序固定：**401（未登录）→ 403 `NO_TEAM`（无团队）→ 404（不可见/别家，不泄露存在性）→ 403（可见但无权写）**。

| 场景 | 响应 | 先例 |
|---|---|---|
| 未登录 / token 失效 | **401** `{"error":"unauthorized","message":"Authentication required"}` | `auth.py:227`（worker `main.py:136`） |
| 有登录、无团队 | **403** `{"error":"forbidden","code":"NO_TEAM",...}` | `option_overrides.py:84-88` |
| 别家团队的行 | **404** `PRODUCT_NOT_FOUND` / `FILE_NOT_FOUND` | `ws_common.py:106-115, 137-140`；`tenant_products.py:135, 140` |
| 本团队但系统级行 | **403** `forbidden` | `tenant_products.py:137, 164` |
| 顺序 | **先 404 后 403** | `option_overrides.py:94` 注释；`app/api/teams.py:485` 注释 |

---

## 5. 账本接回算价链路：最小范围

### 5.1 唯一收口点（这是好消息：只需改两个函数）

**【已核实】** 两端各有一个 `_effective_product`，且各自只有 3 个调用者：

| 端 | 函数 | 调用者 |
|---|---|---|
| orchestrator | `export_quote.py:741` `_effective_product(db, auth, product_key)`（`:755` 只 `get_product`） | `:936 /calculate`、`:952 /calculate-internal`、`:965 /verify` |
| worker | `quote_api.py:569` `_effective_product(request, user, product_key)`（`:579` 只 `get_product`） | `:773`、`:784`、`:796` |

### 5.2 最小改动集（【推测】）

| 层 | 文件 | 改什么 | 为什么要分这一层 |
|---|---|---|---|
| **① 纯逻辑（同步两端）** | `backend/orchestrator/app/services/export_quote/` **新增** `spec_delta.py` | `normalize_delta()` / `apply_delta(base_spec, delta)`；语义对齐 `services/option_overrides.py:112-154`（取消=删键、只改显示名不改 code、软停用） | 该目录**整体同步**到 worker（`sync-shared.ps1:44-50`）⇒ 放这里两端自动一致 |
| **② 纯逻辑（减压）** | `.../export_quote/tenant_products.py` | 让 `TenantProductLoader` **只留纯函数/或移出该目录**（见 §5.3-b） | 该文件里现在有 orchestrator-only 的 import |
| **③ orchestrator 取数适配器** | `app/services/tenant_product_source.py`（**新**，orchestrator-only） | 用**传入的 `db: AsyncSession`** 查 `tenant_products`（+差异列），返回 `{base_spec_dict|None, delta|None, source}` | SQLAlchemy 只在 orchestrator 有 |
| **④ worker 取数适配器** | `ws_products.py` 或 `quote_api.py`（worker-only） | asyncpg 原生 SQL 查同样字段，返回同形状 | worker 没有 SQLAlchemy，走 `_main._acquire(request)` |
| **⑤ 接线** | `export_quote.py:741` + `quote_api.py:569` | `_effective_product` 改成：`resolve_effective_product(取数 → 基线 → 套差异 → spec_from_dict 当形状闸门)` | 唯一收口点，改动面最小 |

**基线规则（对齐 R3 裁决）**：`product_key ∈ product_keys()`（代码注册表）⇒ 基线=代码 spec，**差异**叠加；
不在注册表 ⇒ 基线=`spec_from_dict(行.spec)`（**整份**，它没有上游）。

### 5.3 三个必须先拆的雷（【已核实】，不拆就直接接会出事）

| # | 雷 | 证据 | 后果 |
|---|---|---|---|
| **a** | **缓存键不含 `team_id`** | `tenant_products.py:66` `cache_key = f"{tenant_id}:{product_key}"`（`:62` 进程级 dict，**无失效**） | Q1=B 下**直接跨团队串味**：团队 A 的覆盖会被团队 B 命中 ⇒ **越权 + 错价**。接回前必须改为含 `team_id`，或干脆去掉缓存 |
| **b** | **引擎包必须纯标准库，但 loader 里有 orchestrator-only import** | `sync-shared.ps1:16-20`（Pyodide 装不了 C 扩展）；`tenant_products.py:88-89`：方法内 `from sqlalchemy import select` + `from app.db.models import TenantProduct`；实测 **worker 的 `src/` 下没有 `app` 包**（只有 `kaas_common` / `kaas_intel_worker` / `platform`） | 一旦 worker 真的调用 loader ⇒ **ImportError**。今天没炸，只因为**没有任何调用者**（实测全仓只有定义处） |
| **c** | **loader 期望 session factory，调用点手里是 session** | `tenant_products.py:60`（`db_session_factory`）、`:90`（`async with self._db() as session`）vs `export_quote.py:742`（`db: AsyncSession` 请求级会话） | 用 factory 会在请求内**开第二个会话/事务**（脏读 + 连接池压力）。适配器应直接用传入的 session |

### 5.4 风险

| # | 风险 | 说明 | 缓解 |
|---|---|---|---|
| 1 | **改价**：接回后"覆盖生效"意味着同一次输入可能算出不同价格 | 这是**目的**，但也是最容易伤到生产的改动 | 必须有"未设覆盖 ⇒ 与改造前逐分一致"的对账测试（§5.5-1） |
| 2 | `_load_cost_table` 依赖覆盖后的 `pricing_key` | `export_quote.py:779`（`if not product.pricing_key: return {}`）⇒ 覆盖 `pricing_key` 会**改成本表查表维度** | 单测覆盖"改了 pricing_key 后成本表按新维度取" |
| 3 | **错误语义不能变** | 今天未知 key：`get_product` 抛错 → `_effective_product` 返回 `None` → 调用方报 404/400 | 回归测试钉住状态码 |
| 4 | **worker 引擎缺失时的静默降级** | `ws_products.py:69-79`：`except ImportError: return`（**放行写库**） | 对**校验**放行可接受（既有裁决），但**对定价不能静默**：覆盖不生效必须显式报错，否则"用户以为覆盖生效、实际按代码定义算价" —— 本项目最怕的静默 |
| 5 | 两端漂移 | 判定/合并逻辑若各写一份，必然漂移（历史教训 `scope.py:3-9`） | 纯逻辑放 `export_quote/`（自动同步），每步跑 `sync-shared.ps1 -Check` |
| 6 | worker 请求内再取连接 | worker 用 `_main._acquire(request)`；若在已开连接的请求里再 acquire，需确认是否嵌套安全 | 【未查到】需在 P13 前实测（本机无法跑 worker 全链路） |

### 5.5 需要的回归测试（清单）

| # | 用例 | 判据 |
|---|---|---|
| 1 | **未覆盖 ⇒ 逐分一致**：三个内置产品在 `/calculate` 上的输出与改造前**完全相同** | 数值逐分相等（本项目有"逐分复现"传统） |
| 2 | **覆盖生效**：给某团队设差异 ⇒ 覆盖字段变、**未覆盖字段仍随代码**（"不冻住"的定义） | 改上游公式后：未覆盖团队跟着变；覆盖团队只在被覆盖处不变 |
| 3 | **团队隔离（含缓存路径）**：A 的覆盖不影响 B；**且连续调用两次以命中缓存** | 两次结果一致且 B 始终等于代码定义 |
| 4 | **团队自建整份**能进规格空间与算价 | `combo_count`/`derived` 正常；`/spec-space` 与 `/calculate` 看到同一套选项 |
| 5 | **未知 key** 的状态码与改造前一致 | 404 / 400 不变 |
| 6 | **worker 同构**：同一组用例在 worker 再跑一遍 | 两端结果一致 |
| 7 | 迁移可跑（`alembic upgrade`/`downgrade`） | 走 CI `db-tests`（§1.4 L2） |

---

## 6. P1 门禁清单（本步跑了什么 / 预期）

| # | 命令 | 预期 | 实测结果 |
|---|---|---|---|
| 1 | `docker version` / `docker compose version` / `docker ps` | 失败（预期：本机无容器运行时） | ✅ 失败：`CommandNotFoundException`（§1.1） |
| 2 | `where.exe docker; where.exe podman; where.exe nerdctl; where.exe psql; where.exe pg_ctl` | 全部找不到 | ✅ 全部 "Could not find files" |
| 3 | `Test-NetConnection 127.0.0.1 -Port 5432` | `False` | ✅ `False` |
| 4 | `& .venv\Scripts\python.exe -m pytest tests/test_customer_records_api.py -m db -q -rs` | 全 skip，**exit 0**（这正是要在报告里钉住的反例） | ✅ `18 skipped, 3 warnings in 55.15s`；exit 0 |
| 5 | `& .venv\Scripts\python.exe -m pytest tests/test_team_scope_rules.py -m unit -q` | 通过（证明环境本身可用） | ✅ `17 passed in 1.26s`；exit 0 |
| 6 | `& .venv\Scripts\python.exe -m alembic heads` | 唯一 head | ✅ `202610110018 (head)` |
| 7 | `& .venv\Scripts\python.exe -m alembic branches` | 无输出（无分叉） | ✅ 空 |
| 8 | `& .venv\Scripts\python.exe -m alembic history` | 线性链 | ✅ `…016 -> 017 -> 018 (head)` |
| 9 | `& .venv\Scripts\python.exe -m alembic upgrade 202610110017:202610110018 --sql` | 打印 DDL，exit 0 | ✅ 见 §2.4 |

**本轮刻意没跑的（及理由）**：
- **`next build` / `NEXT_EXPORT=1 pnpm build`** —— 队友在用 `frontend/.next`（lead 已冻结），跑它会让 e2e 全红。
- **orchestrator 全量 `pytest -m unit` / worker `pytest`** —— 另一条任务**正把改动暂存在 index 里**
  （实测 `git diff --cached` 有 8 个文件：`files.py`、`ws_files.py`、`kaas_common/files/*`、`products/page.tsx`…），
  此刻跑出来的红绿反映的是**别人半成品的状态**，不是 P1 的结果。P1 是**纯文档**步，不做这种噪声测量。

---

## 7. 待用户拍板（**共 9 条：D0 基础设施 1 条 + D1–D8 政策 8 条**）

| # | 问题 | 选项 | 影响 |
|---|---|---|---|
| **D0** | 本地 Postgres 怎么解决（**基础设施**） | **(a)** 本机装 Docker Desktop + 起 compose + `createdb kaas_v2_test`（§1.5）；**(b)** 只走 CI `db-tests`（今天就可用，P5/P6 的迁移验收放 CI）；**(c)** 给我一个可连的测试库 URL（`TEST_DATABASE_URL`） | 决定 P5/P6 在哪验；本机现在**完全跑不了**迁移测试 |
| **D1** | `product_profiles` **无法归因的行**（无 `updated_by` / 用户名不存在 / 该用户无团队）怎么处置？ | A 人工定归属 / B 丢弃 / C 归默认团队 / **D 保留 NULL + 仅管理员可见**（§3.3 的四种，含后果） | P5、P6、R1 读路径 |
| **D2** | `file_objects`（产品图）`team_id IS NULL` 的行**是否与 D1 同政策**？ | 同 D1 / 单独定 | P5、P7、P8 |
| **D3** | `tenant_products` **无法归因的行**（该表**没有创建者列**，完全无法自动回填）怎么处置？ ⚠️ **错归会改价**，且必须在"接回生效"之前定 | 同 D1 四选一 / 另定 | **P5 必须先于 P13** |
| **D4** | Q1=B 要求 `team_id NOT NULL`，但历史 NULL 行需要过渡 ⇒ 是否允许"**新写入强制、历史暂时容忍 NULL**"？ | 允许过渡（`NOT NULL` 延后加）/ 立即 `NOT NULL`（必须先清零历史行） | P5 迁移能否一次写完 |
| **D5** | **平台管理员（system_admin）**对"团队私有"的产品定义/素材：保留全权读写，还是只读？ | 保留（运维兜底，与 `can_view` 规则①一致）/ 只读 / 完全不可见 | 新尺子（§4.2 规则①）、P9、P10 |
| **D6** | `GET/POST /api/v1/workstation-products`（启用哪些产品）用哪把尺？ | 团队任意成员 / 团队管理员 / 平台管理员 | P9 |
| **D7** | "**团队任意成员可写**"的口径 = **看得到就能改**（`auth.team_id == row.team_id`）？ | 是（团队资产模型）/ 否，还要更严（如仅创建者） | 新尺子定义、P9–P11 |
| **D8** | 接回的**生效范围**：只接"系统级产品的差异覆盖"，还是**也接"团队自建整份产品"进规格空间与算价**？ | 两者都接 / 只接差异覆盖 | P4、P13、P16（团队自建产品能不能被报价） |

> 说明：D1–D3 是**同一类问题的三张表**，但**风险不对称**（§3.5：`tenant_products` 错归 = 错价），
> 所以拆成三条问；若用户愿意，可一次性答复"三表统一用 D 选项"。

---

## 8. 未查到清单

| # | 未查到什么 | 为什么 | 怎么才算查到 |
|---|---|---|---|
| 1 | `product_profiles` / `file_objects` / `tenant_products` 的**行数与 NULL 分布** | 本机无库（§1），也不访问生产库 | §3.2 的两条只读 SQL |
| 2 | `tenant_products` 已有行的**归属** | 该表**无创建者列**（`models.py:584-602`）⇒ 数据本身不含答案 | 只能人工判定（D3） |
| 3 | worker 端 `_acquire(request)` 在已开连接的请求里再取连接是否安全 | 本机无法跑 worker 全链路 | P13 前实测，或读 `main.py` 的 `_acquire` 实现做静态论证 |
| 4 | `docker compose up -d postgres` 在本机的**真实行为** | **没有 docker**，命令根本无法执行 | 装好 Docker 后重跑并贴输出 |

---

## 9. 只读自证与提交纪律

- 本轮**只新增 `docs/PRODUCT_MODULE_P1_REPORT.md`**；**`docker-compose.yml` 未改**（理由见 §1.5）；
  未改任何 `frontend/**`、`backend/**`、`shared/**`。
- **未跑** `next build` / `NEXT_EXPORT=1 pnpm build`（遵守冻结）。
- 提交必须带 pathspec 且 `--no-verify`：
  ```powershell
  git commit --no-verify -m "..." -- docs/PRODUCT_MODULE_P1_REPORT.md
  ```
  **绝不用裸 `git commit`** —— 实测本轮此刻 index 里就有另一条任务暂存的 **8 个文件**
  （`files.py`、`ws_files.py`、`kaas_common/files/__init__.py`、`rules.py`、`202610110018_file_sort_order.py`、
  `test_files_kernel.py`、`products/page.tsx`、`use-products.ts`），裸提交会把它们一起带走。
- 复核：`git show --stat HEAD` 只应列出本报告；`git diff --cached --name-only` 应仍保留别人的那 8 个文件（**不动它们**）。
