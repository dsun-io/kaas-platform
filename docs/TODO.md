# 待办账本（唯一 · TODO）

> **更新：2026-10-20 晚（交接审计后重写；内容 = 文档原列项 + 审计新发现项）**
> 本文件是**唯一活跃待办账本**。状态以**代码/迁移/CI/实测证据**为准，与任何旧文档冲突时以本文件为准；
> 反之，完成一项必须在此销账（见 §H）。历史交接口径见
> [`HANDOVER_2026-10-20_FINAL.md`](./HANDOVER_2026-10-20_FINAL.md)（§0.2 停止点 / §0.3 新设备接手）、
> [`PROBLEM_STATUS_2026-10-11.md`](./PROBLEM_STATUS_2026-10-11.md)（顶部摘要）、[`UNCERTAIN.md`](./UNCERTAIN.md)（决策账本）。
>
> 状态图例：⏳ 待排期 · 🔨 施工中 · 🧭 待用户拍板（写明要拍什么）· ✅ 已完成（日期 + 证据）
> 本轮口径修订（2026-10-20，用户裁决）：**废止"触发条件制"**——真实工作项一律作为活跃待办登记，
> 由用户排期；只有"必须用户拍板"的才标 🧭，且必须写明拍什么、代价是什么。

---

## 0. 接手基线（2026-10-20 晚实测，换设备/换会话从这里开始）

| 项 | 状态 |
|---|---|
| 代码 | `main` @ `1216e75a`（工作树干净）；**远端只剩 `main`** |
| 迁移头 | `202610200004`（新增 `trade_doc_facts`；生产**尚未应用**，随发布窗口） |
| 门禁基线（本机 2026-10-21） | worker **1212 passed + 5 skipped**；orchestrator **247**；前端 `pnpm test` **535**（55 files）；typecheck 0 / lint 0 error / contracts R0–R6 PASS / `mocks:check` 未覆盖 0 / 静态断言 5 项 PASS（`check-worker-bundle` 本机 SKIP：uv 0.11.8 < 0.12.3，CI 会执行） |
| 前端 e2e | `playwright test --list` = **28 条**（24 passed + 4 skipped） |
| 仓库可见性 | **public**（匿名 `git ls-remote` 成功）；`gh` 本机未登录 ⇒ CI 只能用网页/无 token 接口核对 |
| 分支清理 | ✅ `archive/convergence-aprime-20261019` tag 已推；远端 `feat/convergence-aprime`、`feat/trade-doc-content-a` 已删；本地 `feat/trade-doc-templates`、`tech-stack-next16` 已删 |
| stash | ✅ 2 个历史 stash 已 drop，内容留在本地 `refs/archive/stash0-20261019-2334`、`refs/archive/stash1-20260926-1508` |
| 本机环境 | Docker 已起（postgres/redis/minio/backend）；`.env.local` 是**生产 DSN 存档**（已加警示注释 + 本地开发指引），不是本地开发配置 |
| 审计产物 | `.tmp/branch-audit.md`、`.tmp/doc-scan.md`、`.tmp/code-gap.md`、`.tmp/align-report.md` |

---

## A. 单证内容专项（用户点名方向）

