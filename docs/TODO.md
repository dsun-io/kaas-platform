# 待办账本（唯一 · TODO）

> **更新：2026-10-20 晚（交接审计后重写；内容 = 文档原列项 + 审计新发现项）**
> 本文件是**唯一活跃待办账本**。状态以**代码/迁移/CI/实测证据**为准，与任何旧文档冲突时以本文件为准；
> 反之，完成一项必须在此销账（见 §H）。历史交接口径见
> [`HANDOVER_2026-10-20_FINAL.md`](./archive/2026-10-21-cutover/HANDOVER_2026-10-20_FINAL.md)（§0.2 停止点 / §0.3 新设备接手）、
> [`PROBLEM_STATUS_2026-10-11.md`](./PROBLEM_STATUS_2026-10-11.md)（顶部摘要）、[`UNCERTAIN.md`](./UNCERTAIN.md)（决策账本）。
>
> 状态图例：⏳ 待排期 · 🔨 施工中 · 🧭 待用户拍板（写明要拍什么）· ✅ 已完成（日期 + 证据）
> 本轮口径修订（2026-10-20，用户裁决）：**废止"触发条件制"**——真实工作项一律作为活跃待办登记，
> 由用户排期；只有"必须用户拍板"的才标 🧭，且必须写明拍什么、代价是什么。

---

## 0. 剩余待办总览（2026-10-21 收口口径；明细见下方各表）

### A. 我继续做（不需要你操作）

| # | 事项 | 说明 | 预估 |
|---|---|---|---|
| A-1 | **A6-2 模板集成：合同 12 条中英双语条款** | ✅ 2026-10-21 已完成（`$contract_clauses_block`；无 `clauses` 时旧 4 条逐字节不变；新增合同双语金标） | — |
| A-2 | **A6 G7：CI 银行区块** | ✅ 2026-10-21 已完成（`ci_bank_block`：仅结构化 `bank_info` 有 beneficiary/account_no 时渲染，旧数据零差异） | — |
| A-3 | **A6 G8 引用链** | ✅ 2026-10-21 已完成（PI ref_quote/contract、CI ref_pi、合同 ref_*+annex_docs 渲染 Annexes） | — |
| A-4 | **A6 G9 税号与完整联系方式** | ✅ 2026-10-21 已完成（`renderAddressBlock` 支持 tax_id/tel/address/email，有值才显示） | — |
| A-5 | **A6 G10 BILL TO / CONSIGNED TO 双栏** | ✅ 2026-10-21 已完成（CI `bill_to`/`consigned_to`，任一有值才渲染） | — |
| A-6 | **A6 G12 有效期/包装细则/生产照片/第三方拼柜方/代表签署人** | ✅ 2026-10-21 已完成（PI P2 字段；`valid_until` 仅在其它 P2 字段存在时随块显示，保护旧金标） | — |
| A-7 | **A14 包装类事实（复用产品 packaging）** | 求值器已就绪；按产品 `spec.packaging[].method` 抽 `packing_method`/`packing_type`（不新增字段）；align-b 施工中 | 0.5 天 |
| A-8 | **A5-W3 金额摘要条** | ✅ 2026-10-21 已完成（只读、无输入控件；复用 `computeFxBreakdown`/`amountInWords`/`receiptTolerance`；17 测；真实样例应付 2,826.49 钉死） | — |
| A-9 | **A5-W2 行项批量编辑** | ✅ 2026-10-21 已完成（前端多选/预览/一次 PATCH/撤销 + 后端 `custom.items_override` 受控通道；渲染副本覆盖、行金额重算、facts manual/unverified、签发闸门拦截；新增 35+27 测） | — |
| A-10 | **C27 QA 越权审计 7 条留证** | 发布后跑一轮并留证（P4） | 0.5 天 |
| A-11 | **D6 冷启动基线收尾** | ⏳ **用户 2026-10-21 决定继续挂起**：Cloudflare 公开 Analytics/GraphQL 不暴露 Worker startup 指标（仅 CPU/请求/墙钟等），无法按原定义写 p50；保持 PENDING，等 CF 开放指标或另定口径 | — | ⏳（用户决定挂起） |
| A-12 | **C12 PDF 归档真单证端到端** | ✅ 2026-10-21 完成：用 QA 账号走真实 API（注册→客户→23 类建单→渲染 HTML→PDF 归档），**22/23 类**产出真 PDF 并落 R2（大小 42–83KB，`file_objects.kind=render_pdf`、`trade_doc_files.role=render_pdf`）；过程中修 **2 个生产 bug**：①`business_events.actor_id` text 传 int ⇒ 建单 500（单据已落库）；②Browser Binding `quickAction` 返回 Response 的字节读取（`arrayBuffer` 不可用 → `bytes()`/`.to_py()`）；`other` 类因 Worker CPU 1102 待重试；证据与清理已留档（QA 数据/R2 对象已删） | — |
| A-13 | **C36 审计后续** | ✅ 全部完成：审计 + 删 3 条 + 本期 5 + **下期 12 全部接上**（待接 24→3 长期保留；13 条 owner 确认待业务）；遗留缺口：品名对照编辑/删除（后端无 list/PATCH/DELETE，登记为后续后端项） | — |
| A-14 | **A10：5 类扩展模板实现** | ✅ 全部完成（P1：`beneficiary_decl`/BD、`saso_coc`/COC；P2：`vessel_cert`/VC、`export_license`/EL、`ciq`/CIQ；金标 25→28、DOC_TYPE 23 类、contracts R3/R4 PASS）；无真实样例字段留空待填，未伪造 | — |
| A-15 | **A8①：归档任务端到端实跑** | ✅ 2026-10-21 已完成并验证：首窗口 cron 失败根因 = `events_archive_log.id` uuid NOT NULL 且现网无默认值（NotNullViolation，重试 3 次静默失败）→ worker 显式传 uuid + 迁移 `202610210001` 补默认；手动触发归档 2026-10-19：**archived=7 / version_count=1**，DB 新增 1 行（`kaas-files/events-archive/2026/10/19/v1.jsonl.gz`）+ R2 对象 326 bytes 实测可下载 | — | ✅ |
| A-16 | **D2 后直传路径端到端复验** | ✅ 2026-10-21 已验证：临时 QA 账号 → `POST /file-objects/presign` 返回 `configured=true`（签名用系统 token `kaas-r2-system`）→ PUT 200 → GET 200（内容一致）→ DELETE 204；临时账号与对象已清理 | — |
| A-17 | **重置密码邮件 UI 同步新版** | ✅ 2026-10-21 已完成（electric-blue/12px 圆角/table 响应式/纯文本兜底） | — |

### B. 需要你提供 / 拍板 / 操作

| # | 事项 | 需要你做什么 | 不做的后果 |
|---|---|---|---|
| B-1 | ~~N3 H-2 用户复验~~ | ✅ 2026-10-21 用户确认通过（验收包第 3 节） | — |
| B-2 | ~~D4 生产测试数据清理~~ | ✅ **2026-10-21 dry-run 实测 0 行匹配（可删 0、被引用跳过 0）⇒ 无需清理，已关闭**，不需要你操作 | — |
| B-3 | ~~C2/C10 打印视觉 QA~~ | ✅ 2026-10-21 用户确认打印 OK（`docs/acceptance/print-qa/` 3 份 A4） | — |
| B-4 | ~~C36 拍板~~ | ✅ 2026-10-21 用户批准删 3 条（PATCH /spec/prices/{id}、POST /spec/skus/{id}/prices、POST /file-objects/upload）；13 条 owner 待后续统一确认 | — |
| B-5 | ~~A6 合同 12 条双语条款抽查~~ | ✅ 2026-10-21 用户确认条款 OK（默认措辞可编辑，法务后续可改） | — |
| B-6 | **CI self-hosted runner（可选，已降级；仓库已转 public）** | 仓转 public 后 GitHub-hosted 分钟免费无限，**不再是省钱必需**。仍想要更快反馈/自定义环境时：给一台常开 **Linux** 机器，按 [`CI_OPTIMIZATION_2026-10-22.md`](./CI_OPTIMIZATION_2026-10-22.md) §6 接（**public 仓库只给 push main / 手动 job 用**，别给 `pull_request`） | 不做也不影响额度；只是仍跑 GitHub 托管 runner（排队/无自定义环境） |

### C. 已按你裁决不做 / 暂缓（不再列为待办）

- **C24** 客户触达「产品手册附件」——暂缓；**N10** 事件流联通——暂缓；
- **安全 4 项**（Neon 口令轮换/管理员改密/仓库转 private/filter-repo）——不做；归档数据已按批准脱敏；
| S1 | **结构性缺口账本建档（S-1~S-6）+ 门禁** | ✅ 2026-10-21：新建 [`STRUCTURAL_DEBT.md`](./STRUCTURAL_DEBT.md) 登记 6 条结构性债（main.py 巨石 5170 行 / 循环依赖 34+2 处 noqa:E402 / 无 TODO 锚点 / 88 处裸 except + 18 处 print / 单人无第二 review / 技术选型无论证）；新增 `scripts/check-structural-debt.py` 静态门禁（main.py≤4000 行、noqa:E402≤40、except Exception≤100、print≤20）；补 `docs/ARCH_DECISIONS.md` ADR 6 条。**未改任何生产代码**，纯文档+门禁脚本 | — | ✅
| S2 | **技术选型 ADR 建档（S-6）** | ✅ 2026-10-21：新建 [`ARCH_DECISIONS.md`](./ARCH_DECISIONS.md)（ADR 简化版第一版），补录 7 条历史选型决策：raw asyncpg 直连 / 无 Redis·消息队列 / 文件三级落点（R2 binding→S3 预签名→inline 兜底）/ Hyperdrive 每请求直连无池 / Python Worker 承载（已被 2026-10-21 TS Worker 迁移拍板取代，链 OPTIMIZATION_PLAN §2 W3）/ 文件末尾 import 挂载 / Neon 新加坡+Hyperdrive 迁库。纯文档，未改代码 | — | ✅
- **C1/C13/N8**——不做（业务默认）；**C14** 产品税率——"使用时再设置"，不预铺；
- **D1/D2** 已完成（Resend 注入、R2 32 位密钥 + 回环验证）；**D5** 关闭。

### D. 当前生产基线（2026-10-21 收口）

