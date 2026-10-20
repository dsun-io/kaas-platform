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
| 迁移头 | `202610200003`（`alembic heads` 实跑；生产**尚未应用**，随发布窗口） |
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
| A7 | 单证加固 P1/P2 | **现状 ≈2/5**：③收款容差内核（`kaas_common/workstation/receipt_rules.py`）+ ④两表（迁移 `202610170003_trade_doc_receipts_and_doc_set`）已就绪；**①事实层、②一致性引擎、③④的 API/UI、⑤导出后自检 未做**。口径已拍板（`UNCERTAIN.md` #17） | 无（可直接施工） | 🔨 进行中（2026-10-21 开工；见 §A7 子项） |
| A8 | PDF 归档尾巴 | ②③ 已完成（cron + 列表「已变更/模板已更新/待复核」标识）；①端到端真实跑一次 | ①需已部署环境 | ✅ ②③；①随发布后 P4 |
| A9 | 指纹批量对账定时调度 | cron `40 17 * * *` + `trade_doc_render_checks` 表 + 列表 `render_check` | — | ✅ 2026-10-20 |

### §A7 子项（施工清单，口径见 `UNCERTAIN.md` #17）

- [ ] A7-① **事实层（fact model）**：以 `order` 为根的事实域（同 order 下所有单证共享 fact），支持跨单证取值与差异检测。
- [ ] A7-② **一致性引擎**：全局等价词表（`kaas_common`）+ 租户增量表（仅 internal 可改）；输出 cross-doc 差异清单。
- [ ] A7-③ **收款容差**：每币种 `max(5 美分等值, 0.1%)`；内核已有，补 API/UI 与提示。
- [ ] A7-④ **`not_by_us` 回执登记**：expected→received 流程（`trade_doc_receipts` / `trade_doc_doc_set` 两表已建，缺 API/UI）。
- [ ] A7-⑤ **导出后自检**：默认阻断、tenant 可配越过但落审计。

---

## B. 产品配置化

| # | 待办 | 真实状态 | 前置 | 状态 |
|---|---|---|---|---|
| B1 | 租户级产品定义配置化 | **租户级已完成**（worker `ws_products.py` 8 条路由；`tenant_products.spec` JSONB 每请求读库；前端 `/settings/tenant-products`）；**系统级仍是 Python `@register` 注册表**（`export_quote/products/*.py` 4 个） | 系统级口径见 §G-3 | ✅ 租户级 2026-10-20；系统级 🧭 |
| B2 | 产品可视化编辑器 | `product-spec-editor.tsx` + `products-definitions-tab.tsx`，保存即生效 | — | ✅ 代码完成，待 P3 端到端验收后销账 |
| B3 | 租户开通报价工位 UI | `team/components/team-subscriptions-panel.tsx`（管理员开通/撤销、PUT 后重拉列表）+ 产品页启用开关 | — | ✅ 代码完成，待 P3 端到端验收后销账 |

---

## C. 质量、体验与"审计新发现"项

