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