- 生产版本 **`e5092262-d595-426f-ad22-4915fa022eaf`**（第 11 次部署）；迁移头 **`202610210001`**；
- 门禁：worker **1558 + 12skip** / orchestrator **247** / 前端 **926（108 files）** / e2e **27 = 27 + 0** / build out **286** / contracts·mocks·contrast·trade-doc:check·静态断言全 PASS。

---

## 1. 接手基线（2026-10-20 晚实测，换设备/换会话从这里开始）

| 项 | 状态 |
|---|---|
| 代码 | `main` @ `213f87c1`（本轮 21 个提交；工作树干净）；**远端只剩 `main`** |
| 迁移头 | **`202610200006`**（A5-W1 条款模板表；前序：`trade_doc_facts` + 文件唯一索引 NULLS NOT DISTINCT）。**生产已从 `202610180010` 升到 `202610200006`（2026-10-21，pre-release 快照 `snap-late-shape-b55lavme`）** |
| 门禁基线（本机 2026-10-21 收口实测，工作区静止） | worker **1354 passed + 12 skipped**（无库；12 条 db/integration 档按既有约定 skip；有 docker PG 时这 12 条真跑、总数 **1245**）；orchestrator **247**；前端 `pnpm test` **719 passed（74 files）**；typecheck 0 / lint 0 error / contracts R0–R6 PASS / `mocks:check` 未覆盖 **0** / e2e **27 条（27 passed + 0 skipped）** / `NEXT_EXPORT=1 pnpm build` → `out/` **277 文件**（含 pdf.js worker 资产，已实测生产可加载） / 静态断言 5 项 PASS（`check-worker-bundle` 本机 SKIP：uv 0.11.8 < 0.12.3，CI 会执行） |
| 前端 e2e | `playwright test --list` = **27 条**（27 passed + 0 skipped） |
| 仓库可见性 | **public**（匿名 `git ls-remote` 成功）；`gh` 本机未登录 ⇒ CI 只能用网页/无 token 接口核对 |
| 分支清理 | ✅ `archive/convergence-aprime-20261019` tag 已推；远端 `feat/convergence-aprime`、`feat/trade-doc-content-a` 已删；本地 `feat/trade-doc-templates`、`tech-stack-next16` 已删 |
| stash | ✅ 2 个历史 stash 已 drop，内容留在本地 `refs/archive/stash0-20261019-2334`、`refs/archive/stash1-20260926-1508` |
| 本机环境 | Docker 已起（postgres/redis/minio/backend）；`.env.local` 是**生产 DSN 存档**（已加警示注释 + 本地开发指引），不是本地开发配置 |
| 审计产物 | `.tmp/branch-audit.md`、`.tmp/doc-scan.md`、`.tmp/code-gap.md`、`.tmp/align-report.md`、`.tmp/handover-gap-{branches,docs,code}.md`（二轮全量 sweep） |

---

## A. 单证内容专项（用户点名方向）

| # | 待办 | 内容与验收 | 前置 | 状态 |
|---|---|---|---|---|
| A1 | 内容级版本 | 草稿期每次保存留历史（谁/何时/改了哪些字段），可回看/回滚 | — | ✅ 2026-10-20（迁移 `202610200001`；三端点 + 前端面板） |
| A2 | 服务端签发兜底（方案 A） | 服务端唯一实现 `ws_files.archive_rendered_pdf`；`POST /trade-docs/{id}/confirm` 与 `PATCH /trade-docs/{id}`（draft→issued）两入口接线；失败不回滚签发 | — | ✅ 2026-10-20（旧账本 ⏳ 系未销账） |
| **A2-B** | **方案 B：模板迁服务端** | 让"不带预览 HTML 的第三方客户端"也能出 PDF（模板现在在前端，是结构性限制）。需先定模板渲染归属（服务端 HTML 模板 vs 前端产物回传） | 方案讨论；与 A4/A7 渲染层同一片 | 🧭 需用户定要不要做（成本高、收益=第三方客户端/自动化） |
| A3 | 字段缺失可发现 | 渲染期 warning + 前端「缺失字段」标记 + 签发前清单 | — | ✅ 2026-10-20（`findBlankPlaceholders` + 预览状态栏；18 类模板无未登记占位符） |
| A4 | 图片素材库 + 去 base64 | ✅ 2026-10-21（用户选 R2 直链方案）：新增 `kaas_common/files/token.py`（HMAC 短期令牌，TTL 900s，purpose+资源 id 绑定）；装配层 `resolve_photo_refs` / `_apply_default_seal` 改为**签名直链**（`/file-objects/{id}/render-content?t=`、`/company-seals/{id}/render-content?t=`），无密钥/取不到时回退原 data URI；渲染器白名单**未改**（本来就认 http(s)）；素材库=复用现有产品图库+公章库+picker（不新增表）。测试 +16（令牌 6 / 文件直链 6 / 公章直链 4） | G-4 已拍板 | ✅ |
| A5 | 单证编辑体验 | **W1 条款模板已上线（2026-10-21）**：团队级条款库（迁移 `202610200006` + CRUD + 懒种子 6 类中英措辞）+ 设置→企业信息卡片 + 单证表单「选模板回填/覆盖二次确认」。**剩余 W3 金额摘要条、W2 行项批量编辑**（方案 W1→W3→W2，用户已拍板） | W3/W2 | 🔨 W1 ✅ / W3·W2 待做 |
| A6 | 模板逐字段对照真实单据 | **2026-10-21 用户提供 3 份真实单据** → 校准矩阵 [`TRADE_DOC_A6_CALIBRATION.md`](./archive/2026-10-21-final-closeout/TRADE_DOC_A6_CALIBRATION.md)（已归档）。✅ A6-1：PI/CI **双币种金额块**（四列行项/汇率/舍入调整/运费/定金尾款/应付总额；旧 18 金标零差异 + 2 份 FX 金标；facts 增 total_payable）；✅ A6-2 数据层：合同 12 条中英双语条款（`contract-clauses.ts`，待模板集成）。**剩余**：G7 的 CI 银行区块、G8 引用链、G9 税号/联系方式、G10 BILL TO/CONSIGNED TO、G12 有效期/包装细则、A6-2 模板集成、校准 §4 三个口径待用户确认 | A6 后续 | 🔨 主体完成 |
| A7 | 单证加固 P1/P2 | ✅ 2026-10-21 全部落地：①事实层+②一致性引擎内核（87 测）+ 事实表（迁移 `202610200004`）+ **10 个 Worker 端点**（34 测）+ **UI**（事实确认/一致性三档/收款/单证清单/签发闸门，面板 9 + 契约 12 测）。`confirm` 默认拦截未确认事实；`allow_lint_override` 未对前端开放。设计与 12 条裁决见 [`TRADE_DOC_HARDENING.md`](./TRADE_DOC_HARDENING.md)。尾巴：导出后自检 UI 需 PDF 文本抽取（C21） | — | ✅ |
| A8 | PDF 归档尾巴 | ②③ 已完成（cron + 列表「已变更/模板已更新/待复核」标识）；①端到端真实跑一次 | ①需已部署环境 | ✅ ②③；①随发布后 P4 |
| A9 | 指纹批量对账定时调度 | cron `40 17 * * *` + `trade_doc_render_checks` 表 + 列表 `render_check` | — | ✅ 2026-10-20 |

### §A7 子项（施工清单；口径见 `UNCERTAIN.md` #17 + [`TRADE_DOC_HARDENING.md`](./TRADE_DOC_HARDENING.md) §4「实现裁决」）

- [x] A7-① **事实层（fact model）**：内核 + `trade_doc_facts` 表 + `GET/POST/PATCH facts` 端点 + 事实面板完成。
- [x] A7-② **一致性引擎**：全局等价词表 + 租户增量（`extra` 透传）；diff 三态；`GET /trade-docs/{id}/consistency` + `POST /lint` + 一致性面板完成。
- [x] A7-③ **收款容差**：内核 `receipt_rules` + `GET/POST /trade-docs/{id}/receipts` + 收款面板（fx_rounding/short_paid/manual 徽标）完成。
- [x] A7-④ **`not_by_us` 回执登记**：`GET/PUT /trade-docs/{id}/doc-set` + `POST .../doc-set/{type}/receipt` + 单证清单面板完成。
- [x] A7-⑤ **导出后自检**：`POST /trade-docs/{id}/verify-export`（默认阻断 422、`allow_override` 越过并落审计）+ confirm 闸门完成；**UI 需 PDF 文本抽取（登记 C21）**。

---

## B. 产品配置化

| # | 待办 | 真实状态 | 前置 | 状态 |
|---|---|---|---|---|
| B1 | 租户级产品定义配置化 | **租户级 ✅ 销账**（2026-10-21 端到端验收 + 修复后复验）：CRUD 全通（201/200/200/204、409/422/404）、跨团队写/删已封、`/formulas`+`/explain` 支持租户产品、运行时算价即时生效；系统级仍是 Python `@register` 注册表（4 个） | 系统级口径见 §G-3 | ✅ 2026-10-21（B4/B5/B6 全部修复并复验） |
| B2 | 产品可视化编辑器 | `product-spec-editor.tsx` + `products-definitions-tab.tsx`，保存即生效 | — | ✅ 2026-10-21 端到端验收：克隆 `field_fence` → 与系统产品同价 3.041 → PUT `raw_price×1.2` → **同会话无重启**立即算得 3.6357 元/米（+19.6%），发现列表同步改名 |
| B3 | 租户开通报价工位 UI | `team/components/team-subscriptions-panel.tsx`（管理员开通/撤销、PUT 后重拉列表）+ 产品页启用开关 | — | ✅ 2026-10-21 端到端验收：`PUT /teams/1/subscriptions/full_chain` 后**同一进程内** `/me/workstations` codes `[]→["full_chain"]`、中间件门从 404 变放行；DELETE 后立即回退（`_invalidate_all` 生效） |
| B4 | **租户产品写路径团队隔离（P0 安全）** | ✅ 2026-10-21 修复并复验：PUT/DELETE 复用 `product_scope.is_same_team`（列表同一把尺），非本团队 **404**、零写入；管理员不受限；`team_id IS NULL` 历史行只有无团队者本人可写（写读对称）。20 条测试。原缺陷：只校验 tenant，team2 owner 可改/删 team1 产品（复现 200/204） | — | ✅ |
| B5 | 租户产品 `/formulas`/`/explain` 回落 | ✅ 2026-10-21：拆 `_effective_product_raw`（团队谓词+override）→ `_product_or_404_tenant` 回落租户运行时产品，两路由共用；租户产品 200，系统产品/未知 key 行为不变，跨团队仍 404；DB 不可用时降级为只查注册表（不 500） | B4 | ✅ |
| B6 | `/workstation-products` 假路由处置 | ✅ 2026-10-21：选「团队级 + 租户级兼容 union」——与 B3 同源、生产种子行不回归、`required_any:["full_chain","quotes"]`（保留门）；开通后成员 200/管理员 201，撤销订阅即 404。遗留建议：与 `/tenant-product-status` 功能重复（同表同冲突目标），后续收敛为一条再删路由器 | B3 | ✅（建议收敛见 §B 注） |

