# 智能体团队收口（2026-10-12）

> **性质**：本会话（用户指示"创建智能体团队提高效率"之后）**最后三条任务**的收口记录，
> 以及最终的整套门禁数字。
>
> **为什么不写进 `docs/PROBLEM_STATUS_2026-10-11.md`**：那份文档当时**同时有多个写者**
> （另一条线在持续追加），我连续两次为它写补丁：
> 第一次因文件变动失败、第二次成功。本轮再试时**读到尾部（2486 行）之后、补丁落下的瞬间又被追加**，
> 锚点移位 ⇒ 失败。
> **按"不硬抢多写者文件"的原则**，这几条独立成文；等主文档静止后可由任一方折叠进去（内容已自洽）。
>
> 本会话更早的两条收口**已经**落在主文档里（最终门禁全绿那一节、e2e/契约两条线那一节）。

## 一、最终整套门禁（HEAD `6e8a04a`，Lead 在"无 e2e 在跑"时做的 build）

| 门禁 | 结果 |
|---|---|
| orchestrator `pytest -m unit` | **946 passed** / 1 skipped |
| worker `pytest` | **217 passed** |
| `python scripts/route-parity.py` | **PASS**（缺失已登记 / 未登记 0 / 过期 0） |
| `sync-shared.ps1 -Check` | **exit 0**（共享内核 30 / 报价引擎 20 / 枚举字典 1） |
| 前端 `typecheck` | **exit 0** |
| 前端 `test` | **363 passed** |
| `contracts:check` | **PASS R0–R6**（R6：172 paths / 103 模型键集 / 29 response_model 一致） |
| **`NEXT_EXPORT=1 pnpm build`** | **exit 0（35/35 静态页）** |

> ⚠️ **诚实标注**：这一遍**漏跑 `lint`**（命令漏写）。上一次它是 exit 0，且此后只改了
> `openapi.json` 与 `contracts-allowlist.txt`（不属 lint 范围）⇒ 但**不把它算进"本轮验证通过"**。

## 二、契约门禁体系：R0–R6（全部**双向棘轮**）

棘轮语义：**未登记偏差 ⇒ FAIL**；**修好却忘删登记 ⇒ FAIL（过期登记）**。

| 规则 | 内容 |
|---|---|
| R0–R4 | 既有（事件类型 / schema / 工位 / 单证类型 / worker 镜像） |
| **R5.1–R5.3** | `/admin/tenants`、`/admin/tenants/reload`、`/admin/feature_flag` 的**响应键集合**（3 端点 × 12 侧） |
| **R5.4** | **请求体键集合**：前端实发键 `S` / 两端读取键 `B` / 必需键 `K` ⇒ `K⊄S` 或 `K⊄B` 即 FAIL（**历史"点灰度开关 422"的形状**） |
| **R6** | **`openapi.json` 新鲜度**：路径集合 / 方法集合 / `response_model`→`$ref` / 模型字段键集合 |

### R6 的两条设计要点（都是实测逼出来的）

1. **基准两侧都取 HEAD**（`git show HEAD:<path>`），**不跑 `app.main` 生成**。
   理由：CI 只装 node/pnpm（无 Python/FastAPI）⇒ 生成式比对在 CI 只能 `WARN+跳过`，
   而 **CI 正是门禁必须生效的地方**；且本工作区 `app/**` 常被并发编辑 ⇒ 会固化别人的半成品。
   结构解析两侧取 HEAD：**无环境依赖、无跳过分支、CI 可跑**。
   （若要字面意义的生成式比对，正确做法是给 CI 加 `setup-python` + 装依赖 —— 另起一项。）
2. **每条漂移一个棘轮 key**。首版用粗粒度 key（`R6 paths`）⇒ Demo 暴露：
   登记 1 条缺路径后，**之后所有路径漂移都会被当成 KNOWN 吞掉**（棘轮实际失效）。
   改后 FAIL 最多列 30 条并明示"还有 N 条"（不静默截断）。