| # | 待办 | 内容与验收 | 前置 | 状态 |
|---|---|---|---|---|
| A1 | 内容级版本 | 草稿期每次保存留历史（谁/何时/改了哪些字段），可回看/回滚 | — | ✅ 2026-10-20（迁移 `202610200001`；三端点 + 前端面板） |
| A2 | 服务端签发兜底（方案 A） | 服务端唯一实现 `ws_files.archive_rendered_pdf`；`POST /trade-docs/{id}/confirm` 与 `PATCH /trade-docs/{id}`（draft→issued）两入口接线；失败不回滚签发 | — | ✅ 2026-10-20（旧账本 ⏳ 系未销账） |
| **A2-B** | **方案 B：模板迁服务端** | 让"不带预览 HTML 的第三方客户端"也能出 PDF（模板现在在前端，是结构性限制）。需先定模板渲染归属（服务端 HTML 模板 vs 前端产物回传） | 方案讨论；与 A4/A7 渲染层同一片 | 🧭 需用户定要不要做（成本高、收益=第三方客户端/自动化） |
| A3 | 字段缺失可发现 | 渲染期 warning + 前端「缺失字段」标记 + 签发前清单 | — | ✅ 2026-10-20（`findBlankPlaceholders` + 预览状态栏；18 类模板无未登记占位符） |
| A4 | 图片素材库 + 去 base64 | **现状 ≈3/5**：公章租户库（`kaas_common/files/seal.py` + `tenant_company_seals`）、产品图引用库（`{file_id}` + `doc-photo-picker`）已做；**渲染输入仍 base64 内联**（`ws_files.py` `to_data_uri`，一张 PI ≈1.4MB），无独立素材库表 | 先定渲染方案（见 §G-4） | ⏳（3/5） |
| A5 | 单证编辑体验 | CI/PL 行项批量编辑、条款/备注模板、金额联动校验 | **方案需用户过目**（§G-1） | 🧭 |
| A6 | 模板逐字段对照真实单据 | 以真实 PI/CI/PL/提单确认件逐字段校准模板措辞/栏目/条款 | **需用户提供样例单据**（§G-2） | 🧭 |
| A7 | 单证加固 P1/P2 | **内核 ✅ + 结构 ✅ + API ✅，UI 施工中**：①事实层 + ②一致性引擎内核（`trade_doc/facts.py`/`consistency.py`/`equivalents.py`，87 条内核测试）；事实表 `trade_doc_facts`（迁移 `202610200004`）；**10 个 Worker 端点**（facts 读/确认/处置、consistency、lint、receipts、doc-set+回执、verify-export、confirm 闸门，34 条 API 测试）；剩余 = UI（task-13：事实确认/一致性/收款/清单/签发闸门）。设计与 12 条实现裁决见 [`TRADE_DOC_HARDENING.md`](./TRADE_DOC_HARDENING.md) | 无 | 🔨 进行中（UI 收尾） |
| A8 | PDF 归档尾巴 | ②③ 已完成（cron + 列表「已变更/模板已更新/待复核」标识）；①端到端真实跑一次 | ①需已部署环境 | ✅ ②③；①随发布后 P4 |
| A9 | 指纹批量对账定时调度 | cron `40 17 * * *` + `trade_doc_render_checks` 表 + 列表 `render_check` | — | ✅ 2026-10-20 |

### §A7 子项（施工清单；口径见 `UNCERTAIN.md` #17 + [`TRADE_DOC_HARDENING.md`](./TRADE_DOC_HARDENING.md) §4「实现裁决」）