---

## C. 质量、体验与"审计新发现"项

| # | 待办 | 内容 | 前置 | 状态 |
|---|---|---|---|---|
| C1 | 「流失」拒绝文件链路 | 订单阶段新增 `lost`，拒绝文件链路迁订单阶段 | **用户 2026-10-21 授权默认：不做** | ✅（不做） |
| C2 | 文件存储收尾 | ✅ 2026-10-21：`doUpload`/排序改错误文案透出后端可执行原因 + **16 条页面级测试**（直传/回退/configured=false/register 失败不回退；排序顺序/PATCH body/422 越界）；**7 条真 PG 集成用例**（部分唯一索引/跨租户/bytea 往返/公章约束；无库 skip，有库 1245/0）。尾巴：公章 PI **视觉 QA** 需人工打印复核（并入 C10 视觉尾巴）、D2 R2 新密钥后直传路径再验 | D2/视觉 | ✅（视觉尾巴） |
| C5 | 本地 mock 刷新丢数据 | ✅ 2026-10-21：`mocks/persistence.ts` 版本化键 `kaas-mock-v1:<集合>`（47 集合、只持久化被写操作碰过的集合、`?mock_reset=1` 重置、SSR/隐私模式 no-op、e2e 默认种子确定性）；字节类不落盘（避免 5MB 配额） | — | ✅ |
| C6 | e2e 数据层不稳根治 | ✅ 2026-10-21 收口（根因逐项治理，非"数字变好"）：①**误报源**：MSW 长尾未覆盖时请求直连网络/500 → 兜底路由掩盖（现覆盖 **0 缺口**，`mocks:check` 门禁）；②**数据不确定**：mock store 改 localStorage 持久化后补"e2e 默认种子 + 新 context 空 storage + `?mock_reset=1`"三保险；③**环境争用**：playwright 已固定 workers=2、NO_PROXY、mock baseURL 指回页面源、`NODE_OPTIONS=2048MB`；④**单测 flake**：xlsx 模板用例 `testTimeout` 15s 已放宽，全量默认并发本次 60 files/616 tests 22s 全绿。**已知限制**：本机多 agent 同时跑门禁时仍可能 worker OOM（资源争用，非产品信号）；CI 两核并发天然受限。**测量纪律**：任何 e2e/构建数字只在工作区静止时作数 | — | ✅ |
| C7 | Excel xlsx 上传闭环 | ✅ 2026-10-21：纯 stdlib 读取器 `kaas_common/export_quote/xlsx.py`（zipfile+ElementTree；sharedStrings/inlineStr/富文本/公式缓存/日期 serial/合并单元格/行列与解压上限/坏文件），`preview`+`calculate` 接受 `.xlsx` 且与 CSV 共用字段映射；CSV 行为零变化、`.xls` 指路另存；服务端 xlsx **模板**保持 501（浏览器侧 exceljs 已生成，理由见报告）。**前端暂无批量导入上传 UI → 登记 C19**；28 条测试 | — | ✅（上传侧） |
| C8 | 四源计数端点 | ✅ 2026-10-21：`/leads` 与 `/leads/{id}` 的 `demand_index`/`blank_index` **真实回填**（`chain.py` 新增 `_lead_indices`：2 条参数化 SQL、无 N+1；需求量取 `intel_demand_index` 最新月份合计、地区归一化 + 国家别名兜底；已开发量=抓取+调研+触达(sent)+成交，成交按 F4 `stage∈order/shipment/completed` 或非 cancelled 订单链；无需求行 ⇒ 两字段仍 null 不拿 0 冒充）。**按设计不加独立端点/不改排序**（§6.8 只要求字段回填）。18 条测试 | — | ✅ 2026-10-21 |
| C9 | 诊断端点收敛 | `_r2_debug` / `fx-rates/_debug` 暴露面收敛 | — | ✅ 2026-10-21 复核：两个端点**已有** `is_admin_role` 闸门（`ws_files.py` r2_debug / `ws_extras.py` fx_provider_debug，B0-6 收敛，普通用户 403），无需改动 |
| C10 | 18 模板签章区孤行 | ✅ 2026-10-21：`@media print` 加 `.keep-together { page-break-inside: avoid; break-inside: avoid; }`；18/18 模板**各恰好一个容器**包住「签章+公章+声明/紧邻条款/备注+页脚」，**正文长表格在容器外**（可跨页）；39 条静态断言 + 18 份 HTML 基准有意重生成（`render.test.ts` 18/18 逐字节仍绿）。**尾巴**：归档 Python 镜像不同步（历史留档），`verify-trade-doc-fixtures.py` 自本项起只作历史对照（加 `--allow-divergence` 放行）；**视觉/分页验收待 build/e2e 与人工打印复核** | — | ✅（视觉待验） |
| C11 | SSRF DNS rebinding 加固 | `kaas_common/net.py` 新增**可选**解析后校验：`is_safe_crawl_url(url, resolve=True, resolver=...)` / `next_redirect_url(..., resolve=True)`；默认 `resolve=False` 保持两端行为不变（worker/Pyodide 无 socket），具备 socket 的运行时逐个 IP 判私网/回环/链路本地/保留/组播 + 169.254.169.254 + IPv4-mapped；解析不到不额外阻断 | — | ✅ 2026-10-21（7 条测试 `test_net_ssrf_dns.py`） |
| C12 | PDF 归档验收尾巴 | ✅ 2026-10-21 完成（22/23 类真 PDF 归档 + 两处 500/502 修复；`other` 因 Worker 1102 资源上限待重试）；按快照重出/页面级接线由既有 A4/A5 批次覆盖 | — | ✅ |
| C13 | outreach/webhook 收紧 | `GET` 回调是否收紧到 `POST`（将来实现 inbound 回写必须去掉 GET） | **用户 2026-10-21 授权默认：不做/保持现状**（webhook 仍 501 预留） | ✅（不做） |
| C14 | `product_tax_rates` 生产数据 | ✅ **用户 2026-10-21 明确：产品税率"使用时再设置"** ⇒ 不是发布阻塞项，也不预铺数据（生产 0 行时批量报价按设计不放行，属预期；用哪个产品就在 `设置 → 税务档案` 录哪个产品的进项税率/退税率）。核查记录：生产 0 行、head `202610200006`、teams=2、clause_templates=0（懒种子待首次 GET）；**未对生产写入任何税率数据** | — | ✅（按需设置） |
| C15 | PROBLEM_STATUS 2026-10-12「待排期 5 项」复核 | ①openapi 重生成 ~~作废~~（R6 已退役）；②`POST /admin/feature_flag` 请求体形状无门禁 → **不构成缺陷**（`body: dict` 刻意兼容"后端格式/前端格式"两种，前端已接线；R5 只比响应键集是既定取舍）；③契约错位 **已修**（`ExportProduct.params` 改为二维数组 + 补 `metric_count/invariant_count`；`ProductFormulasResponse.pricing_key[].ui_unit/ui_scale` 改 `.optional()`，类型与运行时一致）；④PATCH stage 409 ~~已过时~~（2026-10-18 口径：客户阶段只有 active/inactive，"流失"移订单，后端不再返 409）；⑤R2 密钥长度已并入 D2 | — | ✅ 2026-10-21 逐条判定完毕（③修，其余复核为过时/不修） |
| C16 | UNCERTAIN #15 ①②③ | ①旧进度报告/Spec System 报告：全仓无此文件 → **销项**；②归档口径维持「移动」；③不引链接检查工具，用一次性脚本校验（2026-10-21 已实测 11 份文件相对链接全通过） | — | ✅ 2026-10-21 关闭（UNCERTAIN #15 已标收尾裁决） |
| C17 | 侧栏 `adminOnly` 过滤口径统一 | **判定为两个不同概念、不统一代码**（已在两边注释钉死）：`Workstation.adminOnly` = **仅内部账号可见**（业务页 /research、/leadgen 等用它挡顾客）；`RouteGuard.adminOnly` = **平台运营**（internal + 管理员，2026-10-20 收紧）。菜单可见但守卫拦截属预期（守卫给出明确无权限页）；若要彻底消除需给契约加 `platformOnly` 并同步 py 镜像，收益低于风险 | — | ✅ 2026-10-21 决策（注释 + 文档口径） |
| C18 | MSW 长尾覆盖（72 条） | ✅ 2026-10-21：`longtail-handlers.ts` 补齐 72 条（intel/market/leadgen/outreach/research/shipments/ai-providers/spec-config/auth/报价/export-quote），handler **111→184**，未覆盖 **0**；门禁扫描 `src/mocks/**`、`MAX_MISSING=20` 默认失败（`--strict`=0）、P1 54 硬失败。mock 简化三处已注释（导入不解析文件/算价用示例值/scan-replied 不建询盘） | C5 | ✅ |
| C19 | **批量导入上传 UI** | ✅ 2026-10-21（G-10 已拍板放 v2 报价工作台顶部）：「产品报价」tab 顶部「批量导入表格」→ 模板下载/选产品参数/上传预检→**先预览**（逐行问题）→确认批量计算→摘要+结果表→导出 CSV；问题清单可复制/下载。复用 `useImportPreview`/`useImportCalculate`/`import-file.ts` 纯逻辑（未另写解析器），面板自历史版本恢复适配；MSW 补 5 种服务端 400。**只算不落库**（设计，无持久化端点）；组件 6 + 契约 1 + 纯函数 3 测试 | C7 | ✅ |
| C20 | 导入模板 4 端点仍只查注册表 | ✅ 2026-10-21：`/export-quote/import/template`、`/products/{key}/import-template`（说明+下载）、`/import/preview`、`/import/calculate` 全部改走 `_product_or_404_tenant`（与 `/formulas`/`/explain`/算价同口径：租户运行时产品优先、未命中回落注册表）；新增 5 条测试（租户 200 / 系统产品回归 / 跨团队 404 / 未知 404） | B5 | ✅ |
| C21 | 导出后自检 UI 依赖 PDF 文本抽取 | ✅ 2026-10-21（用户授权 pdf.js）：`pdfjs-dist@4.10.38` **动态 import**（首屏 0 影响；弃 v6 因 `Uint8Array.toHex` 兼容问题）；前端只抽事实（PDF 文本/图片绘制数、渲染 HTML 应出现文本、期望图片数），后端唯一裁决；面板三态（通过/阻断明细/解析失败不调后端），优先自检已归档 `render_pdf`；**真 pdfjs + 自造 PDF 在 Node 验证 pages/images/text 一致**；build 实测 `out/_next/static/media/pdf.worker.min.*.mjs` 已发射且生产 200。图片计数口径见 `TRADE_DOC_HARDENING.md §8.3` | A7 | ✅ |
| C22 | `file_objects.uq_file_current` 的 NULLS DISTINCT 缺口 | ✅ 2026-10-21 修复：迁移 `202610200005` drop+recreate 唯一索引并加 `NULLS NOT DISTINCT`（列顺序/谓词与 ORM 逐字一致，PG15+；本地 PG16/CI PG16/生产 Neon 18.6 均支持）；ORM `FileObject.uq_file_current` 同步；characterization 用例**反转**为回归守卫（同归属 `media_kind=NULL` 第二条 current 必被拒）。`alembic check` 无新操作、downgrade→upgrade 轮回通过；worker 有库 1229 passed/0 skipped。**发布注意**：迁移 docstring 含查重 SQL（存量重复 current 行会让建索引失败），跑前先查、有重复先人工置 `is_current=false`；drop+create 持表 SHARE 锁，写入毫秒级阻塞、读不受影响 | — | ✅ |