### R6 上线即抓到 1 条**真实陈旧**（随后还清）

`3e86dd4` 新增的 `/api/v1/trade-docs/{doc_id}/render-fingerprint-check` **没进 artifact**。
按 HEAD 快照重生成还账：**171 → 172 paths，只新增、无删除、schemas 115→115 零变化**（最小手术）
⇒ **R6 现在 0 偏差**（KNOWN 只剩 `R5.1 frontend-api`，待 S4）。
产物出处自证：`app.__file__` 与 `kaas_common.__file__` **都指向 `git archive HEAD` 快照目录**。

**一条已登记的次序特性（待补）**：R6 两侧都取 HEAD ⇒ **提交前**在本地跑会 FAIL
（"我刚重生成，它却说未登记"）。**这是设计如此**（防"本地重生成但忘了提交"），
但建议给该 detail 加一句提示；需改 `scripts/contracts-check.ts`，执行者**未越界**，待派。

## 三、产品模块：8 条裁决闭环 + 首个**可验证增量**

**全部裁决已拍板**：Q1=**B 全私式** / 账本=**接回算价链路** / Q5=**团队任意成员**（+ 细则：团队档位、
团队·成员·订阅、`is_system` 行、`calculate-internal`·`verify` **仍须管理员**）/
**Q6 = 工位人人可见，但用户创建的业务数据仅团队内可见（两层，不许压平）** / Q7=**允许重名** /
Q8=**建试算 + 收敛路由** / D3/D4=**保留 NULL + 仅管理员可见 + 新写入强制**。

`PRODUCT_MODULE_IMPL_PLAN.md` 的 §8 已标"已裁决"，并新增 **§8.1「哪一步随之改变」**：
例如 `team_id` 由"可空"→"新写入强制" ⇒ P5/P6 的迁移与唯一键要改；
⚠️ **历史 NULL"仅管理员可见"与原先"零回归"默认相反**，以裁决为准。

**已交付 `spec_delta.py`（528 行，纯标准库）**：
- **AST 自证**：绝对导入仅 `__future__/copy/dataclasses/hashlib/json/typing` + 相对 `.models`；
  无 `sqlalchemy` / `app.*` / 三方；**传递闭包也干净** ⇒ Pyodide 可跑（引擎包会被同步进 worker）
- **42 条测试**：缺失=不覆盖 / `null`=取消覆盖 / **列表三态（缺失·null·`[]`）互不相同** /
  改名**报错**+显式 alias 留痕 / 身份字段禁改 / 未知 key **一律报错** /
  **"上游改未覆盖 ⇒ 跟着变"** + **"覆盖后上游再改 ⇒ 不变"**
- `pytest -m unit` ⇒ **946 passed**（含新增，全真跑、无 skip）

**两处由执行者自己抓出**：
1. 新版测试**漏 `pytestmark = pytest.mark.unit`** ⇒ `-m unit` 会 **42 deselected**（**等于没测**）
   ⇒ 通用教训：**新测试不加 marker 会被 `-m unit` 静默排除**
2. 用户裁决"建公式试算接口"，**先复核发现它已存在**（`app/api/export_quote.py:282` 的
   `POST /api/v1/export-quote/products/{product_key}/explain`）⇒ **避免重复造接口**

## 四、本会话新增到 `AGENTS.md` 的纪律（都来自真实踩坑）

- **规则 4**：`git commit -- <pathspec>` **不足**以保证"没提交别人的东西"（它记录**工作树内容**，
  同文件别人的 hunk 会被带走）⇒ 用**私有 `GIT_INDEX_FILE`**；
  且**提交后必须** `git reset -q HEAD -- <自家路径>` 归位（否则共享 index 停在旧 HEAD，
  你新增的文件在别人眼里变成 `D ` staged 删除）。**部分 hunk 提交要先转 LF**（工作树 CRLF vs index blob LF）。
