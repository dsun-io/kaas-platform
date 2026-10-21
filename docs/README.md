# 文档索引 · 交接从这里开始

> 更新时间：**2026-10-21 最终收口** —— **A 组除 A-11（D6，用户决定挂起）外全部完成；B 组用户已确认关闭**；
> 生产版本 `83647f7a`、迁移头 `202610210001`；门禁 **worker 1560 passed + 12 skipped / 前端 926 passed（108 files）/
> e2e 27 条（27+0）/ 构建 `frontend/out` 286 文件**（数字随批次变化，以当时门禁为准）。
> **停止点交接与剩余工作 = `HANDOVER_2026-10-20_FINAL.md` §0.2；新设备/新 agent 接手 = 同文件 §0.3**；
> 剩余待办全在 [`TODO.md`](./TODO.md)（A-11/D6 挂起项、C36 owner 确认项等）。
> 本次文档收尾：**2026-10-21 最终收口批 5 份已完成文档移入
> [`archive/2026-10-21-final-closeout/`](./archive/2026-10-21-final-closeout/README.md)**（每份都有替代指针）。
> 历史文档分批归档在 [`archive/`](./archive/)；**不要用归档文档判断当前口径**。

## 0. 交接 agent 先读（按顺序）

| 顺序 | 文档 | 读它来回答什么 |
|---|---|---|
| 1 | [../README.md](../README.md) | 架构、三环境隔离矩阵、方案 B 决策、冷启动线、测试与门禁（**主交接/唯一权威**） |
| 2 | [HANDOVER_2026-10-20_FINAL.md](./HANDOVER_2026-10-20_FINAL.md) | **最新交接**：§0.2 停止点/剩余工作/恢复路径；**§0.3 新设备/新 agent 接手清单**；§2 三环境、§5 发布检查单、踩坑 |
| 3 | [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md) | 滚动问题状态（顶部按时间倒序，含后端五项与 CI 记录） |
| 4 | [TODO.md](./TODO.md) | **活跃待办唯一账本**（A 单证 / B 产品 / C 其他 / D 发布 / E UI） |
| 5 | [UI_UX_OPTIMIZATION_2026-10-20.md](./UI_UX_OPTIMIZATION_2026-10-20.md) | UI 方案与终验：P0/P1/P2 已完成，§11 为终验结论（历史「未做」已逐处标注完成状态） |
| 6 | [archive/2026-10-21-final-closeout/UI_BACKEND_DEPENDENCIES_2026-10-20.md](./archive/2026-10-21-final-closeout/UI_BACKEND_DEPENDENCIES_2026-10-20.md)（历史留档） | 后端 5 项**历史验收基线**（2026-10-20 全部完成并入 `main`）；**现行口径看根 README + HANDOVER §0.1**，不要据此判断现状 |

> **换设备 / 新 clone 起本地环境**：先跑 `powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1`
> 再起后端（`backend/worker/src/kaas_common/` 是 gitignored 生成镜像；跳过会 `ModuleNotFoundError: kaas_common.preview`）。
> 完整顺序见根 [`README.md`](../README.md) §3；`GET /health` 返回 `shared.loaded=true` 表示镜像已同步。

## 1. 真相源分层（谁说了算）

| 层级 | 位置 | 作用 |
|---|---|---|
| 1 | **代码库**（含 `shared/contracts`） | 技术真相源：怎么算、怎么运转一律以代码为准 |
| 2 | 线上数据库 | 运行数据 |
| 3 | Notion | 只做任务管理，不是技术真相源 |
| 留档 | `docs/archive/` | 只读历史，不代表当前架构 |

## 2. 当前权威与运行手册

