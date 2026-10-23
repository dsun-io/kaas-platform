# 文档索引 · 交接从这里开始

> ⚠️ **2026-10-23 09:00 暂停交接**：先读 [`HANDOVER_2026-10-23_PAUSE.md`](./HANDOVER_2026-10-23_PAUSE.md) —— 停止点、
> 工作树 50 项未提交改动、已验证门禁与恢复步骤全在其中。**工作树当前不是干净的**，恢复后先按它 §4 执行。
> 更新时间：**2026-10-22 全项目性能优化审计**（见 [`PERFORMANCE_AUDIT_2026-10-22.md`](./PERFORMANCE_AUDIT_2026-10-22.md)）· 2026-10-22 团队加入申请模块收口（见 [`JOIN_APPLICATION_MODULE_2026-10-22.md`](./JOIN_APPLICATION_MODULE_2026-10-22.md)）· 2026-10-21 切流收口 —— **生产已由 TS 门面 `kaas-edge` 承载（两层架构生效）**；
> Python Worker `kaas` 退居内核（引擎/AI/cron，仅经 Service Binding）。门面冷启动 ~25ms（内核 4674ms）。
> 门禁（2026-10-23 实测）：ts-worker **278（24 文件）** / worker **1709+12skip**（3 条 `js` 模块缺失为本机环境问题）/
> orchestrator **266** / 前端 **1536（211 文件）** / e2e **28 passed** / ui:patterns 违规 **0**（13 allowlist 带理由）/ 静态断言全 PASS；迁移头 **`202610220005`**。
> 注：以上为 2026-10-23 暂停前基线；**暂停时工作树另有 50 项未提交改动**（任务 23/24/26/27 成果 + task-25 半成品），恢复后需重取数字。
> 2026-10-23 已完成 M1-f（门面 12 条透传 + 273 路由对齐）、M3 后端（/dashboard/funnel cohort 口径）、
> M2-A（/inquiries 工位 + 导航契约 R2=29）、M2-B（订单来源链/行项编辑/报价编辑）、M2-C（审批中心/通知铃铛/审批设置，
> R2=30）、M3 前端（仪表盘漏斗看板）。
> **完成后归档**：过时交接与历史计划已移入 [`archive/2026-10-21-cutover/`](./archive/2026-10-21-cutover/README.md)；
> 当前交接= [`HANDOVER_2026-10-21_CUTOVER.md`](./HANDOVER_2026-10-21_CUTOVER.md)；**W5（MCP+REST）已设计待实施**；
> 剩余窗口项（内核瘦身/旧 Neon 清理）已登记 [`TODO.md`](./TODO.md) 与 2026-11-04 / 2026-10-28 提醒。
> 历史文档分批归档在 [`archive/`](./archive/)；**不要用归档文档判断当前口径**。
## 0. 交接 agent 先读（按顺序）