| # | 待办 | 内容 | 前置 | 状态 |
|---|---|---|---|---|
| C1 | 「流失」拒绝文件链路 | 订单阶段新增 `lost`，拒绝文件链路迁订单阶段 | 🧭 业务设计 + 用户拍板 | 🧭 |
| C2 | 文件存储收尾 | 真实 DB 用例 / 公章 PI 视觉 QA / 排序过滤测试 / **`products/page.tsx` 的 `doUpload` 无自动化测试** | D2 后更完整 | ⏳ |
| C5 | 本地 mock 刷新丢数据 | MSW state 是模块内存态（`mocks/handlers.ts`），刷新即丢；缺持久化 | — | ⏳ |
| C6 | e2e 数据层不稳根治 | 兜底路由掩盖缺口、无 per-test 重置；历史"假红/整轮数字作废"根因 | — | ⏳ |
| C7 | Excel xlsx 上传闭环 | 上传侧现只收 CSV | — | ⏳ |
| C8 | 四源计数端点 | `WORKSTATION_DESIGN.md:849`；代码仍占位（`chain.py` `demand_index=None`/`blank_index=None`） | — | ⏳ |
| C9 | 诊断端点收敛 | `_r2_debug` / `fx-rates/_debug` 暴露面收敛 | — | ⏳ |
| C10 | 18 模板签章区孤行 | 末尾几块包 `break-inside: avoid`（会动全部 18 模板） | — | ⏳ |
| C11 | SSRF DNS rebinding 加固 | `kaas_common/net.py` 不做 DNS 解析后再校验（当前只校验字面 IP/域名） | — | ⏳ |
| C12 | PDF 归档验收尾巴 | 真实 18 类单证端到端未跑、页面级接线仅 typecheck 保驾、按快照重出未做 | 随发布后 | ⏳ |
| C13 | outreach/webhook 收紧 | `GET` 回调是否收紧到 `POST`（将来实现 inbound 回写必须去掉 GET） | 产品决策 | 🧭 |
| C14 | `product_tax_rates` 生产数据 | 生产 0 条则批量报价不放行 | 发布窗口 | ⏳（D 组同批） |
| C15 | PROBLEM_STATUS 2026-10-12「待排期 5 项」复核 | openapi 重生成（**R6 已退役，作废**）/ feature_flag 形状 / 契约 `ExportProduct.params` / PATCH stage 409 前端 / R2 密钥长度 | — | ⏳ 逐条判定后销账或转正式项 |
| C16 | UNCERTAIN #15 ①②③ | 旧进度报告/Spec System 报告指什么、归档"复制/移动"口径、链接检查工具 | 低价值 | ⏳ |
| C17 | 侧栏 `adminOnly` 过滤口径统一 | `sidebar.tsx:150` 仍按 `account_type === internal` 过滤菜单，而 `RouteGuard adminOnly` 已收紧为 internal+管理员 ⇒ internal 非管理员仍能看到菜单项、点进去被守卫拦。要么菜单同口径过滤，要么给工位契约加 `internalOnly` 标志（`/kb` 已用 internalOnly 保住原可见性） | 无 | ⏳ |

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
| N1 | **前后端对齐专项** | UI 重构后，前端调用 ↔ Worker 路由（`backend/worker/src/*.py`）↔ `shared/contracts` ↔ MSW handlers 全量比对；断点清单 + 修复 + 补测试（审计报告 `.tmp/align-report.md`：P0 断点 0、P1 三条、P2 五条） | 🔨 分两批：**A 批已修**（/events 平台闸门、F4 stage 消费 + stage-log、路由守卫口径、spec-proposals/company-profile/tax-archives 写权限）；**B 批进行中**（MSW 形状/覆盖、/oss/presign 死代码、防漂移门禁） |
| N2 | 环境隔离 | `.env.local` 生产 DSN 已加警示注释 + 本地开发指引；本地 compose 栈拉起（postgres/redis/minio/backend）；**新 clone 必须先 `sync-shared.ps1`**（镜像 gitignored，缺 `kaas_common.preview` 会崩）；本地库为空库快径重建（105 表 / head `202610200003`） | ✅ 2026-10-20（本机） |
| N3 | H-2 用户复验 | 定价页刷新与注册（2026-10-19 已修复上线）等用户确认 | 🧭 需用户复验 |
| N4 | P8 联调状态核对 | `WORKSTATION_DESIGN.md:945`「P8 联调 + E2E + 订阅编码 ⏳ 进行中」是否仍成立 | ⏳ 核对 |
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

---

## H. 销账规则

1. **完成一项**：本表状态改 `✅（日期 + 证据：提交/迁移/门禁数字）`，并在 `PROBLEM_STATUS_2026-10-11.md` 顶部「交接摘要」登记一条；**改代码必须同步文档并 push `main`**（`AGENTS.md` 规则 1）。
2. **新待办直接加本表**；不得再用"触发条件制"隐藏工作项；必须用户拍板的标 🧭 并写清拍什么。
3. 涉及授权策略/数据删除/生产操作（D3/D4/安全项）执行前一律走 `ask_user_question` 弹窗（`AGENTS.md` 规则 2）。
4. 每批提交前跑门禁（见根 `README.md` §4）；提交纪律见 `AGENTS.md` 规则 4（私有 `GIT_INDEX_FILE`、不碰他人改动）。

---

## I. 更新历史

- **2026-10-21**：执行批 1 —— D7 重试落地（`1f0d76d7`）；A7 事实层表 `202610200004` + `TradeDocFact`（`32d5fe0c`）；对齐 A 批（/events 闸门、F4 stage 消费、路由守卫/写权限，见 `N1`）+ 新增 C17；无账本级新增待办。
- **2026-10-20 晚**：重写为唯一账本。—— 销账 A2（方案A）、B1 租户级、B2、B3、A8②③、A9、N2、N7；新增 A2-B、C7–C16、N1/N3–N8；D5 改回 ⏳（实测 public）；补安全 4 项与生产两个现网缺陷（D1/D2）；统一 e2e=28。
- 2026-10-20：用户裁决废止"触发条件制"，A/B/C/D 全部恢复活跃。