- [x] A7-① **事实层（fact model）**：内核 + `trade_doc_facts` 表 + `GET/POST/PATCH facts` 端点完成（UI 待接）。
- [x] A7-② **一致性引擎**：全局等价词表 + 租户增量（`extra` 透传）；diff 三态；`GET /trade-docs/{id}/consistency` + `POST /lint` 已落地。
- [x] A7-③ **收款容差**：内核 `receipt_rules` + `GET/POST /trade-docs/{id}/receipts`（fx_rounding/short_paid/manual 落库）已落地（UI 待接）。
- [x] A7-④ **`not_by_us` 回执登记**：`GET/PUT /trade-docs/{id}/doc-set` + `POST .../doc-set/{type}/receipt`（pending→received/waived 状态机）已落地。
- [x] A7-⑤ **导出后自检**：`POST /trade-docs/{id}/verify-export`（默认阻断 422、`allow_override` 越过并落审计）+ confirm 闸门已落地；**UI 需 PDF 文本抽取（登记 C21）**。

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
| C1 | 「流失」拒绝文件链路 | 订单阶段新增 `lost`，拒绝文件链路迁订单阶段 | 🧭 业务设计 + 用户拍板 | 🧭 |
| C2 | 文件存储收尾 | 真实 DB 用例 / 公章 PI 视觉 QA / 排序过滤测试 / **`products/page.tsx` 的 `doUpload` 无自动化测试** | D2 后更完整 | ⏳ |
| C5 | 本地 mock 刷新丢数据 | ✅ 2026-10-21：`mocks/persistence.ts` 版本化键 `kaas-mock-v1:<集合>`（47 集合、只持久化被写操作碰过的集合、`?mock_reset=1` 重置、SSR/隐私模式 no-op、e2e 默认种子确定性）；字节类不落盘（避免 5MB 配额） | — | ✅ |
| C6 | e2e 数据层不稳根治 | 兜底路由掩盖缺口、无 per-test 重置；历史"假红/整轮数字作废"根因 | — | ⏳ |
| C7 | Excel xlsx 上传闭环 | ✅ 2026-10-21：纯 stdlib 读取器 `kaas_common/export_quote/xlsx.py`（zipfile+ElementTree；sharedStrings/inlineStr/富文本/公式缓存/日期 serial/合并单元格/行列与解压上限/坏文件），`preview`+`calculate` 接受 `.xlsx` 且与 CSV 共用字段映射；CSV 行为零变化、`.xls` 指路另存；服务端 xlsx **模板**保持 501（浏览器侧 exceljs 已生成，理由见报告）。**前端暂无批量导入上传 UI → 登记 C19**；28 条测试 | — | ✅（上传侧） |
| C8 | 四源计数端点 | ✅ 2026-10-21：`/leads` 与 `/leads/{id}` 的 `demand_index`/`blank_index` **真实回填**（`chain.py` 新增 `_lead_indices`：2 条参数化 SQL、无 N+1；需求量取 `intel_demand_index` 最新月份合计、地区归一化 + 国家别名兜底；已开发量=抓取+调研+触达(sent)+成交，成交按 F4 `stage∈order/shipment/completed` 或非 cancelled 订单链；无需求行 ⇒ 两字段仍 null 不拿 0 冒充）。**按设计不加独立端点/不改排序**（§6.8 只要求字段回填）。18 条测试 | — | ✅ 2026-10-21 |
| C9 | 诊断端点收敛 | `_r2_debug` / `fx-rates/_debug` 暴露面收敛 | — | ✅ 2026-10-21 复核：两个端点**已有** `is_admin_role` 闸门（`ws_files.py` r2_debug / `ws_extras.py` fx_provider_debug，B0-6 收敛，普通用户 403），无需改动 |
| C10 | 18 模板签章区孤行 | ✅ 2026-10-21：`@media print` 加 `.keep-together { page-break-inside: avoid; break-inside: avoid; }`；18/18 模板**各恰好一个容器**包住「签章+公章+声明/紧邻条款/备注+页脚」，**正文长表格在容器外**（可跨页）；39 条静态断言 + 18 份 HTML 基准有意重生成（`render.test.ts` 18/18 逐字节仍绿）。**尾巴**：归档 Python 镜像不同步（历史留档），`verify-trade-doc-fixtures.py` 自本项起只作历史对照（加 `--allow-divergence` 放行）；**视觉/分页验收待 build/e2e 与人工打印复核** | — | ✅（视觉待验） |
| C11 | SSRF DNS rebinding 加固 | `kaas_common/net.py` 新增**可选**解析后校验：`is_safe_crawl_url(url, resolve=True, resolver=...)` / `next_redirect_url(..., resolve=True)`；默认 `resolve=False` 保持两端行为不变（worker/Pyodide 无 socket），具备 socket 的运行时逐个 IP 判私网/回环/链路本地/保留/组播 + 169.254.169.254 + IPv4-mapped；解析不到不额外阻断 | — | ✅ 2026-10-21（7 条测试 `test_net_ssrf_dns.py`） |
| C12 | PDF 归档验收尾巴 | 真实 18 类单证端到端未跑、页面级接线仅 typecheck 保驾、按快照重出未做 | 随发布后 | ⏳ |
| C13 | outreach/webhook 收紧 | `GET` 回调是否收紧到 `POST`（将来实现 inbound 回写必须去掉 GET） | 产品决策 | 🧭 |
| C14 | `product_tax_rates` 生产数据 | 生产 0 条则批量报价不放行 | 发布窗口 | ⏳（D 组同批） |
| C15 | PROBLEM_STATUS 2026-10-12「待排期 5 项」复核 | ①openapi 重生成 ~~作废~~（R6 已退役）；②`POST /admin/feature_flag` 请求体形状无门禁 → **不构成缺陷**（`body: dict` 刻意兼容"后端格式/前端格式"两种，前端已接线；R5 只比响应键集是既定取舍）；③契约错位 **已修**（`ExportProduct.params` 改为二维数组 + 补 `metric_count/invariant_count`；`ProductFormulasResponse.pricing_key[].ui_unit/ui_scale` 改 `.optional()`，类型与运行时一致）；④PATCH stage 409 ~~已过时~~（2026-10-18 口径：客户阶段只有 active/inactive，"流失"移订单，后端不再返 409）；⑤R2 密钥长度已并入 D2 | — | ✅ 2026-10-21 逐条判定完毕（③修，其余复核为过时/不修） |
| C16 | UNCERTAIN #15 ①②③ | ①旧进度报告/Spec System 报告：全仓无此文件 → **销项**；②归档口径维持「移动」；③不引链接检查工具，用一次性脚本校验（2026-10-21 已实测 11 份文件相对链接全通过） | — | ✅ 2026-10-21 关闭（UNCERTAIN #15 已标收尾裁决） |
| C17 | 侧栏 `adminOnly` 过滤口径统一 | **判定为两个不同概念、不统一代码**（已在两边注释钉死）：`Workstation.adminOnly` = **仅内部账号可见**（业务页 /research、/leadgen 等用它挡顾客）；`RouteGuard.adminOnly` = **平台运营**（internal + 管理员，2026-10-20 收紧）。菜单可见但守卫拦截属预期（守卫给出明确无权限页）；若要彻底消除需给契约加 `platformOnly` 并同步 py 镜像，收益低于风险 | — | ✅ 2026-10-21 决策（注释 + 文档口径） |
| C18 | MSW 长尾覆盖（72 条） | ✅ 2026-10-21：`longtail-handlers.ts` 补齐 72 条（intel/market/leadgen/outreach/research/shipments/ai-providers/spec-config/auth/报价/export-quote），handler **111→184**，未覆盖 **0**；门禁扫描 `src/mocks/**`、`MAX_MISSING=20` 默认失败（`--strict`=0）、P1 54 硬失败。mock 简化三处已注释（导入不解析文件/算价用示例值/scan-replied 不建询盘） | C5 | ✅ |
| C19 | **批量导入上传 UI** | hooks（`useImportPreview`/`useImportCalculate`/`useDownloadTemplate`）与 `import-file.ts` 齐备，但**没有任何页面组件消费** ⇒ 用户拿不到「下载模板→填→上传」入口（xlsx/CSV 后端都已就绪）。建议接进 v2 报价工作台/批量报价页（放置位置属产品交互 → 待拍板 §G-10） | C7 | 🧭 待定入口位置 |
| C20 | 导入模板 4 端点仍只查注册表 | ✅ 2026-10-21：`/export-quote/import/template`、`/products/{key}/import-template`（说明+下载）、`/import/preview`、`/import/calculate` 全部改走 `_product_or_404_tenant`（与 `/formulas`/`/explain`/算价同口径：租户运行时产品优先、未命中回落注册表）；新增 5 条测试（租户 200 / 系统产品回归 / 跨团队 404 / 未知 404） | B5 | ✅ |
| C21 | 导出后自检 UI 依赖 PDF 文本抽取 | `verify-export` 后端已可用（文本⊆PDF、图片计数），但前端需要拿到 PDF 文本；方案：pdf.js 解析已生成 PDF，或服务端渲染时抽取 —— 需拍板（涉及新增依赖/包体） | A7 | ⏳ 待定方案 |