| 文档 | 内容 |
|---|---|
| [../README.md](../README.md) | 主交接（**唯一权威**） |
| [HANDOVER_2026-10-20_FINAL.md](./HANDOVER_2026-10-20_FINAL.md) | 2026-10-20 最终交接（**§0.2 = 停止点与剩余工作**） |
| [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md) | 问题状态滚动口径 |
| [TODO.md](./TODO.md) | 活跃待办唯一账本 |
| [UNCERTAIN.md](./UNCERTAIN.md) | 决策账本（存疑/裁决落盘） |
| [QA_TEST_ACCOUNTS.md](./QA_TEST_ACCOUNTS.md) | 测试账号与验收口径 |
| [E2E_GUIDE.md](./E2E_GUIDE.md) | e2e 一键运行说明（2026-10-21 口径：27 条 = 27 passed + 0 skipped） |
| [API_RESERVED_LIST.md](./API_RESERVED_LIST.md) | **后端先行 API 保留清单（C36）**：扫描基线 60 条未接分类（内部/REST 契约/待接 UI/可删候选）；**2026-10-21 删 3 + 接 21（本期 5 + 下期 12）后剩余约 36 条**（待接 UI 仅 3 条长期保留），证据与计数见该文 §0；新增端点/接 UI 后按 §4 维护 |

### 2.1 审计 / 验收留证（2026-10-21）

| 文档 | 内容 |
|---|---|
| [API_RESERVED_LIST_AUDIT.md](./API_RESERVED_LIST_AUDIT.md) | **C36 API 取证审计**：24 条「后端先行 UI 未接」逐条价值/成本/建议 + 18 条可删候选证据；**2026-10-21 已接 21 条（本期 5 + 下期 12）、删 3 条**，仅剩长期保留 3 条（品名对照编辑/删除缺口见顶部说明） |
| [QA_AUTHZ_AUDIT_2026-10-21.md](./QA_AUTHZ_AUDIT_2026-10-21.md) | **C27 越权审计留证（7 条）**：只读代码审计，逐条三选一结论（已有闸门/缺失/需修复）+ 账号前提核查 |
| [QA_AUTHZ_VERIFY_2026-10-21.md](./QA_AUTHZ_VERIFY_2026-10-21.md) | **C27 越权修复验收矩阵 v2**：F1–F4 + R-1 的「该验什么/期望/证据在哪」；只定义验收，不执行 |
| [acceptance/B_PACKAGE_2026-10-21.md](./acceptance/B_PACKAGE_2026-10-21.md) | **B 组验收包**：打印视觉 QA、条款、N3 等「需要用户一次过目」的事项清单与证据（含 print-qa 产物） |

## 3. UI/UX（本轮主线）

| 文档 | 内容 |
|---|---|
| [UI_UX_OPTIMIZATION_2026-10-20.md](./UI_UX_OPTIMIZATION_2026-10-20.md) | 全系统 UI/UX 方案；P0/P1/P2 已完成，§11 为终验结论 |

> 已归档：`UI_BACKEND_DEPENDENCIES_2026-10-20.md`（后端 5 项历史验收基线）→ 见 §5
> [`archive/2026-10-21-final-closeout/`](./archive/2026-10-21-final-closeout/README.md)；
> 现行口径看根 README、[`HANDOVER_2026-10-20_FINAL.md`](./HANDOVER_2026-10-20_FINAL.md) §0.1 与 [`TODO.md`](./TODO.md)。

## 4. 业务/设计参考（仍有效）

| 文档 | 内容 |
|---|---|
| [WORKSTATION_DESIGN.md](./WORKSTATION_DESIGN.md) | 工位能力网设计 |
| [TRADE_DOC_TEMPLATES.md](./TRADE_DOC_TEMPLATES.md) | 单证模板规范（**现行**：前端 `assets.json`/`manifest.json`/`render.ts` + §十一 A6 双币种/G7–G12） |
| [TRADE_DOC_HARDENING.md](./TRADE_DOC_HARDENING.md) | **单证加固 A7 已完成设计 + 验收记录**（事实层/一致性引擎/回执/导出自检；含 12 条实现裁决与 §6 验收结果） |