---

## D. 发布窗口（**等用户下令**；不为"到点自动执行"）

| # | 待办 | 现状/风险 | 状态 |
|---|---|---|---|
| D1 | 生产注入 `RESEND_API_KEY` | ✅ **2026-10-21 已完成**：已 `wrangler secret put RESEND_API_KEY --name kaas`（secret list 5 项确认）；生产用**仅发送权限** key（最小权限；用户另提供了全权限 key 供运维，未写入 worker）；key 验证：全权限 key `/domains` 200（`send.powervoy.com` verified），发送 key `/domains` 401 属预期 ⇒ 忘记密码邮件链路恢复 | — | ✅ |
| D2 | R2 新密钥替换 | ✅ **2026-10-21 已完成**：用户提供 R2 S3 凭据（Access Key 32 位 + Secret），已 `wrangler secret put S3_ACCESS_KEY/S3_SECRET_KEY --name kaas`（secret list 确认）；**真回环验证**：用新凭据对 `kaas-files` 做 presigned PUT/GET/DELETE = 200/200/204（测试对象 `_ops/selftest-*` 已删）。生产直传恢复，不再只走兜底；旧 token 可由用户随时在 R2 控制台吊销 | — | ✅ |
| D3 | Hyperdrive 生产缓存关闭（可选） | **用户已授权按推荐默认：保持开启**（2026-10-21）。预览仍 `caching.disabled=True` | ✅（默认保持） |
| D4 | 生产测试数据清理 | ✅ **2026-10-21 已用生产 DSN 跑 dry-run：匹配 0 行（可删 0、被引用跳过 0）⇒ 无测试数据残留，无需 `--apply`**；脚本 `scripts/cleanup_orphan_lead.py` 保留供以后用 | — | ✅（0 行） |
| D5 | 仓库可见性 | ✅ **用户 2026-10-21 决定：保持 public、不做密钥轮换/改密**（安全批按用户口径收窄为"归档数据公开评估"）；已发现 `docs/archive/stowage_raw.json` 等含真实姓名/企业微信 userid/成本价（P1）；**2026-10-21 已按用户批准脱敏**（stowage 身份+228 个成本/售价/利润单元格、17 份样例单据的姓名/电话/邮箱） | — | ✅（按用户决定） |
| D6 | 生产发布检查单 | ✅ **2026-10-21 已执行 7 次**（迁移至 `202610200006`；构建 out/277；版本 `dae596a5`→`cd15e9a5`→`9d497628`→`3a5ce179`→`3d324441`→`569a8b88`→`69765ef6`；冒烟每次全过；回滚版本 `77901aa1`；记录见 HANDOVER §0.4）。**尾巴**：冷启动 `coldstart-baseline.json` 仍 PENDING（需 Dashboard p50）；P4 观察期进行中 | 🔨（冷启动 1 尾） |
| D7 | preview ensure 对 Neon 423 重试 | ✅ 2026-10-21：`scripts/preview/preview_lib.py` 对 **423/429** 有限重试（指数退避 2/4/8/16s，上限 20s，`Retry-After` 优先，`PREVIEW_HTTP_RETRIES`/`PREVIEW_HTTP_BACKOFF` 可调；5xx 不重试避免重复创建）+ 5 条单测 `backend/worker/tests/test_preview_http_retry.py` | ✅ |

---

## E. UI/UX（P0/P1/P2 已完成）

- ✅ P0/P1/P2 已收口（2026-10-20，证据 `docs/ui-redesign/phase5/`、提交见 `git log -- docs/UI_UX_OPTIMIZATION_2026-10-20.md`）。
- 文档口径收尾（UI_UX 残留状态、UI_BACKEND_DEPENDENCIES 回填/横幅、e2e 28 条、旧设计稿归档）由 2026-10-21 文档批处理，登记在 §F-5。
- **前后端对齐专项（UI 重构后）见 §F-1**，这是本轮新增的最高优先专项。

---

## N. 本轮（2026-10-20 晚）审计新增项（**N 组**）

> 编号说明：**F1–F5 已被 2026-10-20 的"后端五项"占用**（见 `HANDOVER_2026-10-20_FINAL.md` §0.1），
> 为避免歧义，本轮新增项统一用 **N** 编号。

| # | 项 | 内容 | 状态 |
|---|---|---|---|
| N1 | **前后端对齐专项** | UI 重构后，前端调用 ↔ Worker 路由（`backend/worker/src/*.py`）↔ `shared/contracts` ↔ MSW handlers 全量比对；断点清单 + 修复 + 补测试（审计报告 `.tmp/align-report.md`：P0 断点 0、P1 三条、P2 五条） | ✅ 2026-10-21 分两批：**A**（/events 平台闸门、F4 stage 消费 + stage-log、路由守卫口径、写权限只读化）；**B**（MSW handlers **58→111**、`/oss/presign` 死代码删除、deployment_audit 如实 404 + 三态、`pnpm mocks:check` 防漂移门禁 P1 54/54） |
| N2 | 环境隔离 | `.env.local` 生产 DSN 已加警示注释 + 本地开发指引；本地 compose 栈拉起（postgres/redis/minio/backend）；**新 clone 必须先 `sync-shared.ps1`**（镜像 gitignored，缺 `kaas_common.preview` 会崩）；本地库为空库快径重建（**106 表 / head `202610200005`**） | ✅ 2026-10-20（本机） |
| N3 | H-2 用户复验 | 定价页刷新与注册（2026-10-19 已修复上线）等用户确认 | 🧭 需用户复验 |
| N4 | P8 联调状态核对 | ✅ 2026-10-21 核对：设计文档「P8 联调+E2E+订阅编码 ⏳」已过时 —— 联调=CI 三条全绿 + 预览链路实测；E2E=28 条（24+4）；订阅编码=契约 R2 PASS（27 工位 ts↔py）+ B3 真机开通生效。已在 `WORKSTATION_DESIGN.md` 段位状态表标 ✅ | — | ✅ |
| N5 | 文档口径收尾批 | PROBLEM_STATUS/UNCERTAIN/HANDOVER + UI 两份/PDF_ARCHIVAL/E2E/README/旧设计稿归档 | ✅ 2026-10-21 |
| N6 | **安全 4 项（最后做）** | **用户 2026-10-21 决定：①口令轮换/②管理员改密/④filter-repo 均不做（仓库保持 public）**；③归档数据公开评估**已完成并脱敏**（`docs/archive/stowage_raw.json` 身份+成本/售价/利润 228 格；`archive/.../sample_docs/*` 姓名/电话/邮箱；公司名保留） | — | ✅（按用户口径） |
| N7 | 分支/遗留清理 | convergence-aprime 打 tag 后删远端、删已合并分支、清 2 个 stash、POC 目录（`backend/worker/poc-*`） | ✅ 分支/stash；POC 目录 ⏳ |
| N8 | A′（SQL/DDL 内核同源） | 原并行线遗留，是否重激活为在评方案 | **用户 2026-10-21 授权默认：不做**（保持现状） | ✅（不做） |

---

## P. 全量 sweep 新发现（2026-10-21 二轮审计：全分支/全文档/全代码）

> 来源：`.tmp/handover-gap-branches.md`（0 条遗漏）、`.tmp/handover-gap-docs.md`（12 条）、`.tmp/handover-gap-code.md`（13 条 + 账本 drift）。
> 分支结论：56 ref / 131 reflog commit / 147 unreachable commit 全查，**无新待办**；旧项目线（v1/财务/发票）为历史，不承接。