- **规则 4**：`frontend/.next` 是**硬冲突资源**（并发 `next build` ⇒ 分块 500 ⇒ 不 hydration ⇒
  MSW 不运行 ⇒ 零请求 ⇒ 页面全白 ⇒ e2e 整轮作废）；**构建门的数字只在工作区静止时作数**。
- **规则 5**：宣布通过/失败/归零前**必须打完整不过滤摘要 + 算术核对**；
  **"没匹配上" ≠ "没有"**（探针在 abort 时不打日志）；**不要用关键字 grep 当"某文案不存在"的证据**
  （曾错判 `events`/`kb`）；**通过数在环境不稳时没有比较意义**。

## 五、仍未完成的三项（各有明确归属，非"未做"）

| 项 | 状态 |
|---|---|
| 依赖漏洞 | 98→78；余 2 critical 需 Next ≥ 15.5.24（用户已定**单独排期**） |
| 产品模块后续步骤（P5/P6 迁移、两端接线、可视化编辑器、收敛路由） | **依赖数据库**；本地无 Postgres ⇒ 走 **CI 的 db-tests** |
| 单证投产联调 | 另一条线已落地 Browser Rendering 出 PDF（含签发时**冻结渲染指纹**）；**卡在生产 R2 密钥 13≠32** |

## 六、本会话专用文档索引

| 文档 | 内容 |
|---|---|
| `docs/E2E_STATUS_2026-10-11.md` | e2e 全过程：已排除的假设、已修的 2 个真实缺陷、根因（`MswProvider` 门短路）、判类表 |
| `docs/CONTRACT_AND_MOCK_DECISIONS.md` | 契约与 mock 覆盖的裁决（P1/P2/P4/M1）+ 三个真缺陷 |
| `docs/ADMIN_TENANTS_CONTRACT_REPORT.md` | `/admin/tenants` 四方不一致的只读分析 |
| `docs/PRODUCT_MODULE_MERGE_PLAN.md` | 两个产品模块的重叠分析（只读） |
| `docs/PRODUCT_MODULE_IMPL_PLAN.md` | **17 步实施计划** + §8 裁决 + §8.1「哪一步随之改变」 |
| `docs/PRODUCT_MODULE_DECISIONS.md` | 裁决原文记录 + 由裁决推出的必做项 |
| `docs/PRODUCT_MODULE_P1_REPORT.md` | P1 基础设施与政策（本地无 Postgres 的实测结论、迁移号、回填政策、写权尺子、账本接回最小范围） |
| `docs/E2E_ROUTE_ENDPOINT_INVENTORY.md` | e2e 路由→端点清单与 mock 缺口 |
| `AGENTS.md` §4/§5 | 多线并发提交纪律 + 测量纪律 |

***

# 当日收尾快照（2026-10-12，用户指示"补上以后记录当前状态，将代码推送到远程，到此为止今天"）

## 一、用户当轮裁定

> worker 的 `/explain` 对数值入参做 **min/max 越界校验**（越界 ⇒ 400 `invalid_numeric`），
> **orchestrator 不做** ⇒ 同草稿 + 越界取值，两端状态码可能不同。
> **用户裁定：给 orchestrator 补上** ✓（保持 worker 现有行为与既有用例不动）
> —— 该项为**今天最后一件代码改动**，**已落地**：`69bf2c2`（4 files, +185/−1）。
>
> **落地结果**：orchestrator 按 worker 的**原始语义逐条照搬**（错误码 `invalid_numeric`、
> 中英文措辞、`{value}` 用 Decimal 而 `{min_value}` 用声明原值），
> 且**只在 `min_value/max_value is not None` 时才判** ⇒ **未声明界的字段完全自由**（对应 A2「自由数值」✓）。
> **测试**：orchestrator 21 → **27 passed**（`-m unit` 选中 27）；worker 237 → **242 passed**（`--collect-only` 自证被收集）。
> **两端并排一致**：`bounded=11` ⇒ 两端 400 +「大于上界」／`=0` ⇒ 两端 400 +「小于下界」／`=10` ⇒ 两端 200／
> 无界 `free_x`（1e9 / −1e6 / 0）⇒ 两端 200／注册表 `de=9.0`（声明 0.3~8）⇒ 两端 400
> ⇒ **task-26 报的那处既有差异已消失**；仅剩 `errors[0].error` 的**尾部措辞**这一处**刻意**不对齐（§8.10，只断言包含）。
> **`contracts:check`**：重生成后产物 **diff 为空**（本次只改 handler 行为、未动模型/路由 ⇒ 无需提交产物，
> 这正是那条"改模型才需重生成"规则的边界）⇒ 提交后 **PASS R5 + PASS R6**, exit 0 ✓