| 顺序 | 文档 | 读它来回答什么 |
|---|---|---|
| 1 | [../README.md](../README.md) | 架构、三环境隔离矩阵、方案 B 决策、冷启动线、测试与门禁（**主交接/唯一权威**） |
| 1b | [HANDOVER_2026-10-21_NAV_STUCK.md](./HANDOVER_2026-10-21_NAV_STUCK.md) | **已闭环排障（2026-10-22，P0/P1/P2 全完成）**：P0=`<Link prefetch={true}>`+静态导出使点击导航挂死 → 改 `prefetch={false}`；P1=Windows 构建使逐段预取 404 → 改 Docker `node:22` Linux 构建（version `71be6dbb` 上线）；P2=AGENTS 立规 + 产物门禁 `pnpm assets:check` + `.gitignore` 垃圾段；P3=导出态 e2e（`pnpm e2e:export`，真实导出产物上 6 条用例，接 nightly）。含离线复现脚本与全部执行记录 |
| 2 | [archive/2026-10-21-cutover/HANDOVER_2026-10-20_FINAL.md](./archive/2026-10-21-cutover/HANDOVER_2026-10-20_FINAL.md) | **最新交接**：§0.2 停止点/剩余工作/恢复路径；**§0.3 新设备/新 agent 接手清单**；§2 三环境、§5 发布检查单、踩坑 |
| 3 | [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md) | 滚动问题状态（顶部按时间倒序，含后端五项与 CI 记录） |
| 4 | [TODO.md](./TODO.md) | **活跃待办唯一账本**（A 单证 / B 产品 / C 其他 / D 发布 / E UI） |
| 5 | [archive/2026-10-21-cutover/UI_UX_OPTIMIZATION_2026-10-20.md](./archive/2026-10-21-cutover/UI_UX_OPTIMIZATION_2026-10-20.md) | UI 方案与终验：P0/P1/P2 已完成，§11 为终验结论（历史「未做」已逐处标注完成状态） |
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
| [HANDOVER_2026-10-23_PAUSE.md](./HANDOVER_2026-10-23_PAUSE.md) | **2026-10-23 09:00 暂停交接**：停止点/未提交改动按任务归属/已验证门禁/恢复步骤/剩余待办全景 |
| [archive/2026-10-21-cutover/HANDOVER_2026-10-20_FINAL.md](./archive/2026-10-21-cutover/HANDOVER_2026-10-20_FINAL.md) | 2026-10-20 最终交接（**§0.2 = 停止点与剩余工作**） |
| [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md) | 问题状态滚动口径 |
| [TODO.md](./TODO.md) | 活跃待办唯一账本 |
| [UNCERTAIN.md](./UNCERTAIN.md) | 决策账本（存疑/裁决落盘） |
| [CI_OPTIMIZATION_2026-10-22.md](./CI_OPTIMIZATION_2026-10-22.md) | **CI 成本口径（2026-10-22）**：实测月耗、触发面瘦身清单、保留的门禁、验证/回滚方法、**self-hosted runner 规划（已批准、未实施）** |
| [JOIN_APPLICATION_MODULE_2026-10-22.md](./JOIN_APPLICATION_MODULE_2026-10-22.md) | **团队加入申请模块（2026-10-22 已实施，全门禁绿）**：设计 + 4 项决策结论（仅注册时 / 只回布尔不列团队 / 先站内通知 / 绿后推 main）+ 实施偏差 §10（4 模式单选卡、400ms、迁移号 `202610220003`、`_SIBLING_MODULES` 登记坑、邀请码 `FOR UPDATE`）+ 门禁实测 |
| [OPTIMIZATION_PLAN_2026-10-22_PRODUCT_INQUIRY_ORDER.md](./OPTIMIZATION_PLAN_2026-10-22_PRODUCT_INQUIRY_ORDER.md) | **2026-10-22 优化方案（已实施，提交 9de3794）**：产品图片归位 / 隐藏产品 key / 规格傻瓜化 + 管理员高级设置 / 询盘多产品 / 手工订单信息与附件 / 全站配置页去技术名词；含数据迁移、验收与待拍板项 |
| [OPTIMIZATION_PLAN_2026-10-22_IMAGE_UPLOAD_SORTING.md](./OPTIMIZATION_PLAN_2026-10-22_IMAGE_UPLOAD_SORTING.md) | **2026-10-22 图片上传 + 全站拖拽排序（已实施）**：上传区重做（拖/点/粘贴 → 队列 → 逐张进度 → 单张重试）、图库拖拽/大图/显式改名/确认移除、六处排序统一到 `SortableList`（产品图/条款模板/报价行/订单行/单证引用图）、主图固定第一位的收敛口径、单证 `product_photos` 的 JSON 安全重排；含落库口径与门禁结果 |
| [OPTIMIZATION_PLAN_2026-10-22_INQUIRY_ORDER_MODEL.md](./OPTIMIZATION_PLAN_2026-10-22_INQUIRY_ORDER_MODEL.md) | **询盘与订单模型重构设计（2026-10-22，待实施）**：订单一等公民 + 询盘独立；orders 增 source_type/source_channel/inquiry_id；询盘/报价/订单编辑入口补齐（后端契约已验证齐全、前端零暴露）；漏斗+权重统计（询盘1/报价2/订单10）；分期 M1 模型 → M2 前端 → M3 仪表盘；实施进度在 TODO §Q |
| [QA_TEST_ACCOUNTS.md](./QA_TEST_ACCOUNTS.md) | 测试账号与验收口径 |
| [E2E_GUIDE.md](./E2E_GUIDE.md) | e2e 一键运行说明（2026-10-21 口径：27 条 = 27 passed + 0 skipped） |
| [API_RESERVED_LIST.md](./API_RESERVED_LIST.md) | **后端先行 API 保留清单（C36）**：扫描基线 60 条未接分类（内部/REST 契约/待接 UI/可删候选）；**2026-10-21 删 3 + 接 21（本期 5 + 下期 12）后剩余约 36 条**（待接 UI 仅 3 条长期保留），证据与计数见该文 §0；新增端点/接 UI 后按 §4 维护 |

### 2.1 审计 / 验收留证（2026-10-21）