---

## D. 发布窗口（**等用户下令**；不为"到点自动执行"）

| # | 待办 | 现状/风险 | 状态 |
|---|---|---|---|
| D1 | 生产注入 `RESEND_API_KEY` | 生产 secrets 只有 4 个 ⇒ **"忘记密码"邮件静默不发**。值取 repo secret `RESEND_API_KEY_PROD` | ⏳ 等发布窗口 |
| D2 | R2 新密钥替换 | **生产 `S3_ACCESS_KEY` 只有 13 位（R2 要求 32）⇒ 生产直传当前不可用**（有 R2 binding/服务端代理兜底）。发布窗口 `wrangler secret put`，发布后到 R2 dashboard 删旧 token | ⏳ 等发布窗口 |
| D3 | Hyperdrive 生产缓存关闭（可选） | 预览已 `caching.disabled=True`；生产现状保持开启，是否同改**需单独批准** | 🧭 |
| D4 | 生产测试数据清理 | 含流失拒绝文件历史；**执行当次需用户确认** | 🧭 |
| D5 | 仓库可见性 | 现 **public**；用户曾裁"收尾后转 private"，private 期间 Actions 不可用（门禁改本地）。与安全项同批（§F-6） | ⏳ 最后做 |
| D6 | 生产发布检查单 | `HANDOVER §5` 全流程：迁移 `202610200001/2/3` → secrets → 构建 → `pywrangler deploy` → 冒烟 → 冷启动基线（≤2,950ms）→ 留痕 → P4 观察期 | ⏳ 等用户下令 |
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
| N2 | 环境隔离 | `.env.local` 生产 DSN 已加警示注释 + 本地开发指引；本地 compose 栈拉起（postgres/redis/minio/backend）；**新 clone 必须先 `sync-shared.ps1`**（镜像 gitignored，缺 `kaas_common.preview` 会崩）；本地库为空库快径重建（105 表 / head `202610200003`） | ✅ 2026-10-20（本机） |
| N3 | H-2 用户复验 | 定价页刷新与注册（2026-10-19 已修复上线）等用户确认 | 🧭 需用户复验 |
| N4 | P8 联调状态核对 | ✅ 2026-10-21 核对：设计文档「P8 联调+E2E+订阅编码 ⏳」已过时 —— 联调=CI 三条全绿 + 预览链路实测；E2E=28 条（24+4）；订阅编码=契约 R2 PASS（27 工位 ts↔py）+ B3 真机开通生效。已在 `WORKSTATION_DESIGN.md` 段位状态表标 ✅ | — | ✅ |
| N5 | 文档口径收尾批 | PROBLEM_STATUS/UNCERTAIN/HANDOVER + UI 两份/PDF_ARCHIVAL/E2E/README/旧设计稿归档 | ✅ 2026-10-21 |
| N6 | **安全 4 项（最后做）** | ① Neon 生产口令轮换（git 历史明文与现用口令相同，仓库现 public）②管理员 `david@powervoy.com` 改密 ③评估 `docs/archive` 业务数据能否公开 ④可选 `git filter-repo` 清历史 | ⏳ 用户裁"最后再做" |
| N7 | 分支/遗留清理 | convergence-aprime 打 tag 后删远端、删已合并分支、清 2 个 stash、POC 目录（`backend/worker/poc-*`） | ✅ 分支/stash；POC 目录 ⏳ |
| N8 | A′（SQL/DDL 内核同源） | 原并行线遗留，是否重激活为在评方案 | 🧭 待拍板 |