## 二、当日实际交付（在 task-1…task-26 之上）

| 步骤 | 提交 | 一句话 |
|---|---|---|
| **P11** | `8f3e615` | 共享内核「两把尺 + 三层可见性」（Q1=B / Q5 / Q6 用**结构断言**钉住；**不提供工位可见性函数**） |
| **P5/P6** | `4ce9992` | 迁移 `202610110019`：3 表加可空 `team_id` + 唯一键改 `(tenant_id, COALESCE(team_id,0), …)`；**upgrade/downgrade 离线双证** |
| **P16 复核** | `b76bbe4` | `/explain` **不够**用 ⇒ 结论是**改造而非新建**（避免两套解释器）+ P12 ② remove-warning 契约（200 + warnings） |
| **P9** | `a08cfc5` | 唯一键按团队收敛 + **两端 `ON CONFLICT` 同批**；**新增门禁**：迁移 DDL ↔ 三处冲突目标**逐元素比对**（挡"库改了代码没改"这类**单测全绿也发现不了**的错） |
| **读路径谓词** | `deec73a` | `product_profiles`：本团队可读 / **别团队 404** / 历史 NULL **仅管理员**；**HTTP 层证**（含**阳性对照**） |
| **file_objects + worker 同构** | `08de678` | P7 剩余 + P8；**两端各带静态审计用例**（落点必须带谓词、写入必须带 `team_id`） |
| **P16 改造** | `d4783ec` + `2679d9b` | `/explain` 加可选 `spec_override`（草稿定义，不落库）+ `ok`/`errors`/`warnings`；**顺带查出 `spec_from_dict` 静默丢 3 个字段** |
| **worker `/explain` 同构** | `0e9f0fe` | worker 侧同构（解析器**复用引擎包同一份**，经 `_ENGINE` 惰性符号表）；**两端用同一份期望字面量各自钉住** |

## 三、门禁状态（**如实标注**）

- **最后一次全套门禁是在 HEAD `6e8a04a`**：orchestrator **946** / worker **217** / `route-parity` PASS /
  `sync-shared -Check` exit 0 / 前端 `typecheck` **0** / 前端 `test` **363** / `contracts:check` **PASS R0–R6** /
  **`NEXT_EXPORT=1 build` exit 0（35/35 静态页）**。⚠️ 那一遍**漏跑 `lint`**（已如实标注过）。
- **其后每一项改动都各自跑了相关门禁**（orchestrator `-m unit` / worker `pytest` / `sync-shared -Check` /
  `contracts:check`，逐项数字见各任务报告），**但未再跑过一次全套（含 build）** ✗
  ⇒ 下次开工的第一件事建议就是**在工作区静止时补跑一次全套**（含 build），再继续。

## 四、⚠️ 未完成项与**阻塞**（按归属分类，非"未做"）

### A. 被**另一条线的未提交改动**长期占位（**今天无法推进** ✗）

| 文件 | 状态 |
|---|---|
| `backend/worker/src/main.py` | `MM`（**已暂存未提交**），mtime **10-11 23:24** |
| `backend/worker/src/dbjson.py` | `MM`，mtime 10-11 23:27 |
| `backend/worker/src/ws_docs_ext.py` | `MM`，mtime 10-12 01:06 |
| `backend/orchestrator/app/api/trade_docs.py` | `MM`，mtime 10-12 01:06 |
| `frontend/src/app/(app)/products/page.tsx` | `MM`，mtime 10-11 23:38 |