| # | 项 | 内容/证据 | 前置 | 状态 |
|---|---|---|---|---|
| C23 | **shipments 工位被过期上线门禁隐藏** | ✅ 2026-10-21 修复（用户拍板"改为 active 恢复入口"）：`shared/contracts/workstations.ts` 与 `kaas_common/domain/workstations.py` 同步 `status:'active'` + 注释改为"原 2026-09-28 门禁前提不成立"；契约 **R2 PASS（27 工位 ts↔py）**、workstation/visibility 定向测试 79 passed | G-12 已拍板 | ✅ |
| C24 | 客户触达「产品手册附件」（P4 遗留） | ⏸ **用户 2026-10-21 拍板：暂不做**（等有真实手册素材/业务需要再做）；设计记录保留在 G-14 | — | ⏸ 暂缓 |
| C25 | 列表分页 UI（UI T7） | ✅ 2026-10-21：共享 `PaginationBar`（第 a–b 条/共 N 条、末页按真实条数、钳位不显示越界页、一屏不渲染）；orders 新增 `use-orders-list`（真分页，不再拿 100/页下拉源当列表）；events/audit 页码独立 state、筛选变化回第 1 页；三端点契约 `{items,total,page,page_size}` 均无 has_more。尾巴已销账（C39 audit-log 筛选后端已补） | — | ✅ |
| C26 | a11y 深水项 | ✅ 2026-10-21：外壳加「跳到主内容」skip-link（sr-only、focus 可见）+ `main#main tabIndex=-1`；RangeSelector 改 `radiogroup/aria-checked`（单选组语义，非 aria-pressed）；订单列配置最后一列 `aria-disabled` + 动作守卫（不再静默 no-op）；+3 组件测。**尾巴**：未做方向键 roving、全站无 axe 扫描 | — | ✅（点状） |
| C27 | QA 越权审计 7 条留证 + 修复 | ✅ 2026-10-21：审计（`QA_AUTHZ_AUDIT_2026-10-21.md`：3 已有闸门/4 缺失）+ 用户批准修全部 4 类 → 代码修复完成（AI 配置 admin-only、单证 team/owner 读、confirm/pdf 角色、公章读收紧 + R-1 PATCH；新增 105 测、worker 1523+12skip）；`QA_AUTHZ_VERIFY` v2 矩阵待 branch-audit 独立复核 | — | ✅（复核中） |
| A10 | 模板扩展清单 | ✅ 2026-10-21：`TRADE_DOC_TEMPLATES.md` 新增 §6.1「待扩展模板清单」——SASO/COC、船公司证明、出口许可证、CIQ、受益人声明，逐类给用途/关键字段/数据来源/优先级/A6 依赖（先做 beneficiary_decl + saso_coc），并修正旧架构指针。**模板本身未实现**（等 A6 真实样例校准，属设计依赖非欠账） | A6 样例 | ✅（清单已出） |
| N9 | = C23 的决策记录（避免两处编号漂移） | 见 C23/§G-12 | — | — |
| N10 | 事件流联通 `domain_events` | ⏸ **用户 2026-10-21 拍板：暂缓，等未来功能成熟稳定再实现**；设计承诺保留在 `WORKSTATION_DESIGN` 并已标注"未实现、有需求再做"，不再作为当前欠账 | — | ⏸ 暂缓 |
| N11 | DEPLOY §0.4 清理脚本缺失 | ✅ 2026-10-21：新建 `scripts/cleanup_orphan_lead.py`（`.tools/` 被 gitignore，改放 tracked 的 scripts/；DEPLOY §0.4 命令同步改为该路径）；**默认 dry-run**、`--apply` 才删、只匹配 3 个 E2E 前缀、被 `outreach_messages`/`cust_inquiries` 引用的行跳过并列出、事务+`--limit`、`KAAS_DSN` 环境变量读 DSN）；本机空库 dry-run 实测 0 行/exit 0 | — | ✅ |
| A14 | 包装类事实缺失（A12 的真落地前提） | 求值器已就绪，但 `extract_facts` 白名单**未抽包装信息**（如是否木包装）⇒ "无木包装不出声明" 只能得到 `TRIGGER_UNKNOWN_KEY` warning。**2026-10-21 用户指出：产品管理已有「包装方式+包装费」设计**（`spec.packaging[] = {id,name,method,is_default,mode,amount,ranges}`，引号/报价已用 `packaging_id` 选包装）⇒ **不新增字段**，A14 改为：facts 从「本单选中的包装 method（`packaging_id` → 产品 packaging；缺省取 `is_default`/首条；无配置=`none`）」抽 `packing_method`（原文）+ `packing_type`（枚举：`wood`/`bag`/`carton`/`none`/`mixed`/`other`，按 method 关键词归类）；触发词可写 `packing_type != 'wood'` 才出「非木包装声明」。需补：单证行怎么拿到 packaging（报价行有 `packaging_id`；单证若未带则回退产品默认并标注） | 产品 packaging 设计 | ⏳ |
| A11 | FACT_LABELS 未通过 API 返回 | ✅ 复核后**无需改**：`_fact_dict` 已逐条返回 `text_zh`/`text_en`（`ws_docs_hardening.py`），前端 `doc-facts-panel.tsx` 也按 `text_zh/text_en` 展示与编辑 ⇒ 全局 `FACT_LABELS` 只是内核兜底，不构成缺口 | — | ✅（复核销账） |
| A12 | `trigger_expr` 只存不求值 | ✅ 2026-10-21：新增 `kaas_common/trade_doc/trigger.py`（纯 stdlib 三层解析，**无 eval/exec**；禁函数调用/属性/下标/算术；长度/记号/深度上限）；GET doc-set 追加 `applicable/trigger_error`（不删项、无法求值按适用），PUT 坏表达式 422 不落库，lint 只 warning；内核 68 + API 7 测，worker 1316+12skip。**边界（→A14）**：facts 白名单无包装类事实，"wood_packing" 会以 `TRIGGER_UNKNOWN_KEY` 警告而非生效 | A7 | ✅（求值器就绪） |
| A13 | 翻译端点无入口 | ✅ 2026-10-21：单证加固新增第 6 tab「中译英」——字段从模板 manifest 推导（只取含汉字 text 字段，不硬编码）；`path=template` 明示 AI 不可用/原样返回/请人工翻译（绝不冒充），非草稿明示未写回；+16 测 | — | ✅ |
| C27b | 单证加固写端点的角色闸门 | ✅ 2026-10-21 用户拍板「限团队管理员/internal」→ 已修 5 条写端点（facts confirm / doc-set PUT / receipts POST / verify-export / doc-set/{type}/receipt），顺序 401→404→403→200，读端点不变；新增 35 条角色矩阵测试、worker 1558+12skip | — | ✅ |
| C28 | 询盘「渠道」枚举不一致（P2: 按提示填必 422） | ✅ 2026-10-21：前端自由输入改为**枚举下拉**（`INQUIRY_CHANNEL_OPTIONS` 与后端 `INQUIRY_CHANNEL` 逐字一致，中文标签→枚举值），只发合法值；typecheck 0 | — | ✅ |
| C29 | 「导入已有数据」是占位骨架却已挂页面 | ✅ 2026-10-21：已从「订单」「单证」两页移除入口按钮与弹窗（清理 state/import），组件保留并加注"后端批量导入接口就绪后再挂回"；**后端接口本身仍未实现**（实现时合并 C19 的导入 UI 决策） | C19 | ✅（入口已隐藏） |
| C30 | `/admin/archive-logs` 恒空 + 前端 0 调用 | ✅ 2026-10-21：端点由占位空列表改为真查询 `events_archive_log`（page/page_size/month、参数化、ORDER BY archived_at DESC；**不加租户过滤**以保留 `tenant_id='*'` 写入行）；管理台 gray-release 加归档记录卡片（三态 + 复用分页条）；后端 4 + 前端 3 测、真 PG 临时插行复验后精确删除。首次月度归档前为空属正常 | — | ✅ |
| C31 | 仪表盘指标恒 0 且「更新中」占位未实现 | ✅ 2026-10-21：契约 status=placeholder ⇒ 仪表盘页改为「改版中」占位（说明原指标无数据/对业务无用，引导去各工位），不再把"没有数据"渲染成 0；旧 3 条测无意义指标的 e2e 替换为占位断言（2 条，实测 passed）；后端 `/dashboard/summary` 零采集源的根治留待新业务口径（N 组另议） | — | ✅ |
| C32 | `/billing` 页面无入口 | ✅ 2026-10-21：侧栏底部账号弹窗加「升级订阅（即将上线）」→ `/billing`（桌面/移动共用）；权限口径与契约一致（`adminOnly:false / subscription:null`，页面本就对登录用户可达，**未加宽权限**）；页面仍是占位（不伪造计费），菜单如实标"即将上线" | — | ✅ |
| C39 | `/admin/audit-log` 筛选参数被后端静默忽略 | ✅ 2026-10-21：后端补参数化 WHERE（`action`/`actor_id`/`resource_type` 精确匹配，`since/until` 日期含当天边界），limit/offset 占位符顺延；新增 4 条回归测试钉 SQL 形状与参数顺序（含无筛选时 SQL 不变、customer 403 且不查库） | — | ✅ |
| C33 | 4 条 e2e skip 未登记 | ✅ 2026-10-21 **4/4 全部修复**（quotations 3 + events 1）：events 用 test-only override 强制 500 并断言错误 toast（finally 清理）；e2e 现 **27 passed + 0 skipped = 27**（C31 仪表盘 3 条旧测试换 2 条占位，净 −1）。原 3 条（quotations）：估算行断言「参考价 - 需人工确认」、`spec_not_supported` 断言「已废止」、手工录入数量=0 显示 zod 校验错误（顺带补上数量字段错误渲染，此前无效输入无提示）。e2e 现 **27 passed + 1 skipped = 28**。剩 1 条 `events.spec.ts:118`（需 test-only 强制 500 手段）仍 skip，已取证可修·中；归属 C6 尾巴 | — | ✅（3/4） |
| C34 | MSW 与 C8 漂移 | ✅ 2026-10-21：`leadOut()` 的 `demand_index/blank_index` 改**确定性示例值**（120/150/180/210/240 与 20/35/50/65，blank=差值）并注释"mock 示例，真实由后端 `chain.py:_lead_indices` 计算"；store 不再存这两个 API 层字段；覆盖 list/detail/patch/crawl 出口。**尾巴**：`longtail-handlers.ts:3090` 规格向导占位属同类简化，C18 账本"3 处简化"实为 ≥5 处（已在 C18 说明） | — | ✅ |
| C35 | 客户列表缺 stage 筛选 | ✅ 2026-10-21：工具栏加「客户阶段」下拉（全部/活跃/沉寂/已下单），请求透传后端 `stage`（展示值语义；非法值 422），queryKey 含 stage；空态区分"暂无客户"与"无符合筛选"并给清除入口；MSW 按同一语义过滤 | — | ✅ |
| C36 | 约 60 条后端路由前端 0 调用 | ✅ 2026-10-21：重扫 247 路由 vs 183 FE 路径 → 实际未接 **60**（6 条假阴性已人工核出），产出 **`docs/API_RESERVED_LIST.md`**：保留 18（CI/运维/REST/兼容）、后端先行待接 UI 24（C30/A13/A4 等）、可删候选 18（**需 owner 确认，不授权删除**）；并入 docs/README 索引 | — | ✅ |
| C37 | OSS 死分支 + 7 处过期注释 | ✅ 2026-10-21：删 `events/components/payload-renderer.tsx` 的 `_oss_key` 分支（state+JSX+3 import，118→81 行；依据：`/oss/presign` 后端 0 路由、mock 已删且有契约断言、调用方不依赖）；6 处"接口还没上线"注释按已实现路由（`ws_customer_records.py`/`ws_teams.py`/`ws_workstations.py`）更正；worker 测试注释同步 | — | ✅ |
| C38 | 文档口径全面刷新（10+ 处） | ✅ 2026-10-21（docs-b，11 文件）：worker README 三处误导（自动部署/cron/订阅未激活）按代码与发布记录更正；DEPLOY 迁移 head→`202610200005`、部署冻结→已发布+回滚指针、上线门禁/分支改名标历史；AGENTS 门禁数字→247/1233+12/616/28；HANDOVER 发布状态与 §0.2.3 全量更新；TRADE_DOC_HARDENING「施工中」→已完成；PRODUCT_CONFIG 标题/坏路径/已完成项修正；PROBLEM_STATUS Protected 矛盾统一为"Free 不升级→未开启"、断链修复；WORKSTATION_DESIGN 8 处旧状态按现行改（含 ratio 0.96）；integration README env.py 已修；根 `archive/` 入 docs/README 索引 + master-exec 批次补 README。`sync-shared -Check` PASS、相对链接自检全通过 | — | ✅ |
| N6+ | 安全范围扩展 | N6 ③ 只写 `docs/archive`，实测根 `archive/` 有 **45 个受控文件**（含 18 份真实业务样例），含公司名/电话/邮箱/报价；仓库 public ⇒ 评估范围扩到 `docs/archive/** + archive/**` | 安全批（最后） | ⏳ |
| C12+ | PDF 归档验收补 2 项 | ✅ 取证完成（2026-10-21）：生产库实测 `file_objects` **5 行 / render_pdf 0 / trade_doc_files(role=render_pdf) 0 / trade_doc_render_checks 0** ⇒ 生产尚无归档 PDF 样本（符合"未实际使用"预期）；`events_archive_log` 0 行（首次月度归档未到）。可执行验收步骤已由 docs-b 补入 `TRADE_DOC_PDF_ARCHIVAL.md` §五（体积/耗时测法 + 三处口径 SQL）；**真实 PDF 样本复核**待 P4 首单产生后执行（属人工复核，不是代码缺口） | 发布后样本 | ✅（步骤已补，样本待有） |
| C40 | CI 部署门禁 S5-d 假红（token 缺 Hyperdrive 读权限） | 2026-10-21 第十二次部署实测：`deploy.yml` 的「S5-d 防污染断言」调 `GET /hyperdrive/configs` → **403 Authentication error**（repo secret `CLOUDFLARE_API_TOKEN` / CI 系统 token 没有 Hyperdrive 读取权限）。从 script settings 读到的 R2/KV/Hyperdrive 绑定断言全部 ✔，**Worker 部署本身成功**（版本 `acaa6415-146e-4f84-8412-63c2e390e11b`），但该步让 run 变红并跳过冒烟。**2026-10-21 已修（用户授权走 ①）**：用 CF API 给 `kaas-ci-system-20261021`（id `44f3c314…`）补 `Hyperdrive Read`（**只加读权限**，token 值不变、不轮换；改前 policy 备份在 `~/.dsh/secrets/cf-ci-token-policy-backup-20261021-094212.json`）；重跑 deploy run `39528856290` **全绿**（S5-d + Smoke test 均 ✓），Worker `56692255-bc87-48a3-a541-23b230ad05d5`。断言未降级 | 用户已授权 | ✅ |