| 文档 | 内容 |
|---|---|
| [API_RESERVED_LIST_AUDIT.md](./API_RESERVED_LIST_AUDIT.md) | **C36 API 取证审计**：24 条「后端先行 UI 未接」逐条价值/成本/建议 + 18 条可删候选证据；**2026-10-21 已接 21 条（本期 5 + 下期 12）、删 3 条**，仅剩长期保留 3 条（品名对照编辑/删除缺口见顶部说明） |
| [QA_AUTHZ_AUDIT_2026-10-21.md](./QA_AUTHZ_AUDIT_2026-10-21.md) | **C27 越权审计留证（7 条）**：只读代码审计，逐条三选一结论（已有闸门/缺失/需修复）+ 账号前提核查 |
| [QA_AUTHZ_VERIFY_2026-10-21.md](./QA_AUTHZ_VERIFY_2026-10-21.md) | **C27 越权修复验收矩阵 v2**：F1–F4 + R-1 的「该验什么/期望/证据在哪」；只定义验收，不执行 |
| [PROD_PERFORMANCE_AUDIT_2026-10-21.md](./PROD_PERFORMANCE_AUDIT_2026-10-21.md) | **生产性能体检**：实测 Worker 冷启动为主瓶颈（/health 0.4–5.1s）、DB 无问题（最大表 304kB）；P0/P1 已部署、P2 已迁新加坡（RTT 245→75ms） |
| [PERFORMANCE_AUDIT_2026-10-22.md](./PERFORMANCE_AUDIT_2026-10-22.md) | **全项目性能优化审计（2026-10-22）**：部署方式不变前提下的三维度（UX/响应速度/稳定性）分级行动清单；主瓶颈=内核每查询新连接+全串行（热点 450–600ms）、quotes 首屏 436KB gzip 含 31KB 死重、Sentry 全盲；P0 包 6 项 + P1 包 8 项 |
| [OPTIMIZATION_PLAN_2026-10-21.md](./OPTIMIZATION_PLAN_2026-10-21.md) | **优化执行计划（活跃）**：W1 性能收尾 ✅ / W2 结构债（P0 ✅，P2 在途）/ W3 TS 门面+Python 内核（Phase 0·1 ✅，Phase 2 在途）/ W4 退役 / W5 MCP·REST |
| [W5_EXTERNAL_USAGE_2026-10-21.md](./W5_EXTERNAL_USAGE_2026-10-21.md) | **对外使用文档（M4）**：REST curl 示例 / MCP client 配置 / scope 清单 / 审计边界 / 验收清单 |
| [W5_MCP_REST_DESIGN_2026-10-21.md](./W5_MCP_REST_DESIGN_2026-10-21.md) | **W5 对外能力设计**（草案）：API token 模型（kaas_oat_/哈希存储/scope）+ REST OpenAPI 规整 + MCP tools/resources；建在 TS 门面 |
| [W4_CUTOVER_RUNBOOK_2026-10-21.md](./W4_CUTOVER_RUNBOOK_2026-10-21.md) | **W4 切换退役 runbook**：前置检查/密钥迁移（JWT_SECRET 轮换卡点）/资产切门面/域名切分/验收/回滚/收尾；执行前需用户确认窗口 |
| [EXECUTION_PLAYBOOK_2026-10-21.md](./EXECUTION_PLAYBOOK_2026-10-21.md) | **执行者强化手册**（用户下发，参考为主实际为准）：架构边界/跨层契约/金标纪律/测量与提交纪律 13 节；派任务时携带 |
| [acceptance/B_PACKAGE_2026-10-21.md](./acceptance/B_PACKAGE_2026-10-21.md) | **B 组验收包**：打印视觉 QA、条款、N3 等「需要用户一次过目」的事项清单与证据（含 print-qa 产物） |
| [STRUCTURAL_DEBT.md](./STRUCTURAL_DEBT.md) | **结构性缺口账本（2026-10-21 建档）**：main.py 巨石/循环依赖/无 TODO 锚点/裸 except+print/单人无第二 review/技术选型无论证 6 条 S 组条目 + 免费版优先级矩阵 + 免费版撑不住暂不动项（冷启动/地理）+ 附：历史密钥清理专章（§6，待用户拍板）|
| [ARCH_DECISIONS.md](./ARCH_DECISIONS.md) | **技术选型 ADR（2026-10-21 建档）**：7 条历史决策留痕（raw asyncpg / 无 Redis / 文件三级落点 / Hyperdrive 直连 / Python Worker→已被 TS 迁移取代 / import 挂载 / Neon 新加坡迁库）；新选型先立 ADR 再动手 |

## 3. UI/UX（本轮主线）

| 文档 | 内容 |
|---|---|
| [archive/2026-10-21-cutover/UI_UX_OPTIMIZATION_2026-10-20.md](./archive/2026-10-21-cutover/UI_UX_OPTIMIZATION_2026-10-20.md) | 全系统 UI/UX 方案；P0/P1/P2 已完成，§11 为终验结论 |
| [UI_STANDARDS.md](./UI_STANDARDS.md) | **UI 设计规范硬性约束**：新增页面/组件必须遵守；`pnpm ui:standards` + `pnpm ui:contrast` + e2e a11y 自动发现路由 |
| [UI_EXECUTION_PLAN_2026-10-23.md](./UI_EXECUTION_PLAN_2026-10-23.md) | **UI 整改唯一活跃执行方案**（2026-10-23 按最新实现重写）：P0-A 新实现缺口 / P0-B 全站 P0/P1 止血 / P0-C 共享原语与 ui:patterns / P1-D 结构债 / P1-E 体验一致性；含验收与写热点 |
| [UI_SYSTEM_PRD_2026-10-22.md](./UI_SYSTEM_PRD_2026-10-22.md) | UI 设计依据（页面范式/组件契约/交互合约/门禁规则；执行切分已被上面的执行方案取代） |
| [UI_UX_AUDIT_2026-10-22.md](./UI_UX_AUDIT_2026-10-22.md) | UI/UX 审计证据快照（2026-10-22）；§8 为 2026-10-23 复跑基线与旧条目状态校正 |

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
