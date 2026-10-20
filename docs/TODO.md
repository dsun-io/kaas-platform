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
| 代码 | `main` @ `213f87c1`（本轮 21 个提交；工作树干净）；**远端只剩 `main`** |
| 迁移头 | `202610200005`（`trade_doc_facts` + 文件当前版本唯一索引 `NULLS NOT DISTINCT`）；**发布窗口已把生产从 `202610180010` 升到 `202610200005`（2026-10-21，已建 pre-release 快照）** |
| 门禁基线（本机 2026-10-21 收口实测，工作区静止） | worker **1217 passed + 12 skipped**（无库；12 条 db/integration 档按既有约定 skip；有 docker PG 时实测 **1229 passed / 0 skipped**）；orchestrator **247**；前端 `pnpm test` **616 passed（60 files）**；typecheck 0 / lint 0 error / contracts R0–R6 PASS / `mocks:check` 未覆盖 **0** / e2e **28 条（24 passed + 4 skipped）** / `NEXT_EXPORT=1 pnpm build` → `out/` **275 文件** / 静态断言 5 项 PASS（`check-worker-bundle` 本机 SKIP：uv 0.11.8 < 0.12.3，CI 会执行） |
| 前端 e2e | `playwright test --list` = **28 条**（24 passed + 4 skipped） |
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
| A5 | 单证编辑体验 | CI/PL 行项批量编辑、条款/备注模板、金额联动校验 | **方案需用户过目**（§G-1） | 🧭 |
| A6 | 模板逐字段对照真实单据 | 以真实 PI/CI/PL/提单确认件逐字段校准模板措辞/栏目/条款 | **需用户提供样例单据**（§G-2） | 🧭 |
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
| C1 | 「流失」拒绝文件链路 | 订单阶段新增 `lost`，拒绝文件链路迁订单阶段 | 🧭 业务设计 + 用户拍板 | 🧭 |
| C2 | 文件存储收尾 | 真实 DB 用例 / 公章 PI 视觉 QA / 排序过滤测试 / **`products/page.tsx` 的 `doUpload` 无自动化测试** | D2 后更完整 | ⏳ |
| C5 | 本地 mock 刷新丢数据 | ✅ 2026-10-21：`mocks/persistence.ts` 版本化键 `kaas-mock-v1:<集合>`（47 集合、只持久化被写操作碰过的集合、`?mock_reset=1` 重置、SSR/隐私模式 no-op、e2e 默认种子确定性）；字节类不落盘（避免 5MB 配额） | — | ✅ |
| C6 | e2e 数据层不稳根治 | ✅ 2026-10-21 收口（根因逐项治理，非"数字变好"）：①**误报源**：MSW 长尾未覆盖时请求直连网络/500 → 兜底路由掩盖（现覆盖 **0 缺口**，`mocks:check` 门禁）；②**数据不确定**：mock store 改 localStorage 持久化后补"e2e 默认种子 + 新 context 空 storage + `?mock_reset=1`"三保险；③**环境争用**：playwright 已固定 workers=2、NO_PROXY、mock baseURL 指回页面源、`NODE_OPTIONS=2048MB`；④**单测 flake**：xlsx 模板用例 `testTimeout` 15s 已放宽，全量默认并发本次 60 files/616 tests 22s 全绿。**已知限制**：本机多 agent 同时跑门禁时仍可能 worker OOM（资源争用，非产品信号）；CI 两核并发天然受限。**测量纪律**：任何 e2e/构建数字只在工作区静止时作数 | — | ✅ |
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
| C22 | `file_objects.uq_file_current` 的 NULLS DISTINCT 缺口 | ✅ 2026-10-21 修复：迁移 `202610200005` drop+recreate 唯一索引并加 `NULLS NOT DISTINCT`（列顺序/谓词与 ORM 逐字一致，PG15+；本地 PG16/CI PG16/生产 Neon 18.6 均支持）；ORM `FileObject.uq_file_current` 同步；characterization 用例**反转**为回归守卫（同归属 `media_kind=NULL` 第二条 current 必被拒）。`alembic check` 无新操作、downgrade→upgrade 轮回通过；worker 有库 1229 passed/0 skipped。**发布注意**：迁移 docstring 含查重 SQL（存量重复 current 行会让建索引失败），跑前先查、有重复先人工置 `is_current=false`；drop+create 持表 SHARE 锁，写入毫秒级阻塞、读不受影响 | — | ✅ |

---

## D. 发布窗口（**等用户下令**；不为"到点自动执行"）