| G-9 | 历史密钥清理路径 | ✅ **已完成（2026-10-21 新裁决：清理）**：blob 级全历史扫描 → filter-repo 重写（1053→774 提交，force push）→ 旧 Neon 口令轮换 + 旧 Hyperdrive 同步 → 重写后 0 命中。**遗留：Notion token 需用户后台吊销**。执行记录见 [`STRUCTURAL_DEBT.md`](./STRUCTURAL_DEBT.md) §6.6 |
| G-10 | 冷启动根治路径 | ✅ **已定（2026-10-21）**：用户拍板**全量迁 TS Worker、不折中**。执行计划 [`OPTIMIZATION_PLAN_2026-10-21.md`](./OPTIMIZATION_PLAN_2026-10-21.md) W3（3–5 周四阶段）；框架/引擎移植方式待 D1/D2 拍板 |
| G-11 | 地理迁移停机窗口 | ✅ **已完成（2026-10-21）**：迁至 **aws-ap-southeast-1 新加坡**（Neon 免费档无东京），RTT 245→75ms；新 Hyperdrive `6830420703984a19a99a334afff6776e`、version `cd87aba7`；旧库保留 7 天后删除待确认（提醒已设 2026-10-28）。详见 [`PROD_PERFORMANCE_AUDIT_2026-10-21.md`](./PROD_PERFORMANCE_AUDIT_2026-10-21.md) §4.2 |
## F2. 内核侧待收敛（门面迁移发现的真源不一致，2026-10-21）

| # | 事项 | 现状与建议 |
|---|---|---|
| F2-1 | ORDER_NEXT 口径不一致 | `backend/worker/src/main.py` 中 producing 只允许 `shipped`；`kaas_common/workstation/state_machines.py` 还允许 `cancelled`。门面按 worker 实际行为镜像（409 allowed 是前端契约）。**建议内核侧收敛为单一真源**（先查前端契约再定哪边对） |
| F2-2 | 报价/单证引擎 Decimal vs TS double | 门面金额用 double+round2（Python Decimal ROUND_HALF_UP），分边界可能差 0.01；TS 只做协议层展示，**引擎计算不受影响**（引擎仍在 Python）。清理项：确认前端显示不依赖 TS 计算值 |

## G. 待用户拍板清单（集中登记；每条写明要定什么）

| # | 要定什么 | 选项与代价 |
|---|---|---|
| G-1 | **A5 单证编辑体验方案** | 行项批量编辑 / 条款模板 / 金额联动校验的范围与交互；需要过方案再施工 |
| G-2 | **A6 真实单据样例** | 能否提供真实 PI/CI/PL/提单确认件（脱敏亦可）？没有样例就无法做"最终验收标准" |
| G-3 | **B1 系统级产品** | 系统级产品继续走 Python 注册表（现状，改产品需发版），还是做成"平台级产品库"（运行时新增，需平台管理员 UI + 权限）。**已授权按推荐默认：保持现状** |
| G-4 | **A4 渲染方案** | ①渲染器白名单放开走 R2 直链（快、但签名 URL 生命周期与泄露面要定）②维持 base64（简单、单据体积大）③模板内嵌占位→服务端替换（改渲染链路，最彻底）。**已选 ①（2026-10-21）** |
| G-5 | C1 流失链路 / C3 CF agent / C4 自动沉寂 / C13 outreach 收紧 | 要不要做、优先级、口径。**已授权按推荐默认：不做/保持** |
| G-6 | D3 Hyperdrive 生产缓存 / D4 生产测试数据清理 | 是否执行（D4 执行当次还要再确认）。**D3 已授权保持开启；D4 发布当次再确认** |
| G-7 | 发布窗口下令 | **已下令（2026-10-21）：先发布窗口，安全项发布后做** |
| G-8 | 安全 4 项 | 用户裁"最后做"；做之前需确认是否轮换 Neon 口令（历史泄露）与仓库最终可见性；**范围扩到根 `archive/`（见 P 组 N6+）** |
| G-9 | `/tenant-product-status` 谁能操作 | 现状无角色校验（任意成员可停用产品）。选项：①保持现状（成员可管）②仅团队管理员/internal。**已授权按推荐默认：保持现状** |
| G-10 | 批量导入上传 UI 放哪 | hooks/helpers 齐备但无入口。选项：①v2 报价工作台顶部（与单条报价并列）②批量报价页步骤内 ③产品页"导入报价表"。**已授权按推荐默认：①** |
| G-11 | 主题切换入口 | **用户已拍板（2026-10-21）：不做**（跟随系统，`.dark` 令牌保留）。`UI_UX:395/675`；`next-themes`/ThemeProvider 0 命中 | ✅ 不做 |
| G-12 | shipments 工位是否故意隐藏 | **用户已拍板（2026-10-21）：改为 `active` 恢复入口** → C23 已执行（契约 ts↔py 同步、R2 PASS） | ✅ |
| G-13 | spec-config 工位去留 | **用户已拍板（2026-10-21）：保持现状**（`planned`、页面保留但暂不加入口），后续商业化再议 | ✅ 保持现状 |
| G-14 | C24 产品手册附件的**投递口径** | **用户 2026-10-21：暂不做**（等真实手册素材再议）；备选口径保留供以后用： ①**附件直发**（Resend `attachments` base64，单封限 ~10MB，客户能离线看，但影响送达率）②**短链下载**（上传 R2 → 签名/短期 URL 随邮件，体积友好，但客户需联网且链接会过期）③两者按大小自动切换。需你定口径与"手册内容"（产品图册/参数表/报价附件？） |
| G-15 | N10 `domain_events` 事件流 | **用户 2026-10-21：暂缓，等未来功能成熟稳定再实现**； 设计承诺（WORKSTATION_DESIGN Phase 6/§2.2）但 0 代码/迁移。要做需定：①发什么事件（业务域白名单）②消费者（审计/分析/外部订阅）③保留期与采样。**不做**则从设计文档移除该承诺（当前已标注为待决策） |
| G-16 | **询盘/订单模型重构 拍板** | ✅ **2026-10-22 全部拍板（D-1~D-17）**：强制关联询盘+DB约束+行内新建 / 报价转单无询盘必须补建或改direct / 线下补录状态如实选 / 三级渐进记录 / 不加补录字段 / 综合分 1·2·10 / 渠道加 phone·referral / 已确认行项变更需审批+留痕 / 询盘独立 `/inquiries` 工位 / 审批通知站内先行+邮件可选 / **指定审批人优先，否则团队管理员（`team_approvers`）** / 独立侧边栏「审批」/ 只做审批相关通知 / **报价必伴随报价单（自动镜像，编辑后同步）** / **人工登记定金到账→订单联动确认（CI/SC 不触发）** / **收款确认永远人工（不自动识别/对账）**。详见 [`OPTIMIZATION_PLAN_2026-10-22_INQUIRY_ORDER_MODEL.md`](./OPTIMIZATION_PLAN_2026-10-22_INQUIRY_ORDER_MODEL.md) §12.1；实施见 §Q | ✅ |