---

## G. 待用户拍板清单（集中登记；每条写明要定什么）

| # | 要定什么 | 选项与代价 |
|---|---|---|
| G-1 | **A5 单证编辑体验方案** | 行项批量编辑 / 条款模板 / 金额联动校验的范围与交互；需要过方案再施工 |
| G-2 | **A6 真实单据样例** | 能否提供真实 PI/CI/PL/提单确认件（脱敏亦可）？没有样例就无法做"最终验收标准" |
| G-3 | **B1 系统级产品** | 系统级产品继续走 Python 注册表（现状，改产品需发版），还是做成"平台级产品库"（运行时新增，需平台管理员 UI + 权限） |
| G-4 | **A4 渲染方案** | ①渲染器白名单放开走 R2 直链（快、但签名 URL 生命周期与泄露面要定）②维持 base64（简单、单据体积大）③模板内嵌占位→服务端替换（改渲染链路，最彻底） |
| G-5 | C1 流失链路 / C3 CF agent / C4 自动沉寂 / C13 outreach 收紧 | 要不要做、优先级、口径 |
| G-6 | D3 Hyperdrive 生产缓存 / D4 生产测试数据清理 | 是否执行（D4 执行当次还要再确认） |
| G-7 | 发布窗口下令 | D 组是否现在做 |
| G-8 | 安全 4 项 | 用户已裁"最后做"；做之前需确认是否轮换 Neon 口令（历史泄露）与仓库最终可见性 |
| G-9 | `/tenant-product-status` 谁能操作 | 现状无角色校验（任意成员可停用产品）。选项：①保持现状（成员可管）②仅团队管理员/internal。影响租户自助能力与误操作风险 |
| G-10 | 批量导入上传 UI 放哪 | hooks/helpers 齐备但无入口。选项：①v2 报价工作台顶部（与单条报价并列）②批量报价页步骤内 ③产品页"导入报价表"。影响用户动线；按你选的落 C19 |