**因此被卡住的具体工作**：
1. **装配层 `resolve_photo_refs`** ⇒ **唯一还漏的跨团队取图路径** ✗（`main.py`）
2. `main.py:3691` 的 product_profiles 读路径 ✗
3. `app/api/trade_docs.py:829` 的产品基础信息读点 ✗
4. **前端可视化编辑器**（目标里明确列出的"产品定义可视化编辑器"）✗ —— 它要落在 `/products` 工位，
   而 `products/page.tsx` 正被占位。

> **处置**：全程**没有去动别人的在飞文件**（这正是本次没再重演"断 HEAD"的原因 ✓），
> 改为**逐轮复查**；一旦释放即可继续。**但今天到此为止，这批占位仍是下一次开工的最大前置。**

### B. 需真库（本机无 Postgres）⇒ 挂 CI `db-tests`

1. P6 的**回填语义**；2. `PRODUCT_MODULE_IMPL_PLAN.md` §8.6 的 **Q1=B 行为验收 SQL**
（两团队各插同一 `product_key` ⇒ 都应成功；同团队重复 ⇒ 23505；两条 NULL ⇒ 第二条 23505）；
3. §8.8 谓词在真库上的**实际过滤效果**。

### C. 其它已登记、未开工

- **§8.5**：`notes`/`hs_codes` 是**标量列表** ⇒ `add`/`remove` 会**抛错而非 warning**（文案没说清"不支持按条增删"）；
  已批准扩范围到引擎包（需重跑 `sync-shared`），**排在 P9 之后**。
- **团队覆盖参与试算**（`spec_override` 只解决"草稿定义"；"团队覆盖参与"仍需 `db`）⇒ 建议与 P13 一起做。
- **前端编辑器接线**（P16 剩余：草稿表单 → `/explain`，用 `ok`/`errors` 做即时红标，`warnings` 展示被默认掉的字段）。
- **依赖漏洞**：98→78；余 2 critical 需 Next ≥ 15.5.24（**用户已定单独排期**）。
- **单证投产联调**：卡在生产 **R2 密钥长度 13≠32**。

## 五、本会话新增到 `AGENTS.md` 的规则（都来自真实踩坑）

1. **§4 私有 index 配方**：提交后**必须** `git reset -q HEAD -- <自家路径>` 归位，否则你新增的文件
   在别人眼里变成 **`D ` staged 删除 + `??`**（下次裸提交会删掉它们）。
2. **§4 `frontend/.next` 是硬冲突资源**：并发 build ⇒ 分块 500 ⇒ 不 hydration ⇒ **e2e 整轮作废**。
3. **§5 测量纪律**：完整不过滤摘要 + 算术核对；"没匹配上" ≠ "没有"；不要用关键字 grep 当"不存在"的证据；
   **通过数在环境不稳时没有比较意义**。
4. **门禁段新增**：改 Pydantic 模型/路由时 `contracts:check` 的"绿"可能是**假绿**（R6 两侧都取 HEAD 快照）
   ⇒ 正确顺序 **改 → 重生成产物 → 提交 → 再跑一次** ✓

> 另有 6 条同类"检查对象错了"的教训散见于 `PRODUCT_MODULE_IMPL_PLAN.md` §8.x
> （正则扫源码 vs `ast.parse`、`Select-String` 通配符不递归、`team_id` 被 `tenant_id` 误命中、
> 测试名带 `'`/`.` 直接 SyntaxError 等）。

***

# ⭐ 跨设备交接记录（2026-10-12 10:38，用户指示"更新相关文档并推送，后续在别的设备继续"）

## 一、交接时的仓库状态

```
HEAD          ff733f2  chore(openapi): 重生成产物 —— 跟随批量对账端点
远程同步      已核实 领先/落后 = 0 / 0（main...origin/main）✓
```