---

## Q. 询盘与订单模型重构（2026-10-22 设计定稿，见 §G-16）

> 设计基准 = [`OPTIMIZATION_PLAN_2026-10-22_INQUIRY_ORDER_MODEL.md`](./OPTIMIZATION_PLAN_2026-10-22_INQUIRY_ORDER_MODEL.md)（7 条问题全部带代码证据）。
> 用户指示：订单一等公民、询盘与订单独立、订单加来源（询盘转化/渠道直下单）、订单统计权重最大、报价链补编辑入口。
> **已拍板 D-1~D-13（2026-10-22，全部拍板完毕）**：询盘转化强制关联（DB CHECK）+ 行内新建；报价转单无询盘必须当场补建/关联或改 direct；
> 线下补录初始状态如实选；记录三级渐进（T1 必填/T2 后补/T3 可选）；不加「补录」字段；综合分 询盘1/报价2/订单10；
> 渠道加 phone/referral；已确认订单行项可改但需管理员审批+留痕（变更申请流程）；询盘独立 `/inquiries` 工位；
> 审批通知站内先行（邮件可选开关）、指定审批人优先否则团队管理员（`team_approvers`）、独立侧边栏「审批」、只做审批相关通知；
> 报价必伴随报价单（`quote_orders` 真源 + `trade_docs(quotation)` 自动镜像，编辑后同步）；
> 「已确认」由**人工登记定金到账**联动触发（部分到账也算，详情标注），收款确认永远人工（不自动识别/对账），人工确认保留，CI/SC 签发不触发。
> **M1 可开工。**

| # | 事项 | 内容与验收 | 前置 | 状态 |
|---|---|---|---|---|
| Q-M1 | 模型与内核 | 枚举（ORDER_SOURCE_TYPE、渠道去 quote 加 phone/referral）+ 迁移回填（orders.source_type/source_channel/inquiry_id，存量经 quote→inquiry 回填）；订单 items 增删改（内核+门面+契约）；`kaas_common/workstation/funnel.py` 统计；`GET /inquiries` 列表/详情（报价历史 1:N）；TS6 收口（门面 completed 联动询盘阶段） | G-16 拍板 | ✅ 2026-10-22：M1-a~M1-e 全部完成并 push（`fe9be1f` `1ba758d` `15c4fcab` `a0e33d91`）；worker 1685 passed + 12 skipped（3 env），orchestrator 266 passed，ts-worker 232 passed，sync-shared 一致 |
| Q-M1-f | 门面收口 | TS 门面对齐内核路由面：M1 新增 12 条端点显式透传（inquiries 详情 + item-change 4 + approvals + notifications 4 + team/approvers 2）；3 条 legacy inquiries 路由（列表/PATCH/stage-log）删门面 SQL 改透传；透传实现统一 `forwardKernelRequest`（proxy mount 与显式路由共用，intel/workstations 两份重复实现删除） | Q-M1 | ✅ 2026-10-22：ts-worker **267 passed / 24 文件**；route-surface **187 直接 0 缺 0 多**；openapi **273 = 187+86**；worker **1695+12skip**；orchestrator **266**；静态断言全 PASS |
| Q-M2-A | 前端 · 询盘工位 | `/inquiries` 列表（阶段/渠道/客户/时间/关键词筛选 + 报价数/订单数/最近报价）+ 详情（报价历史 1:N、来源链、stage 时间线）+ 编辑；导航契约双端登记（`orders` 前 order=25）；mocks + 页面/契约测试 | Q-M1-f | 🔨 施工中（导航契约已登记，页面/测试由 fe-inquiries 产出） |
| Q-M2-B | 前端 · 订单与报价 | `/orders` 来源列/筛选/详情来源链/货物行编辑/变更申请与审批入口；报价记录编辑入口（行项/条款/状态流转）；客户详情 UnlinkedRecords 改「直接下单」正常分类；POST /orders 门面改透传（否则来源字段静默丢弃） | Q-M2-A | ⏳ |
| Q-M2-C | 前端 · 审批与通知 | `/approvals` 审批中心三视图 + 通知铃铛/抽屉 + 团队页「审批设置」（指定审批人） | Q-M2-B | ⏳ |
| Q-M3 | 仪表盘 | 后端 ✅（`funnel.py` 权重 1/2/10 + `/dashboard/funnel` 时间窗询盘 cohort 口径 + 门面透传）；前端 ⏳ dashboard 落地漏斗/分渠道转化/直接下单/应收概览，`/dashboard/summary` 废弃三表混计数 | Q-M1-f | 🔨 后端完成，前端待做 |

---

---

## H. 销账规则

1. **完成一项**：本表状态改 `✅（日期 + 证据：提交/迁移/门禁数字）`，并在 `PROBLEM_STATUS_2026-10-11.md` 顶部「交接摘要」登记一条；**改代码必须同步文档并 push `main`**（`AGENTS.md` 规则 1）。
2. **新待办直接加本表**；不得再用"触发条件制"隐藏工作项；必须用户拍板的标 🧭 并写清拍什么。
3. 涉及授权策略/数据删除/生产操作（D3/D4/安全项）执行前一律走 `ask_user_question` 弹窗（`AGENTS.md` 规则 2）。
4. 每批提交前跑门禁（见根 `README.md` §4）；提交纪律见 `AGENTS.md` 规则 4（私有 `GIT_INDEX_FILE`、不碰他人改动）。


### TODO 注释反查索引（2026-10-21 S-3 治理）

> 生产源码 52 处 `TODO(TODO:<id>)` 注释锚点一览（排除 `tests/` / `__tests__/`；`docs/` 与 `*.md` 不在口径内）。
> `<id>` = 本表任务编号（A1=内容级版本、A3=字段缺失可发现、A8/A9=PDF 归档与指纹对账、C10=模板防劈页、C11=SSRF 加固、D7=preview 重试、F1–F5=后端五项）。
> 新增 TODO 注释必须带锚点：`TODO(TODO:<id>)`（对得上本表）或 `TODO(SD:S-x)`（对得上 STRUCTURAL_DEBT）。

#### `backend/kaas_common/net.py`

- L36 → **C11** — 2026-10-21 加固：新增**可选**的解析后校验

#### `backend/kaas_common/workstation/customer_serializers.py`

- L73 → **F4** — 询盘阶段（迁移 202610200003）：读不到 stage 的历史行按 status 退化

#### `backend/orchestrator/alembic/versions/202610200001_trade_doc_content_versions.py`

- L1 → **A1** — 单证内容级版本表 `trade_doc_content_versions`

#### `backend/orchestrator/alembic/versions/202610200002_trade_doc_render_checks.py`

- L1 → **A8/A9** — 单证指纹对账结果表 `trade_doc_render_checks`

#### `backend/orchestrator/alembic/versions/202610200003_inquiry_stage.py`

- L1 → **F4** — 询盘阶段落库：`cust_inquiries.stage` + `inquiry_stage_log`

#### `backend/orchestrator/app/db/workstation_links.py`

- L297 → **A8/A9** — 单证指纹对账结果（迁移 `202610200002`）。
- L330 → **A1** — 单证**内容**版本链（迁移 `202610200001`）。

#### `backend/orchestrator/app/db/workstation_models.py`

- L64 → **F4** — ─ 202610200003 询盘阶段落库：inquiry/quotation/order/shipme…
- L89 → **F4** — 询盘阶段变更日志（迁移 202610200003）。

#### `backend/worker/src/content_versions.py`

- L1 → **A1** — 单证内容级版本—— 每次 `raw_payload` 落库前留一版快照。

#### `backend/worker/src/inquiry_stage.py`

- L1 → **F4** — 询盘阶段状态机——落库 + 事件驱动，前端展示推导作兜底。

#### `backend/worker/src/main.py`

- L417 → **F3** — ─ 个人信息：只能改**本人**，边界写死在路由里 ─
- L3566 → **F5** — ─ 报价/订单 1:N 业务校验（口径 A：**允许**一报价多订单）─
- L3628 → **F4** — 询盘阶段：订单创建 → order（沿报价的 inquiry_id 传递；
- L3911 → **F4** — 询盘阶段：订单完结 → completed（沿报价传递；无报价来源则 no-op）
- L4370 → **A8/A9** — 定时对账结论：每页多一条查询，让列表能一眼标出「已变更」。
- L4785 → **A1** — 内容级版本：本次写入的整份 payload 留一版；仅当确实改了 payload 才记。
- L4801 → **F1** — 服务端签发自动上传（ 方案 A）：PATCH 触发 draft→issued 时若带 HTML

#### `backend/worker/src/quote_api.py`

- L1511 → **F4** — 询盘阶段：报价创建 → quotation（只前进，重复报价 no-op）
- L1534 → **F4** — 询盘阶段：自动建询盘 + 报价 → quotation（新建行就是 inquiry，前进一档；

#### `backend/worker/src/ws_crm_ext.py`

- L402 → **F4** — 询盘阶段：手动关闭 → closed（终态；重开不回收 stage，只回状态）
- L419 → **F4** — 询盘阶段变更历史：审计与"历史变更可查"的验收入口。

#### `backend/worker/src/ws_cron.py`

- L438 → **A8/A9** — 列表端点 join 它给出「已变更」标识。

#### `backend/worker/src/ws_docs_ext.py`

- L101 → **F1** — 可选 `html` / `pdf_name`（ 方案 A）：前端随签发提交**预览用的同一份 HTML*…
- L228 → **A1** — 内容级版本：重新带入上游快照也是一次内容变更，留版
- L328 → **A1** — 内容级版本：签发终版留一版（含 `_render` 指纹），issued 后不再产生版本
- L335 → **F1** — 服务端签发自动上传（ 方案 A）：同请求带 HTML ⇒ 出 PDF 并归档；
- L590 → **A1** — 内容级版本：翻译写回也是一次内容变更
- L602 → **A1** — ─ 单证内容级版本─

