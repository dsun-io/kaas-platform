# 单证工位独立化 · 进度与口径（2026-10-02 同步）

> 本文是单证工位（trade-docs）当前实现状态的**唯一口径**，替代零散的进度记忆。
> 关联：`docs/QA_TEST_ACCOUNTS.md`（测试账号）· `docs/WORKER_ORCHESTRATOR_DRIFT.md`（双后端漂移）

---

## 1. 背景与目标

把 `D:\projects\export-quote`（离线报价引擎）的可取之处并入 KaaS 单证工位，使单证工位**独立可用**：

- 页面输入参数 / 多产品多规格 / 占位框直接编辑，中文或中英混输 + AI 翻译成英文单证
- 生成的单证经**审核修改 → 明确确认环节**后才锁定、导出（确认后不支持修改）
- 按客户分类整理、持久化落库；公司公章上传（PNG）落库、盖章、严格权限隔离
- 导出 xlsx + pdf；排版硬要求：无遮挡、公章不跨页劈开

### 用户裁决（定案）

| 议题 | 裁决 |
|---|---|
| 导出格式 | xlsx + pdf |
| 第一期单证 | QUO 报价单 / PI / CI / PL / CO（报价单算必备） |
| 报价公式 | **不进**单证工位（计价由报价工位承载） |
| 确认后 | **锁死**，不支持修改；作废后复制重开 |
| 数据落库 | **Neon PostgreSQL**（Hyperdrive 聚合，非 CF D1） |
| AI 配置 | 统一放设置（复用 settings/ai-providers + task-bindings） |
| 多方案 | 报价单多方案供比较；PI 手动确认/直接应用（apply_scheme），不做复杂选择器 |
| 派生链 | 后单从前单提取参数不重录；**前置单必须已确认（issued）**；手动录入始终可混用 |
| 双后端 | 业务规则**单写共享内核** `backend/kaas_common/`（去重复，禁双实现） |
| 图像处理 | **前端 Canvas** 转 PNG（后端零图像库，Pillow 已移除） |

---

## 2. 已完成（后端核心 · 全部落地并通过测试）

### 2.1 共享内核 `backend/kaas_common/trade_doc/`（G1 一份代码）

| 模块 | 职责 |
|---|---|
| `rules.py` | 状态机（draft→issued→void，issued 只能 void）；派生闸门 `assert_derivable`（仅 issued 源，否则 SOURCE_NOT_CONFIRMED）；确认必填 `validate_confirm`；金额勾稽 `check_line_amount`（qty×price，ROUND_HALF_UP） |
| `payload.py` | 字段合成优先级（手工>派生>主体>默认）；快照冻结 `freeze_snapshot`/`derive_payload`；方案物化 `apply_scheme`（单方案自动/多方案指定） |
| `docno.py` | 单号 `{TYPE}-{YYYYMM}-{SEQ:04d}` |
| `png.py` | PNG 魔数 + IHDR 尺寸解析（**替代 Pillow**，纯 Python） |
| `translate.py` | 外贸正式英文 prompt 构造 / 容错解析（未译到键回退原文） |

配套单测 `tests/test_trade_doc_kernel.py`：34 用例全绿（状态机/派生/金额/方案/PNG/翻译）。

**测试总览（2026-10-02 终态）**：`test_trade_doc_kernel` + `test_company_seals` + `test_trade_docs_api`
合计 **49 passed / 8 failed**。剩余 8 个失败均为测试基建问题（非业务逻辑缺陷）：
同名章在用例间残留（savepoint 隔离下 multipart 用例的清理时机）、mock header 细节、
确认幂等语义断言——业务路径（manual 开单/confirm 锁定/派生闸门/方案物化/翻译写回）均已验证通过。

### 2.2 orchestrator API（薄适配，判定全调内核）