**`ff733f2` 是本条线最后所知的状态**，它由另一条线（单证/PDF 线）推进而来 —— 它在本条线冻结期间
**又活跃过一轮**，新落地并已推送的提交：

| 提交 | 内容 |
|---|---|
| `09c7d2a` | `AGENTS.md` **规则 6**：缺少东西时优先克服困难，而不是绕道 |
| `1cd4689` | 前端"已变更"提示 —— 核对指纹按钮（消费对账端点） |
| `437c55f` | alembic 空库第二处断点修复（整链停在结构性边界） |
| `d641ba0` | **批量对账端点**（两端同契约）+ 文档同步 |
| `ff733f2` | 跟随重生成 openapi 产物 |

## 二、⚠️⚠️ 跨设备续作必读：工作区有 6 个文件的未提交改动【不会转移到别的设备】

以下文件有**另一条线的在飞工作**（`git status` = `MM`，已暂存但未提交）：

```
MM backend/worker/src/main.py
MM backend/worker/src/dbjson.py
MM frontend/src/app/(app)/products/page.tsx
MM frontend/src/app/(app)/trade-docs/page.tsx
MM frontend/src/lib/products/use-products.ts
MM frontend/src/lib/products/__tests__/use-products.test.ts
```

**这些改动的内容只存在于本机工作区，推送不包含它们**（提交才能上远程）。
⇒ 在别的设备上 `git clone/pull` 后，这 6 个文件是 **HEAD 版本，没有这些在飞改动**。

**处置建议（两选一）**：
1. **让那条线自己提交**（最干净）——回到它所在的会话让它收工提交；
2. 如果你确认那些改动可以整体入库（它们与 HEAD 的差异是完整的、自洽的），
   可以让任何一方用 **`git stash` 或单独提交**的方式带走 —— **但不要在本机之外丢失**。

同时注意：本机 `artifacts/` 目录下有未跟踪的取证脚本（`alembic_head.py`、`task16_fresh_db_check.py` 等），
也不上远程（未跟踪 ⇒ 别的设备 `pull` 拿不到；若需要，自行复制）。

## 三、占位/阻塞清单的最新状态（相比本文件 §四-A 已变化）

| 文件 | 10-12 02:09 时 | 10-12 10:38 现在 |
|---|---|---|
| `backend/worker/src/ws_docs_ext.py` | 占用 ✗ | ✅ **已释放**（09:42） |
| `backend/orchestrator/app/api/trade_docs.py` | 占用 ✗ | ✅ **已释放**（09:42）——`:829` 读点谓词**现在可做** |
| `backend/worker/src/main.py` | 占用 ✗ | **仍占用**（`resolve_photo_refs` 装配层 / `:3691` 仍卡住） |
| `backend/worker/src/dbjson.py` | 占用 ✗ | **仍占用** |
| `frontend/src/app/(app)/products/page.tsx` | 占用 ✗ | **仍占用** —— 可视化编辑器前端仍被卡 |

## 四、下一件该做的事（以本文件 §二/§四 的完整清单为准）

1. **先解决那 6 个未提交文件的归属**（§二）——否则跨设备续作会丢工作或撞车；
2. 在工作区静止时**补跑全套门禁**（含 `NEXT_EXPORT=1 build`）——最后一次全套验证在 `6e8a04a`，
   其后十几项提交只各自跑了相关门禁；
3. `trade_docs.py` 已释放 ⇒ 可补 `:829` 的产品基础信息读点团队谓词（P7 最后一块）；
4. 其余按 §四-B（需真库挂 CI `db-tests`）、§四-C（§8.5 标量列表缺口、前端编辑器接线）执行。

## 五、规则提醒（每个新会话自动生效，见 `AGENTS.md`）

§1 代码+文档+推送 · §2 弹窗确认 · §3 不确定的别擅自动手 · §4 多线并发提交纪律（私有 index + 归位）
· §5 测量纪律 · **§6 缺少东西时优先克服困难，而不是绕道**（10-12 新增）。