> 已归档（2026-10-21 最终收口批，均有替代指针，见 §5
> [`archive/2026-10-21-final-closeout/`](./archive/2026-10-21-final-closeout/README.md)）：
> `PRODUCT_CONFIG_TENANT_UNFINISHED`（B1/B3 收口 → TODO B）、`TRADE_DOC_A6_CALIBRATION`（A6 收口 → TODO A-6 +
> [`TRADE_DOC_TEMPLATES.md`](./TRADE_DOC_TEMPLATES.md) §十一）、`TRADE_DOC_EDIT_PLAN`（A5 上线 → TODO A-9）、
> `TRADE_DOC_PDF_ARCHIVAL`（C12 完成 → TODO A-12 + 代码）。

> 已归档（不再代表当前口径）：`PLATFORM_UPGRADE_PLAN`、`TEAMS_AND_VISIBILITY`、`CUSTOMER_DOCUMENTS_VIEW`、
> `PRODUCT_MEDIA_STORAGE_PLAN` → 见 §5 [`archive/2026-10-21-doc-closeout/`](./archive/2026-10-21-doc-closeout/README.md)。

## 5. 归档入口（历史留档，不代表当前架构）

| 位置 | 内容 |
|---|---|
| [archive/2026-10-21-final-closeout/](./archive/2026-10-21-final-closeout/README.md) | **2026-10-21 最终收口批（5 份）**：A5 单证编辑方案、A6 真实单据校准矩阵、C12 PDF 归档过程记录、后端 5 项验收基线、租户产品配置化设计 —— 全部已完成、**各有替代指针**（TODO A-9 / A-6 / A-12、根 README + HANDOVER、TODO B） |
| [archive/2026-10-21-doc-closeout/](./archive/2026-10-21-doc-closeout/README.md) | **2026-10-21 业务/设计过时批**：平台升级方案、团队与数据可见性、客户单据视图、产品媒体存储规划（4 份移入；**含「生产 `S3_ACCESS_KEY` 只有 13 位 ⇒ 直传不可用」结论摘要**） |
| [archive/2026-10-20-backend-closeout/](./archive/2026-10-20-backend-closeout/README.md) | **2026-10-20 晚 · 后端五项收尾批**：`ENV_VERIFICATION_2026-10-19`（三环境快照已过时；现看根 README §2 + HANDOVER §2/§3/§5） |
| [archive/2026-10-20-p2-closeout/](./archive/2026-10-20-p2-closeout/README.md) | **2026-10-20 下午批**：方案 B/S4/技术栈/安全/税务/批量报价/旧 e2e/旧实现地图等 15 份已完成或已被取代文档 |
| [archive/2026-10-20-closeout/](./archive/2026-10-20-closeout/README.md) | 2026-10-20 收尾批：A′ 计划、PPG 迁移、历史交接/部署/模块计划等 22 份 |
| [archive/2026-10-19-master-exec/](./archive/2026-10-19-master-exec/README.md) | 2026-10-19 契约与 mock 既定决策（批次 README 于 2026-10-21 补齐） |
| [archive/2026-10-17-doc-cleanup/](./archive/2026-10-17-doc-cleanup/README.md) | 2026-10-17 清理批 |
| 根 [`archive/`](../archive/) | **历史参考实现**（45 个受控文件：trade-doc Python 渲染器 + 18 类模板 + 样例），**非当前口径**；当前单证实现在 `frontend/src/lib/trade-doc/` + [TRADE_DOC_TEMPLATES.md](./TRADE_DOC_TEMPLATES.md) |
| [archive/](./archive/) | 更早归档批次（2026-09 等） |

## 6. 维护规则

- 新文档先判断：**当前权威 / 运行手册 / 历史证据**。历史证据直接进 `archive/<日期>-<批次>/`，并在本页登记。
- 改代码必须同步改文档并 push `main`（`AGENTS.md` 规则 1）。
- 归档文档内链可能仍指向旧相对路径；链接检查**排除 `docs/archive/**`**，以本页和 `archive/README.md` 为准。