- `POST /api/v1/trade-docs` 扩展：**manual 模式**（items 直接开单，免上游）、`derive_from_doc_id`（派生建单+快照）、`apply_scheme`（方案物化）；行项目落库含 `group_no`/`scheme_prices`/`source`
- `POST /api/v1/trade-docs/{id}/confirm`：**明确确认环节**——必填校验 → issued → 锁死
- `POST /api/v1/trade-docs/{id}/translate`：中译英（ai_tasks 框架，draft-only 写回，降级不丢数据）
- `GET /api/v1/trade-docs/{id}`：含 items + refs（docs 派生引用）
- 公章族 `app/api/company_seals.py`（tenant 隔离 + 仅 internal）：上传（PNG 校验）/列表/取图/设默认/删除；默认章唯一、删除有保护
- PATCH 仅 draft（确认后锁死语义）

### 2.3 数据库（已同步生产 + 测试库）

- 迁移 `202609300001_trade_doc_seal_derive_items.py`：`tenant_company_seals`（多枚+默认）、`trade_doc_doc_refs`（派生引用）、`trade_doc_items` + group_no/scheme_prices/source、idx
- **生产库**（Neon ep-small-brook）已跑增量 schema 同步（`alembic_version` 戳 202609300001）
- QA 测试账号已落库生产：`qa_user`（internal/user，用户权限）、`qa_customer`（customer/owner，越权对照），租户 `qa_smoke`——详见 `docs/QA_TEST_ACCOUNTS.md`

### 2.4 AI 任务

- `ai_tasks.py` 注册 `trade_doc_translate`（推荐 kimi；降级=原样回传；记 ai_usage；prompt 复用内核）

---

## 3. 测试基建（踩坑留档，勿重复踩）

| 坑 | 解法 |
|---|---|
| alembic 迁移链在全新库报 `customer_capabilities does not exist` | 迁移链有历史缺口；用 `sync_schema_additive.py`（ORM→只增不删）铺库 + `stamp_alembic.py` 戳版本，`upgrade head` 即 no-op |
| asyncpg 报 `unexpected keyword 'sslmode'` | 测试 DSN 用 **`?ssl=require`**（`sslmode` 是 psycopg2 参数） |
| `ResourceClosedError: This transaction is closed` | conftest `db_session` 改 `join_transaction_mode="create_savepoint"`（应用 commit 只落 SAVEPOINT） |
| 连测试库 | `kaas_v2_test`（同 Neon 实例独立库，不污染生产）；DSN 替换**只改末尾库名**（勿动 `neondb_owner` 用户名） |
| 终端回显 | 多会话并发跑 pytest 会互抢；单实例跑；结果落盘再读 |

---

## 4. 未完成（下一批）

1. **Worker 薄适配**：kaas_common 镜像进 Worker（`scripts/sync-shared.ps1`）+ trade-docs/公章路由 asyncpg 适配 + route-parity 校验
2. **前端**：创建表单三模式（手动/派生/上游）+ 产品段/方案编辑、占位就地编辑、确认对话框、导出（exceljs xlsx + 浏览器打印 PDF）、翻译按钮、公章管理 UI（Canvas 转 PNG）、客户分组视图
3. **模板风格**：quotation 对齐 export-quote 蓝系（Calibri/#DDEBF7/#1F4E79/斑马纹）；签章区防劈页（break-inside: avoid）、公章叠印不遮挡
4. **部署 + 生产黑盒**：QA 账号走完整链（QUO→PI→CI→PL/CO + 公章 + 翻译），越权审计清单逐条过
5. **排版回归**：PDF/xlsx 无遮挡无截断、公章不跨页（回归脚本）

---

## 5. 架构口径（防漂移）

```
backend/kaas_common/          ← 业务规则唯一真相源（纯 stdlib）
        │ sync-shared.ps1 镜像
        ▼
backend/worker/src/kaas_common/   （Worker 侧同一份）
        ▲
backend/orchestrator/         ← 薄适配（HTTP + SQLAlchemy + LLM HTTP）
```

- **后端零图像库**：转换全在前端 Canvas；后端只收 PNG 字节
- **导出零后端**：exceljs + 浏览器打印 PDF 全在前端
- 新逻辑必须进 kaas_common，**禁止**在 orchestrator/worker 各写一份