---

## H. 销账规则

1. **完成一项**：本表状态改 `✅（日期 + 证据：提交/迁移/门禁数字）`，并在 `PROBLEM_STATUS_2026-10-11.md` 顶部「交接摘要」登记一条；**改代码必须同步文档并 push `main`**（`AGENTS.md` 规则 1）。
2. **新待办直接加本表**；不得再用"触发条件制"隐藏工作项；必须用户拍板的标 🧭 并写清拍什么。
3. 涉及授权策略/数据删除/生产操作（D3/D4/安全项）执行前一律走 `ask_user_question` 弹窗（`AGENTS.md` 规则 2）。
4. 每批提交前跑门禁（见根 `README.md` §4）；提交纪律见 `AGENTS.md` 规则 4（私有 `GIT_INDEX_FILE`、不碰他人改动）。

---

## I. 更新历史

- **2026-10-21 执行批 2**：A7 内核/结构/API 全部落地（内核 87 测 + API 34 测 + `trade_doc_facts`）；B 组验收 → B1 销账（B4 P0 跨团队越权修复、B5 formulas/explain 回落、B6 订阅门同源）；C7 xlsx 导入（28 测）；C8 四源计数（18 测）；C5/C18 mock 持久化 + 长尾覆盖归零；C15 契约错位修复；C16/C17 关闭。新增 C19/C20/C21 与 G-10。门禁：worker **1212+5** / 前端 **535** / typecheck 0 / contracts PASS。
- **2026-10-21 执行批 1**：D7 重试落地（`1f0d76d7`）；A7 事实层表 `202610200004` + `TradeDocFact`（`32d5fe0c`）；对齐 A 批（/events 闸门、F4 stage 消费、路由守卫/写权限，`a92302eb`）+ 对齐 B 批（MSW 58→111、死代码、mocks:check 门禁）；新增 C17/C18。
- **2026-10-20 晚**：重写为唯一账本。—— 销账 A2（方案A）、B1 租户级、B2、B3、A8②③、A9、N2、N7；新增 A2-B、C7–C16、N1/N3–N8；D5 改回 ⏳（实测 public）；补安全 4 项与生产两个现网缺陷（D1/D2）；统一 e2e=28。
- 2026-10-20：用户裁决废止"触发条件制"，A/B/C/D 全部恢复活跃。