| # | 待办 | 现状/风险 | 状态 |
|---|---|---|---|
| D1 | 生产注入 `RESEND_API_KEY` | **发布已上线但仍未注入**（2026-10-21 部署后实测 secrets = `ADMIN_SETUP_TOKEN`/`JWT_SECRET`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`）⇒ **忘记密码邮件仍静默不发**。为**用户动作**：值取 repo secret `RESEND_API_KEY_PROD`，在 Cloudflare Dashboard 或 `cd backend/worker; npx wrangler secret put RESEND_API_KEY --name kaas` 设置（无需重新部署） | ⏳ 待用户注入 |
| D2 | R2 新密钥替换 | **生产 `S3_ACCESS_KEY` 只有 13 位（R2 要求 32）⇒ 生产直传当前不可用**（R2 binding/服务端代理兜底可用）。为**用户动作**：R2 dashboard → Manage R2 API Tokens 建 32 位密钥 → `wrangler secret put S3_ACCESS_KEY/S3_SECRET_KEY --name kaas` → 删旧 token | ⏳ 待用户动作 |
| D3 | Hyperdrive 生产缓存关闭（可选） | **用户已授权按推荐默认：保持开启**（2026-10-21）。预览仍 `caching.disabled=True` | ✅（默认保持） |
| D4 | 生产测试数据清理 | 发布已执行（2026-10-21），**清理未做**（需执行当次确认，用户尚未确认）；含流失拒绝文件历史 | 🧭 待当次确认 |
| D5 | 仓库可见性 | 现 **public**；用户曾裁"收尾后转 private"，private 期间 Actions 不可用（门禁改本地）。与安全项同批（§F-6） | ⏳ 最后做 |
| D6 | 生产发布检查单 | ✅ **2026-10-21 已执行**（迁移 6 条 → 生产 `202610200005`；构建 out/275；pywrangler 部署版本 `dae596a5`；冒烟 5 项全过；回滚版本 `77901aa1`；记录见 HANDOVER §0.4）。**尾巴**：D1/D2 secrets 待用户；冷启动 `coldstart-baseline.json` 仍 PENDING（pywrangler Startup 3386ms > 2950 验收线，需 Dashboard p50）；P4 观察期从这里开始 | 🔨 主体完成（2 项尾巴） |
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
| N6 | **安全 4 项（最后做）** | ① Neon 生产口令轮换（git 历史明文与现用口令相同，仓库现 public）②管理员 `david@powervoy.com` 改密 ③评估 `docs/archive` 业务数据能否公开 ④可选 `git filter-repo` 清历史 | ⏳ 用户裁"最后再做" |
| N7 | 分支/遗留清理 | convergence-aprime 打 tag 后删远端、删已合并分支、清 2 个 stash、POC 目录（`backend/worker/poc-*`） | ✅ 分支/stash；POC 目录 ⏳ |
| N8 | A′（SQL/DDL 内核同源） | 原并行线遗留，是否重激活为在评方案 | 🧭 待拍板 |

---

## P. 全量 sweep 新发现（2026-10-21 二轮审计：全分支/全文档/全代码）

> 来源：`.tmp/handover-gap-branches.md`（0 条遗漏）、`.tmp/handover-gap-docs.md`（12 条）、`.tmp/handover-gap-code.md`（13 条 + 账本 drift）。
> 分支结论：56 ref / 131 reflog commit / 147 unreachable commit 全查，**无新待办**；旧项目线（v1/财务/发票）为历史，不承接。

| # | 项 | 内容/证据 | 前置 | 状态 |
|---|---|---|---|---|
| C23 | **shipments 工位被过期上线门禁隐藏** | ✅ 2026-10-21 修复（用户拍板"改为 active 恢复入口"）：`shared/contracts/workstations.ts` 与 `kaas_common/domain/workstations.py` 同步 `status:'active'` + 注释改为"原 2026-09-28 门禁前提不成立"；契约 **R2 PASS（27 工位 ts↔py）**、workstation/visibility 定向测试 79 passed | G-12 已拍板 | ✅ |
| C24 | 客户触达「产品手册附件」（P4 遗留） | 设计：PDF 浏览器生成→R2→随邮件发；代码仅 `chain.py:221` 注释，无实现 | A6/R2 就绪 | ⏳ |
| C25 | 列表分页 UI（UI T7） | 后端 orders/events 已支持 `page/page_size`，前端 orders/events/audit 无翻页（仅 intel shipments 表有） | — | ⏳ |
| C26 | a11y 深水项 | `UI_UX:256-262` A4 `aria-disabled`、A9 `aria-pressed`、A10 skip-link + `main id`（代码 skip-link 0 命中） | — | ⏳ |
| C27 | QA 越权审计 7 条留证 | `QA_TEST_ACCOUNTS.md:71-82` 有清单无执行结论；随发布后 P4 跑并留证 | 发布后 | ⏳ |
| A10 | 模板扩展清单 | `TRADE_DOC_TEMPLATES.md:186-188`：SASO/COC、船公司证明、出口许可证、CIQ、受益人声明「待扩展」 | A6 | ⏳ |
| N9 | = C23 的决策记录（避免两处编号漂移） | 见 C23/§G-12 | — | — |
| N10 | 事件流联通 `domain_events` | `WORKSTATION_DESIGN.md:88/870/962` 设计承诺（Phase 6/§2.2）；代码/迁移 0 命中 | 产品决策 | ⏳ |
| N11 | DEPLOY §0.4 清理脚本缺失 | ✅ 2026-10-21：新建 `.tools/cleanup_orphan_lead.py`（DEPLOY 引用的路径；**默认 dry-run**、`--apply` 才删、只匹配 3 个 E2E 前缀、被 `outreach_messages`/`cust_inquiries` 引用的行跳过并列出、事务+`--limit`、`KAAS_DSN` 环境变量读 DSN）；本机空库 dry-run 实测 0 行/exit 0 | — | ✅ |
| A11 | FACT_LABELS 未通过 API 返回 | ✅ 复核后**无需改**：`_fact_dict` 已逐条返回 `text_zh`/`text_en`（`ws_docs_hardening.py`），前端 `doc-facts-panel.tsx` 也按 `text_zh/text_en` 展示与编辑 ⇒ 全局 `FACT_LABELS` 只是内核兜底，不构成缺口 | — | ✅（复核销账） |
| A12 | `trigger_expr` 只存不求值 | `trade_doc_doc_set_items.trigger_expr` 仅存表达式；"无木包装不出声明"需条件求值器 | A7 | ⏳ |
| A13 | 翻译端点无入口 | `POST /trade-docs/{id}/translate` 已实现（`ws_docs_ext.py:518`）但前端 0 调用（仅在内容版本显示"AI 翻译"标签） | — | ⏳ |
| C28 | 询盘「渠道」枚举不一致（P2: 按提示填必 422） | ✅ 2026-10-21：前端自由输入改为**枚举下拉**（`INQUIRY_CHANNEL_OPTIONS` 与后端 `INQUIRY_CHANNEL` 逐字一致，中文标签→枚举值），只发合法值；typecheck 0 | — | ✅ |
| C29 | 「导入已有数据」是占位骨架却已挂页面 | ✅ 2026-10-21：已从「订单」「单证」两页移除入口按钮与弹窗（清理 state/import），组件保留并加注"后端批量导入接口就绪后再挂回"；**后端接口本身仍未实现**（实现时合并 C19 的导入 UI 决策） | C19 | ✅（入口已隐藏） |
| C30 | `/admin/archive-logs` 恒空 + 前端 0 调用 | `main.py:3003-3008` return 空列表；CLEANUP_LOG 说归档策略待确认 | — | ⏳ |
| C31 | 仪表盘指标恒 0 且「更新中」占位未实现 | `main.py:1829-1833` token/p95 恒 0；`dashboard/page.tsx:86-100` 直接展示；契约注明 status=placeholder 应改"更新中" | — | ⏳ |
| C32 | `/billing` 页面无入口 | `billing/page.tsx` 存在但 0 引用；契约说"移入头像菜单"未接 | — | ⏳ |
| C33 | 4 条 e2e skip 未登记 | `events.spec.ts:118`（需强制 500 手段）、`quotations.spec.ts:50/55/59`（选择器未定位） | — | ⏳ |
| C34 | MSW 与 C8 漂移 | `longtail-handlers.ts:1126-1128` leads 索引仍固定 null（注释"后端恒返 null"已过时）；C18"3 处简化"实为 5 处 | — | ⏳ |
| C35 | 客户列表缺 stage 筛选 | `handlers.ts:2965` 自述"页面暂未传，留作契约完整"；FE 只发 q | — | ⏳ |
| C36 | 约 60 条后端路由前端 0 调用 | 建议一次性登记「后端先行 API 保留清单」（`.tmp/align-diff.txt`），避免再被误判欠账 | — | ⏳ |
| C37 | OSS 死分支 + 7 处过期注释 | `payload-renderer.tsx:27-46` `_oss_key` 死分支；`use-customer-records.ts` 等 7 处注释过期 | — | ⏳ |
| C38 | 文档口径全面刷新（10+ 处） | worker README「push main 自动部署」**危险误导**、「Worker 无 cron」、HANDOVER §0.2.3 A4/A7/B 未完成、TRADE_DOC_HARDENING「施工中」、PRODUCT_CONFIG 仍写 B1/B3 未完成、DEPLOY 迁移 head/上线门禁/分支改名过时、AGENTS 门禁数字（222/954）与漏列 `ui:contrast`/`mocks:check`、PROBLEM_STATUS Protected 自相矛盾、WORKSTATION_DESIGN 多处旧状态、integration README env.py 风险已修、根 `archive/` 未入索引 | — | ⏳ |
| N6+ | 安全范围扩展 | N6 ③ 只写 `docs/archive`，实测根 `archive/` 有 **45 个受控文件**（含 18 份真实业务样例），含公司名/电话/邮箱/报价；仓库 public ⇒ 评估范围扩到 `docs/archive/** + archive/**` | 安全批（最后） | ⏳ |
| C12+ | PDF 归档验收补 2 项 | `TRADE_DOC_PDF_ARCHIVAL.md:579-582`：真实单证 HTML 体积/耗时未实测、生产是否真有 `render_pdf` 未复查 | 发布后 | ⏳ |

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

---

## H. 销账规则

1. **完成一项**：本表状态改 `✅（日期 + 证据：提交/迁移/门禁数字）`，并在 `PROBLEM_STATUS_2026-10-11.md` 顶部「交接摘要」登记一条；**改代码必须同步文档并 push `main`**（`AGENTS.md` 规则 1）。
2. **新待办直接加本表**；不得再用"触发条件制"隐藏工作项；必须用户拍板的标 🧭 并写清拍什么。
3. 涉及授权策略/数据删除/生产操作（D3/D4/安全项）执行前一律走 `ask_user_question` 弹窗（`AGENTS.md` 规则 2）。
4. 每批提交前跑门禁（见根 `README.md` §4）；提交纪律见 `AGENTS.md` 规则 4（私有 `GIT_INDEX_FILE`、不碰他人改动）。

---

## I. 更新历史

- **2026-10-21 执行批 4（sweep 后首批修复）**：C23 shipments 恢复 `active`（契约 ts↔py 同步，R2 PASS 27 工位）、C28 询盘渠道改枚举下拉（只发后端合法值）、C29 订单/单证页移除占位「导入已有数据」入口（组件保留待后端接口）；G-11/12/13 用户拍板落盘。门禁：typecheck 0 / 定向 79 passed / contracts PASS / mocks 未覆盖 0。`n- **2026-10-21 二轮全量 sweep**：全分支 56 ref/131 reflog/147 unreachable → **0 条新待办**；全文档（含此前未读的 DEPLOY.md 337 行、ui-redesign 64 files、WORKSTATION_DESIGN 1011 行）→ **12 条新发现**；全代码 666 文件/439 命中 → **13 条新发现 + 账本 drift**。已登记 §P（C23–C38、A10–A13、N10/N11、N6+/C12+）与 §G（G-11 主题/G-12 shipments/G-13 spec-config），并更新 goal。\n- **2026-10-21 执行批 3（收口）**：A7-3 UI（事实确认/一致性/收款/单证清单/签发闸门，面板 9 + 契约 12 测）→ **A7 全部完成**；C2 文件存储收尾（doUpload/排序页面测试 + 7 条真 PG 用例）→ 发现并修复 **C22**（迁移 `202610200005` 唯一索引 `NULLS NOT DISTINCT`）；C10 18 模板防劈页（39 静态断言，视觉待 build/e2e 复核）；intel/channels 字段错位修复；C20 导入模板端点回落租户产品；C6 收口。**全量门禁**：worker 1217+12skip（有库 1229/0）、orchestrator 247、前端 616、e2e 28（24+4）、build `out/` 275 文件、contracts/mocks/静态断言全 PASS。
- **2026-10-21 执行批 2**：A7 内核/结构/API 全部落地（内核 87 测 + API 34 测 + `trade_doc_facts`）；B 组验收 → B1 销账（B4 P0 跨团队越权修复、B5 formulas/explain 回落、B6 订阅门同源）；C7 xlsx 导入（28 测）；C8 四源计数（18 测）；C5/C18 mock 持久化 + 长尾覆盖归零；C15 契约错位修复；C16/C17 关闭。新增 C19/C20/C21 与 G-10。门禁：worker **1212+5** / 前端 **535** / typecheck 0 / contracts PASS。
- **2026-10-21 执行批 1**：D7 重试落地（`1f0d76d7`）；A7 事实层表 `202610200004` + `TradeDocFact`（`32d5fe0c`）；对齐 A 批（/events 闸门、F4 stage 消费、路由守卫/写权限，`a92302eb`）+ 对齐 B 批（MSW 58→111、死代码、mocks:check 门禁）；新增 C17/C18。
- **2026-10-20 晚**：重写为唯一账本。—— 销账 A2（方案A）、B1 租户级、B2、B3、A8②③、A9、N2、N7；新增 A2-B、C7–C16、N1/N3–N8；D5 改回 ⏳（实测 public）；补安全 4 项与生产两个现网缺陷（D1/D2）；统一 e2e=28。
- 2026-10-20：用户裁决废止"触发条件制"，A/B/C/D 全部恢复活跃。