#### `backend/worker/src/ws_files.py`

- L817 → **F1** — （方案 A —— 签发请求带前端同一份 HTML，服务端出字节并归档）。

#### `backend/worker/src/ws_shipments.py`

- L304 → **F4** — 询盘阶段：出运创建 → shipment（沿订单→报价→询盘传递）

#### `frontend/src/app/(app)/trade-docs/components/doc-content-versions.tsx`

- L4 → **A1** — 单证内容版本面板

#### `frontend/src/app/(app)/trade-docs/components/doc-preview.tsx`

- L227 → **A3** — // 字段体检：模板引用了却渲染为空的字段。签名口径「缺失键渲染为空串」
- L361 → **A3** — 字段体检：把「会留空的地方」显式化。

#### `frontend/src/app/(app)/trade-docs/components/doc-render-check-badge.tsx`

- L10 → **A8/A9** — 单证列表里的「对账标识」。

#### `frontend/src/app/(app)/trade-docs/hooks/use-trade-docs.ts`

- L56 → **A8/A9** — 最近一次**定时对账**结论：`null` = 从未对账（不冒充"没问题"）。
- L167 → **F1** — 服务端签发自动上传的结果（ 方案 A；失败不回滚签发状态）
- L189 → **F1** — 签发时随请求提交的预览 HTML：服务端出 PDF 并归档
- L489 → **A1** — // ─ 单证内容级版本─

#### `frontend/src/app/(app)/trade-docs/page.tsx`

- L259 → **F1** — // 签发即上传（ 方案 A）：把**预览用的同一份 HTML** 随 PATCH 一起提交

#### `frontend/src/components/layout/sidebar.tsx`

- L200 → **F3** — // 个人信息编辑：显示名可改；密码单独折叠块（必须验旧密码）
- L308 → **F3** — 显示名（可编辑，）

#### `frontend/src/lib/trade-doc/render-check.ts`

- L2 → **A8/A9** — 「定时对账」结论 → 单证列表的一眼标识

#### `frontend/src/lib/trade-doc/render.ts`

- L11 → **C10** — 18 类差异（属模板结构演进，不是渲染回归；见 ）。
- L1548 → **A3** — // ─ 字段体检（「缺失字段可发现」）─

#### `frontend/src/mocks/handlers.ts`

- L261 → **A1** — // 单证**内容**版本链：mock 内存版，按 docId 惰性种子 2 版。
- L709 → **A8/A9** — 单证列表的最近一次对账结论。形状 = worker `main.py:4161-4180`。
- L3092 → **F3** — // 个人信息编辑：mock 必须**真的**改显示名 —— "保存成功但界面没变"
- L4716 → **F1** — // 签发 / 改内容（PATCH 可携带 html，由服务端出 PDF 并归档）
- L5045 → **A1** — // 内容级版本：重新带入上游快照也是一次内容变更，留版（ 同口径）
- L5084 → **A1** — // ─ 单证内容版本─
- L6103 → **F4** — // 询盘阶段：手动关闭 → closed（终态），并留一条阶段流水

---

## I. 更新历史

- **2026-10-22 全站 UI/UX 与结构审计（只读，未改代码）**：37 路由逐页审计 → 产出 `docs/UI_UX_AUDIT_2026-10-22.md`（P0 三个：群发无确认、research 删除无确认、spec-config 向导提交零反馈；P1 约 20；P2 约 90，均带 `文件:行号`）。根因裁定：组件无公共约束+门禁只查静态项+规范无正面模板+前端无契约层 → 方案四层（L1 模式契约/L2 共享原语/L3 门禁升级/L4 boy-scout 迁移），路线图 5 批见报告 §6。用户追加裁定：**行内展开改为默认不采用**（详情默认 DetailDrawer、编辑默认 Dialog/独立页，按数据量判断，非一刀切，8 处现存位置见报告 §1.5）。**待办（硬性）**：① 并行任务（产品图片上传、拖拽排序）完成后复跑审计并同步本报告；② 每批整改后更新条目状态；③ 收尾后把 L1 契约并入 `docs/UI_STANDARDS.md` 并更新 `docs/README.md` 索引。
- **2026-10-21 执行批 8（真实单据校准 + 条款库 W1 + 用户授权落地）**：用户提供 3 份真实单据 + Cloudflare/Resend/R2 凭据 → A6-1 PI/CI 双币种金额块（旧 18 金标零差异 + 2 份 FX 金标、facts 增 total_payable）、A6-2 合同 12 条双语条款数据层、A5-W1 团队级条款库（迁移 `202610200006` + CRUD + 懒种子 6 类 + 设置页与单证表单）、D1 Resend 注入（仅发送 key）、D2 R2 32 位密钥注入并真回环验证（PUT/GET/DELETE 200/200/204）、归档敏感数据脱敏（stowage 身份+228 成本/售价/利润格、17 份样例联系方式）。**门禁**：worker **1354+12skip** / orchestrator 247 / 前端 **719（74 files）** / e2e **27=27+0** / build out **277** / contracts·mocks·contrast·trade-doc:check·静态断言 PASS；生产部署 **`69765ef6`**（七次部署）。\n- **2026-10-21 执行批 7（收尾：A12/A13/C26/C30/C31/C33/C36 + 六次部署）**：A12 `trigger_expr` 受限求值器上线（doc-set applicable + lint warning；边界→A14 包装事实）、A13 中译英入口、C26 a11y（skip-link/main/aria）、C30 归档记录真实数据、C31 仪表盘占位、C33 4/4 e2e skip 全修、C36 `API_RESERVED_LIST.md`（60 条未接：保留 18/待接 24/可删候选 18）。**门禁**：worker **1316+12skip** / orchestrator 247 / 前端 **678（71 files）** / e2e **27=27+0** / build out **276** / contracts·mocks·contrast·静态断言 PASS；生产版本 **`569a8b88`**（六次部署）。\n- **2026-10-21 执行批 6（C33/C39 + 生产五次部署）**：3 条 quotations e2e skip 修复并补『数量』字段错误渲染；`/admin/audit-log` 后端补 action/actor_id/resource_type/since/until 参数化筛选（4 条回归测试）；worker **1237+12skip** / 前端 656 / e2e **27+1** / build out 277；生产部署 **`3d324441`**。\n- **2026-10-21 执行批 5（sweep 主体修复 + 生产四次部署）**：C19 批量导入 UI（v2 报价工作台）、C21 导出后自检 UI（pdf.js，前端只抽事实/后端裁决）、C25 列表分页（orders/events/audit）、C32 `/billing` 入口、C35 客户 stage 筛选、C33 取证、C34 MSW↔C8 漂移、C37 死代码/过期注释、C38 文档口径全面刷新（11 文件）、N11 清理脚本；**门禁**：worker 1233+12skip / orchestrator 247 / 前端 **656（67 files）** / e2e 28（24+4）/ build out **277** / contracts·mocks·contrast·静态断言全 PASS；生产部署版本 **`3a5ce179`**（冒烟含 pdf worker 资产 200）。\n- **2026-10-21 执行批 4（sweep 后首批修复）**：C23 shipments 恢复 `active`（契约 ts↔py 同步，R2 PASS 27 工位）、C28 询盘渠道改枚举下拉（只发后端合法值）、C29 订单/单证页移除占位「导入已有数据」入口（组件保留待后端接口）；G-11/12/13 用户拍板落盘。门禁：typecheck 0 / 定向 79 passed / contracts PASS / mocks 未覆盖 0。`n- **2026-10-21 二轮全量 sweep**：全分支 56 ref/131 reflog/147 unreachable → **0 条新待办**；全文档（含此前未读的 DEPLOY.md 337 行、ui-redesign 64 files、WORKSTATION_DESIGN 1011 行）→ **12 条新发现**；全代码 666 文件/439 命中 → **13 条新发现 + 账本 drift**。已登记 §P（C23–C38、A10–A13、N10/N11、N6+/C12+）与 §G（G-11 主题/G-12 shipments/G-13 spec-config），并更新 goal。\n- **2026-10-21 执行批 3（收口）**：A7-3 UI（事实确认/一致性/收款/单证清单/签发闸门，面板 9 + 契约 12 测）→ **A7 全部完成**；C2 文件存储收尾（doUpload/排序页面测试 + 7 条真 PG 用例）→ 发现并修复 **C22**（迁移 `202610200005` 唯一索引 `NULLS NOT DISTINCT`）；C10 18 模板防劈页（39 静态断言，视觉待 build/e2e 复核）；intel/channels 字段错位修复；C20 导入模板端点回落租户产品；C6 收口。**全量门禁**：worker 1217+12skip（有库 1229/0）、orchestrator 247、前端 616、e2e 28（24+4）、build `out/` 275 文件、contracts/mocks/静态断言全 PASS。
- **2026-10-21 执行批 2**：A7 内核/结构/API 全部落地（内核 87 测 + API 34 测 + `trade_doc_facts`）；B 组验收 → B1 销账（B4 P0 跨团队越权修复、B5 formulas/explain 回落、B6 订阅门同源）；C7 xlsx 导入（28 测）；C8 四源计数（18 测）；C5/C18 mock 持久化 + 长尾覆盖归零；C15 契约错位修复；C16/C17 关闭。新增 C19/C20/C21 与 G-10。门禁：worker **1212+5** / 前端 **535** / typecheck 0 / contracts PASS。
- **2026-10-21 执行批 1**：D7 重试落地（`1f0d76d7`）；A7 事实层表 `202610200004` + `TradeDocFact`（`32d5fe0c`）；对齐 A 批（/events 闸门、F4 stage 消费、路由守卫/写权限，`a92302eb`）+ 对齐 B 批（MSW 58→111、死代码、mocks:check 门禁）；新增 C17/C18。
- **2026-10-20 晚**：重写为唯一账本。—— 销账 A2（方案A）、B1 租户级、B2、B3、A8②③、A9、N2、N7；新增 A2-B、C7–C16、N1/N3–N8；D5 改回 ⏳（实测 public）；补安全 4 项与生产两个现网缺陷（D1/D2）；统一 e2e=28。
- 2026-10-20：用户裁决废止"触发条件制"，A/B/C/D 全部恢复活跃。
