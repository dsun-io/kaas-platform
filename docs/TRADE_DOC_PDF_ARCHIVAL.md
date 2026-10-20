# 单证 PDF 留档：现状核实与可行路径（2026-10-11）

> 回答用户那句「**pdf 要存**，客户盖章回传以后要覆盖没有盖章的旧文件，要留档肯定要存的」。
> 本文只做**现状核实 + 方案设计**，不含已实现的代码改动；所有代码位置都给了文件与行号。
> **对未验证的事一律标注「未验证」，不把设想写成已实现。**
>
> **本轮后续（2026-10-11 晚，用户：「自动出pdf字节听起来是降低工作量的设计实现它」）**：
> 本文推荐的 **D 方案（Cloudflare Browser Rendering）已落地并实测**，同时先落了人工归档兜底。
> 落地现状与实测证据见下方「§〇 本轮落地」。**§一~§四 是当时的现状核实与方案设计，保留原样**。

## 〇、本轮落地（实测，2026-10-11 晚）

**A1 人工归档（零依赖兜底，已可用）**：预览区「归档本版 PDF」把用户打印对话框另存的那份
PDF 选回来，走 `POST /api/v1/trade-docs/{id}/files/upload`（multipart：`file` + `role="render_pdf"`
+ `name`）落档；前端先校验 `application/pdf` 与 ≤32MB（与内核 `MAX_BYTES['render_pdf']` 一致）。
证据：`frontend/src/app/(app)/trade-docs/components/__tests__/doc-preview-archive.test.tsx`
（8 条，含"上传字节与服务端收到的一致"逐字节断言）。

**D 自动出字节（已实现）**：新增 `POST /api/v1/trade-docs/{doc_id}/pdf`（两端同路径同字段，
`scripts/route-parity.py` 通过），入参是**与预览同源的那份 HTML**；服务端出字节后复用既有落档链路
（`_store_bytes` → `_create_file(kind='render_pdf', supersede=True)` → `attach_doc_file(role='render_pdf')`）
⇒ 自动归档 + 版本让位（旧件挂 `render_pdf_superseded`）。前端「自动出 PDF 并归档」，**保留**人工归档兜底。

本账号（`766f8d7eb5a7d20e272673073ec8c3fd`）**实测事实**（推翻了本文 §五 的第 1–3 条未知）：

| 事实 | 实测结果 |
|---|---|
| REST 端点 | `POST https://api.cloudflare.com/client/v4/accounts/{id}/browser-rendering/pdf`，body `{"html": "…"}` |
| 响应形状 | **HTTP 200 直接返回 PDF 二进制**（实测 15497 字节，`%PDF-1.4` 开头、`%%EOF` 结尾，含 `/Type /Page`），**不是 R2 链接** |
| 命名不一致 | 文档页写 `/browser-run/pdf`、OpenAPI 写 `/browser-rendering/pdf`；**两条都实测返回 200**。代码取有 OpenAPI 依据的 `browser-rendering` |
| 计费/开通 | **无需开通、无需付费**：账号订阅实测只有 `teams_free`(price 0) 与 `r2_paid`(price 0)；Browser Rendering 自带额度 **Workers Free = 10 分钟/天、3 并发，超出 N/A（不产生费用）**；Workers Paid = 10 小时/月，超出 $0.09/浏览器小时 |
| 凭证 | REST 需 `Browser Run - Edit` 权限的 token；**Workers binding 不需要任何 token**。生产 Worker 现有 secrets 无 CF token ⇒ 生产走 binding |
| 生产配置 | `backend/worker/wrangler.jsonc` 已加 `"browser": {"binding": "BROWSER"}`（`compatibility_date` 现为 `2026-09-18` ≥ 要求的 `2026-03-24`）；orchestrator/本地需 `BROWSER_RENDERING_ACCOUNT_ID` + `BROWSER_RENDERING_TOKEN` |

**安全边界（硬要求）**：这个端点等于"用我们账号里的无头浏览器渲染请求体"，因此入参 HTML 必过共享内核
`backend/kaas_common/files/render_pdf.py::validate_render_html`：`<script>`/`<iframe>`/`<object>`/
`<embed>`/`<link>`/`<base>`/`<form>`、`on*=` 事件属性、`javascript:`、`<meta refresh>`、
`data:text/html`、`@import` 一律 **422**；HTML ≤2MB。
**外链策略（2026-10-12 用户裁决：从"严格拒绝任何非 `data:`"改为"白名单自家域名"）**：资源地址
（`src`/`srcset`/`href`/`poster`/`background`/`data`/`formaction`/`action`/`xlink:href` + CSS `url()`）
只放行 **`data:` URI** 或 **host 命中白名单的 http(s) 地址**；白名单可配置
`PDF_HTML_ALLOWED_HOSTS`（逗号分隔，默认 **`kaas.powervoy.com,api.kaas.powervoy.com`**；
两端都**请求期读取**：orchestrator 走 `os.environ`、Worker 走 `main._binding`）。
host 匹配**大小写不敏感、允许端口、条目允许其子域**（`cdn.kaas.powervoy.com` 命中 `kaas.powervoy.com`）；
**协议相对地址 `//host/x`、其它域名、`blob:`/`file:`、以及 `a.com.evil.com` / `evila.com` 这类
"像域名但不是"的形状全部继续 422 `HTML_EXTERNAL_RESOURCE`**。白名单只放宽"外链资源"，
脚本类拒斥与白名单无关（自家域名下的 `<script src>` 同样 422）。
未配渲染器 → **503 `PDF_RENDERER_NOT_CONFIGURED`**（不假装成功）；上游失败/返回非 PDF → **502**。
证据：`backend/orchestrator/tests/test_render_pdf.py`、`backend/worker/tests/test_ws_render_pdf.py`、
`frontend/src/app/(app)/trade-docs/components/__tests__/doc-preview-auto-pdf.test.tsx`。
其中 `test_render_pdf.py` 另用 **18 份渲染基线**（`frontend/src/lib/trade-doc/__fixtures__/html/*.html`，
渲染器真实产物、与归档 Python 版逐字节对账）断言**全部**通过安全校验 —— 证明这道门不会误伤自家单据，
同时钉住"渲染器不得产出脚本/外链"；白名单的"像域名但不是"反例（后缀伪造 / 前缀拼接 /
协议相对 / 域名藏在路径里 / userinfo 伪装）也逐条钉在测试里。

**C 方案（签发时冻结渲染输入指纹）：已实现（2026-10-12）** —— 用户拍板后落地，口径见下方
「§〇.2 C 方案落地」。

**仍未做 / 未验证**：① 自动出字节**依赖在真实环境配好 binding（生产）或 token（本地）**，
未配置时接口如实 503；② 本仓库**没有**用真实单证跑过一次端到端（实测用的是最小 HTML 探针，
不是 18 类单证的真实 HTML）；③ **版面/分页仍然无法在无头环境验证**（见下文 §四 风险 1、风险 2：
Chromium 忽略 `break-before/after: avoid`，跨 Chrome 版本分页可能变）；④ **真实上传/归档验收暂缓**（用户已决定）：
生产 R2 的 `S3_ACCESS_KEY` 报 `Credential access key has length 13, should be 32` ⇒ 需用户重建 32 位
密钥后再验；**在此之前不要写成"上传已验证成功"**（服务端落档走 `_store_bytes` 的 binding/inline
回退，不依赖直传，但"上传到对象存储"这一条实测仍未通过）；⑤ C 方案的**前端那一行已有自动化测试**
（**4 条**），但**页面级接线**仍只有 `typecheck` 保驾（见 §〇.2 末尾"未覆盖"与"补测抓到并已修的真实漏洞"）。

## 〇.2 C 方案落地（签发时冻结「渲染输入快照指纹」，2026-10-12）

**冻结时机**：`POST /trade-docs/{id}/confirm` 成功那一刻（两端一致）。指纹在**改状态/写签发时间之前**
计算 —— 装配层把单据日期取成 `issued_at or created_at`，签发前后天然差一个日期字段（该字段已被排除，
理由见下）。它写进 `trade_docs.raw_payload` 的**顶层保留键** `_render`（与 `_audit` 同风格；
客户端自带的 `_render` 一律被覆盖），**`custom` 覆盖不到它**（`custom` 是 `raw_payload` 的**子对象**）。
重复确认按现有状态机拒绝（409 `NOT_DRAFT`），不会重复写或写乱。

**`_render` 的确切形状**（内核 `kaas_common.trade_doc.render_fingerprint.render_fingerprint`，
两端一份）：

```jsonc
{
  "render_version": 1,             // 渲染器/模板版本（常量 RENDER_VERSION，从 1 开始）
  "input_sha256": "<64 位十六进制>", // 渲染输入的摘要；装配失败时为 null（不伪造）
  "frozen_at": "2026-10-12T09:30:00+00:00",  // 冻结时刻（UTC ISO）
  "note": "input_unavailable"      // 仅装配失败时出现
}
```

**摘要纳入什么**：装配好的渲染数据（`GET /trade-docs/{id}/render-data` 返回的 `data`）——
卖方抬头、买方（客户档案 + 主联系人）、上游快照与行项、币种与总金额、贸易条款、
`custom` 手工字段、产品图引用解析出的 `data:` URI、默认公章、产品基础信息回落。
**摘要排除什么（含理由）**：

| 排除 | 为什么 |
|---|---|
| 各单据类型的日期字段（`pi_date`/`invoice_date`/… 由 `DOC_NO_FIELDS` 自动收集）、`created_at`/`issued_at`/`issued_by`/`updated_at`/`frozen_at` | 这些由**签发动作本身**写入；装配在签发前后取到的值不同。纳入 ⇒ 冻结的摘要与"拿同一行重新装配"**永不相等**，指纹出生即失效。签发时刻已另记在 `frozen_at` 与单据行 `issued_at` 上 |
| `_audit`、`_render` | 系统自己的记录键，不是渲染输入；纳入会让"改一次审计"改一次指纹（自指） |
| `request_id`/`trace_id`/`now` | 请求级易变值，与内容无关 |

**确定性保证**：键排序后序列化（与 dict 插入顺序无关）；数字归一（`int`/`float`/`Decimal` 同值同形 ——
orchestrator 会给 `float`、Worker 的 asyncpg 会给 `Decimal`，不归一两端指纹必然不同）；
`data:` URI 与字节一致 ⇒ 同图同摘要。**可复现性**已单测钉住：签发前（日期=created_at）与签发后
（日期=issued_at）装配出同一摘要。

**bump 纪律（写在内核注释里）**：改 `render.ts` / `assets.json` / `manifest.json` 或渲染器行为
（分页、字体、字段映射）⇒ **必须**把 `RENDER_VERSION` 加一。`input_sha256` 只能证明"输入没变"，
证明不了"输出没变"。这条没有代码能自动兜底（渲染器在前端 TS 里），靠 review 守。

**展示**：单证预览区一行 `渲染指纹 v1 · a1b2c3d4`（`title` 里给 `frozen_at` 与完整 sha256）；
`_render` 只在 confirm 成功时写入 ⇒ "有这个键"等价于"已签发"，草稿/历史单据不渲染该行。

**C 方案的未覆盖**：① `_render` 存的是**指纹**不是快照本体（本任务口径就是指纹：不把 ~1.4MB 的
图片 data URI 抄进 `raw_payload`）⇒ 能证明"输入是否一致"，但**不能**凭它重出当时那一版；
若要"按快照重出"，仍需另存装配输入（本文 §3.2 第 2 步原始设计，**未做**）。② 前端那一行**有**自动化测试
（`frontend/src/app/(app)/trade-docs/components/__tests__/doc-preview-auto-pdf.test.tsx` 新增 **4 条**：
显示 / 不显示 / 坏形状 / 装配失败）；但**页面级接线**（`page.tsx` 传 `renderMetaOf(raw_payload)`）
仍只有 `typecheck` 保驾 —— **没有组件之上的页面测试**。
③ **已有对账消费者**：`GET /api/v1/trade-docs/{id}/render-fingerprint-check`（task-17，两端同契约）
＋ 前端「核对指纹」按钮（task-19：**仅已签发单据显示**、**点了才查**、按 `reason` 显示一行结论，
`data_changed` 红字「签发后数据已被修改」）；**task-20 已补批量对账**
（`GET /api/v1/trade-docs/render-fingerprint-checks/batch`，实际契约见 §〇.3）。
**仍未做**：定时调度、列表页一眼标出"哪些被改过"。
④ **orchestrator 侧 `confirm` 的落库路径没有单测**
（worker 侧有：`tests/test_four_domains.py::test_trade_doc_confirm_locks_draft` 从
`UPDATE ... raw_payload=...` 的**实参**里验了 `_render` 的形状）；orchestrator 只单测了
`_freeze_render_fingerprint` 这个壳（装配成功 ⇒ 有摘要；装配抛错 ⇒ `input_sha256: null` + note）。
⑤ 指纹**不覆盖签发之后的文件变化**：签发后仍可归档新的 PDF 版本（`render_pdf` 版本让位），
新版本并没有自己的 `_render`（版本链与指纹是两件事）。

**补测抓到并已修的真实漏洞（2026-10-12）**：`renderMetaOf` 原先只判
`typeof === "object" && !== null` —— **数组也满足** ⇒ `[]` 会被当成指纹，界面渲染出
`渲染指纹 v? · 未冻结`（**看着像真的、其实是坏的**）。现在**排除数组**，且**必须**有数值型
`render_version`，否则返回 `null`、整行不显示（`frontend/src/app/(app)/trade-docs/components/doc-preview.tsx:115-122`）。

**`RENDER_VERSION` 已钉值**：`backend/orchestrator/tests/test_trade_doc_render_fingerprint.py`
断言 `RENDER_VERSION == 1`（`:189`），并在注释里注明"改 `render.ts` / `assets.json` / `manifest.json`
就必须 bump，并**同步改这一行**"（`:185`）。理由：`input_sha256` 只能证明"输入没变"，
**证不了"输出没变"**；而渲染器在前端 TS，**没有 CI 能自动发现"模板改了却没 bump"**。

## 〇.3 对账端点（task-17 落地，2026-10-12）

**路径与语义**：`GET /api/v1/trade-docs/{id}/render-fingerprint-check` —— **只读**对账，
回答"这张单据**现在**的数据跟**签发时**冻结的指纹还一致吗"。两端**逐字相同**
（orchestrator `backend/orchestrator/app/api/trade_docs.py:910`；
worker `backend/worker/src/ws_docs_ext.py:304`），判定全在共享内核
`kaas_common/trade_doc/render_fingerprint.py::render_fingerprint_check`。
它走与 `POST /trade-docs/{id}/confirm` **同一套装配**（`get_trade_doc_render_data`）
＋ **同一个摘要函数** —— 否则比对没有意义。

**返回 11 个字段**（内核 `render_fingerprint.py:278-301`，就是两端响应契约）：
`has_fingerprint` / `frozen` / `current_sha256` / `matches` / `render_version_frozen` /
`render_version_current` / `render_version_drift` / `reason` / `checked_at` /
`current_note` / `frozen_note`。

最该被记住的三个：

| 字段 | 语义 |
|---|---|
| `matches` | **当且仅当**两边都有摘要且完全相等才 `true`（`render_fingerprint.py:282-287`） |
| `reason` | `matched` / `version_drift` / `data_changed` / `no_fingerprint` / `frozen_unavailable` / `current_unavailable`（`:227-232`） |
| `render_version_drift` | 模板/渲染器版本是否变了 —— 与"数据被改"**分开报**（`:290`） |

**保守语义（宁可比不了，也不给假结论）**：
- 没有 `_render`（草稿 / C 方案之前的老单据）⇒ `has_fingerprint=false`，其余字段如实给当前值，**不报错**（`reason=no_fingerprint`）；
- **现在装配失败** ⇒ `current_sha256=null` + `current_note`，`matches=false`（`reason=current_unavailable`），
  **绝不给"看起来匹配"的假结论**；
- 冻结时就没摘要 ⇒ `reason=frozen_unavailable`，同样**不报 matched**；
- 单据不存在 ⇒ **404** `DOC_NOT_FOUND`（`trade_docs.py:935-936`）。

**五情形证据**（`backend/orchestrator/tests/test_trade_doc_render_fingerprint.py`）：
匹配（`test_matched:300`）、不匹配（`test_data_changed_is_detected:324` —— **真的改了被纳入摘要的业务数据**：
`total_amount` / `currency` / 买方抬头 / 行项，**4 个参数化用例** `:317-322`）、
无指纹（`test_no_fingerprint_is_not_an_error:337`）、装配失败
（`test_current_assembly_failure_never_reports_match:365`、`test_unusable_frozen_never_reports_match:356`）、
版本漂移（`test_version_drift_is_reported_separately_from_data_change:378`）；
另有契约字段固定（`test_response_contract_is_stable:398`）。
worker 侧 `backend/worker/tests/test_ws_render_fingerprint_check.py` 含"路由确已注册进 OpenAPI"的断言（`:206-207`）。

**前端入口（task-19，已做）**：单证预览区的「**核对指纹**」按钮 —— **仅已签发单据显示**（有 `_render`
才有入口）、**点了才查**（`useMutation`，预览时**不自动**拉：对账要重新装配一遍、有成本，且它回答的是按需问题）、
按内核的 `reason` 显示**一行结论**：
`matched` 绿「与签发时一致」、`data_changed` **红字**「**签发后数据已被修改**」、
`version_drift` 黄「渲染模板已升级（数据未变）」、其余落"无法判定"，**未知 `reason` 也不猜**
（`frontend/src/app/(app)/trade-docs/components/doc-preview.tsx:145-179,370-393`）。

**批量对账（task-20，已做）**：`GET /api/v1/trade-docs/render-fingerprint-checks/batch`（两端同契约；
orchestrator `backend/orchestrator/app/api/trade_docs.py:979`、worker `backend/worker/src/ws_docs_ext.py:360`）

- 入参 `doc_ids`（逗号分隔，**去重后上限 50**，超限 ⇒ 400）；对每张跑**同一套**单张判定再汇总；
- 返回 `{total, matched, data_changed, version_drift, no_fingerprint, unavailable, items}`，
  每张卡 `{doc_id, doc_no, reason, matches, render_version_drift, error}`（契约常量在内核
  `render_fingerprint.py:331-354`）；
- **一张炸了不拖垮整批**：取不到 / 无权看 / 该张抛异常 ⇒ 该卡 `reason=unavailable` + `error`，其余照常交付；
- **不变式**：`matched + data_changed + version_drift + no_fingerprint + unavailable == total`
  —— **不允许漏桶**（漏一张会被读成"这张没问题"，那正是最危险的错法）；
- 路径为什么取 `…/render-fingerprint-checks/batch`（代码注释里写明）：`/trade-docs/{doc_id}` 是**不带 int
  转换器**的动态段，会把 `…/trade-docs/render-fingerprint-checks` 先吃掉 ⇒ 必须多一段静态后缀。

**已落地（2026-10-20，TODO A8/A9）：定时调度 + 列表标识**

1. **定时调度**：CF Cron `40 17 * * *`（UTC 17:40 = Asia/Shanghai 次日 01:40）由
   `ws_cron.run_check_render_fingerprints` 执行 —— 扫**近 30 天签发**的单据（单轮上限 50，
   与批量端点同上限），逐张复用同一套内核判定；每张独立 try（一张装配失败标
   `current_unavailable`，不拖垮整轮），结论 **upsert** 进 `trade_doc_render_checks`
   （迁移 `202610200002`，tenant+doc 唯一、覆盖写，不是事件流）。
2. **列表标识**：`GET /api/v1/trade-docs` 每行挂 `render_check`（最近一次结论；
   `null` = 从未对账）；前端列表显示「已变更」（`data_changed` 红）/「模板已更新」
   （`version_drift` 黄）/「待复核」（装配失败黄），一致与无基线不显示标识（常态不打扰）。
3. 批量端点（下文）保持不变，仍用于**按需立即对账**；定时任务只是周期性补扫。
4. 仍未验证的边界：本分支**未在已部署环境真实跑过一次 cron**（需部署后触发，归发布后
   P4 观察期）；cron 首轮结果可从 `/cdn-cgi/local/scheduled` 或日志的 `[cron]` 行核对。

**性质说明（不是 bug，但值得留档）**：对账的前提是"两边同一套装配"。若将来给 `render-data`
加了**新数据源**却忘了同步到**签发冻结**那条路径，两边会**一起变**、`matches` 仍报 `true` ——
对账**发现不了**这种"新增字段没被纳入"的偏差。

## 一句话结论

**PDF 生成必须有一个"无头浏览器"在场，而它不能是生产 Worker（Pyodide 里没有浏览器、也没有模板引擎）；
所以推荐：`签发时冻结"渲染输入快照 + 模板版本"`（必做底座，零新依赖）＋ `用 Cloudflare Browser Rendering /pdf
或 Worker 之外的本机/CI Chrome 把前端已渲染好的 HTML 转成 PDF 字节`，再走**现成的**
`POST /api/v1/trade-docs/{id}/files/upload`（`role=render_pdf`）落进 `file_objects`。
**不采用** jspdf/html2canvas 这类"前端自己画 PDF"的做法（产物与打印版不一致）。

---

## 一、现状核实

### 1.1 PDF 现在怎么产生：浏览器打印，**字节从不落地**

单证 HTML 由**前端**渲染（后端只给数据），PDF 由用户在浏览器打印对话框里"打印为 PDF"：

| 事实 | 位置 |
|---|---|
| PDF 走浏览器打印的设计取舍（"浏览器自带分页、字体与页边距处理，比自研 PDF 生成更可靠"） | `frontend/src/lib/trade-doc/export.ts:6-7` |
| `printHtml(html)` 建隐藏 iframe → `document.write(html)` → `win.print()` | `frontend/src/lib/trade-doc/export.ts:14-43`（关键调用 `:37`） |
| 预览区按钮「打印 / 导出 PDF」直接调 `printHtml(html)` | `frontend/src/app/(app)/trade-docs/components/doc-preview.tsx:66-69` |
| 批量合并打印同样走 `printHtml` | `frontend/src/lib/trade-doc/export.ts:50-78` |
| 页面自述：「打印与「导出 PDF」都走浏览器打印，版面与屏幕上看到的一致。」 | `frontend/src/app/(app)/trade-docs/page.tsx:417` |
| 渲染器注释：输出「可直接打印为 A4 PDF」的自包含 HTML | `frontend/src/lib/trade-doc/render.ts:105` |

**关键点**：`window.print()` 是"把页面交给打印对话框"，**没有 API 能把打印结果拿回成字节**
（`export.ts:35-43` 只做了 `win.print()` 与清理 iframe）。所以今天系统**拿不到 PDF 字节**，
也就无从归档。

### 1.2 系统有没有把 PDF 落成 `file_objects`：**没有**

`render_pdf` 这个用途在仓库里**只出现在定义、校验、让位判断与展示过滤上，没有任何生产者**：

| `render_pdf` 出现处 | 性质 |
|---|---|
| `backend/kaas_common/files/rules.py:29`（`FILE_KINDS`）、`:46`（只允许 `application/pdf`）、`:53`（上限 32MB） | 校验规则 |
| `backend/orchestrator/alembic/versions/202610110016_file_objects_and_product_media.py:46,104`、`202610110017_file_version_scope_and_primary.py:36`（唯一索引收窄到 `kind IN ('stamp_scan','render_pdf')`） | 迁移 |
| `backend/orchestrator/app/api/files.py:575`、`backend/worker/src/ws_files.py:484`（`supersede=role in ("stamp_scan","render_pdf")`） | 版本让位判断 |
| `frontend/src/app/(app)/trade-docs/components/doc-stamp-return.tsx:45`（`files.filter(f => f.role === "render_pdf")`） | 展示过滤 |
| `backend/orchestrator/tests/test_files_kernel.py:66,92` | 测试 |

**前端根本没有哪个调用点会传 `render_pdf`**：

- 上传封装默认角色是 `stamp_scan`：`frontend/src/app/(app)/trade-docs/hooks/use-trade-docs.ts:286`
  （`form.append("role", input.role ?? "stamp_scan")`）；
- 唯一调用方盖章回传写死 `stamp_scan`：`frontend/src/app/(app)/trade-docs/components/doc-stamp-return.tsx:50`。

**生产数据侧**：据 `docs/PROBLEM_STATUS_2026-10-11.md:1873`（2026-10-11 生产库只读连通性实测），
生产 `trade_docs=0`、`trade_doc_items=0` ⇒ **生产至今一张单证都没开过，自然也不可能有任何 PDF 归档**
（该行数字来自那篇文档的生产实测，**本次未直连生产库复查**）。

### 1.3 归档端点现在**能做什么**、还**缺什么**

**能做（已经具备的能力）** —— `POST /api/v1/trade-docs/{doc_id}/files/upload`：

| 能力 | 位置 |
|---|---|
| 两端同契约存在（orchestrator + Worker） | `backend/orchestrator/app/api/files.py:553-579`；`backend/worker/src/ws_files.py:469-487` |
| 接收 multipart，`role` 是**表单字段**（默认 `stamp_scan`） | `files.py:557`；`ws_files.py:472` |
| 把 `role` 直接当 `kind` 建文件，`role='render_pdf'` 时**对旧 `render_pdf` 行做版本让位** | `files.py:571-576`（`supersede=role in ("stamp_scan","render_pdf")`）；`ws_files.py:480-484` |
| 字节落点走三档优先级（S3 预签名 → R2 binding → inline），真实落点写 `file_objects.storage` | `backend/worker/src/ws_files.py:83-155`；`backend/orchestrator/app/api/files.py:88-111` |
| 校验：`render_pdf` 仅接受 `application/pdf`，单文件 ≤ 32MB | `backend/kaas_common/files/rules.py:46,53` |

**结论**：只要有人（或某个进程）**把 PDF 字节发到这个端点**，今天的系统就能把它存下来、版本化、挂到单证上。
**缺的不是"存"，是"出"**。

**当时的四项缺口与本轮进展**（都是可核对的代码级事实；第 2 项本轮**已修**）：

1. **没有 PDF 字节的生产者**：前端只 `win.print()`（`export.ts:37`），不产生可上传的字节；
   后端与 Worker 代码里既无 PDF 库也无无头浏览器库
   （`grep -rniE "weasyprint|reportlab|pdfkit|fpdf|pypdf|puppeteer|playwright" backend` **0 命中**；
   前端只有 e2e 用的 `@playwright/test` **开发依赖**，见 `frontend/package.json:41`）。
2. **链接层的"覆盖"语义（原缺口，✅ 本轮已修）**：**修前** `attach_doc_file` 里把旧链接改成
   `*_superseded` 的分支**只处理 `stamp_scan`**（orchestrator `backend/orchestrator/app/api/files.py:525-530`、
   worker `backend/worker/src/ws_files.py:445-449` 的旧版本）。**后果**：用 `role='render_pdf'` 归档新版时，
   `file_objects` 层旧行虽会让位（`is_current=false`），但 `trade_doc_files` 里的
   **旧链接仍是 `role='render_pdf'`**，单证上会出现多条"当前 PDF"。
   **已修的写法**：条件扩到 `in ("stamp_scan", "render_pdf")`，旧链接挂 `<role>_superseded`、**不物理删**
   （`backend/orchestrator/app/api/files.py:543-550`；`backend/worker/src/ws_files.py:466-472`）。
3. **没有"这一版 PDF 是哪个模板/渲染器/输入算出来的"**：全仓搜 `template_hash|render_version`，
   **除本文的设计用词外代码里 0 命中**；`file_objects` 只记 `sha256`
   （列定义 `backend/orchestrator/alembic/versions/202610110016_file_objects_and_product_media.py:60`，
   索引 `:73`），没有任何模板/渲染器版本列；单证侧只有 `raw_payload` JSONB
   （`backend/orchestrator/app/db/workstation_links.py:270`）。
4. **列表不按 `is_current` 过滤**：`GET /trade-docs/{id}/files` 的 SQL 只做 `trade_doc_files JOIN file_objects`，
   没有 `f.is_current` 条件（`backend/orchestrator/app/api/files.py:488-497`）⇒ 历史版本链接也会返回。

### 1.4 生产环境约束：**Worker 里出不了 PDF**

| 事实 | 证据 |
|---|---|
| 生产是 Cloudflare **Python Worker（Pyodide）** | `backend/worker/wrangler.jsonc:10`（`"compatibility_flags": ["python_workers"]`） |
| Worker 里连 R2 binding 都靠 Pyodide 的 `from js import …` | `backend/worker/src/ws_files.py:124` |
| 渲染器**刻意不放进 Worker**（"线上 Worker 为精简体积刻意不带模板引擎"） | `frontend/src/lib/trade-doc/render.ts:8-10` |
| 后端/Worker 无任何 PDF 库、无无头浏览器库 | `grep … backend` 0 命中（见 1.3 第 1 项） |

⇒ **服务端"直接在 Worker 里出 PDF"这条路走不通**（既没有浏览器，也没有模板引擎）。

### 1.5 已有的可复用件（决定方案成本的关键）

| 可复用件 | 位置 / 事实 |
|---|---|
| **渲染输入装配接口**（跨 5 张表 + 企业主体 + 产品图解引用，前端拿它排版/打印） | `GET /api/v1/trade-docs/{doc_id}/render-data`：`backend/orchestrator/app/api/trade_docs.py:756-805`；Worker 镜像 `backend/worker/src/main.py:3578` |
| **签发动作**（现在的确认 = 置 `status/issued_at/issued_by`，**没有快照、没有 PDF**） | `backend/orchestrator/app/api/trade_docs.py:425-471`；Worker 镜像 `backend/worker/src/ws_docs_ext.py:204` |
| **离线渲染 CLI**（复用前端同一渲染器，输出**自包含 HTML**，不是 PDF） | `scripts/render-trade-doc.ts:114-117`（`renderTradeDoc(...)` → `writeFileSync(outPath, html)`） |
| **文档化的 Chrome 出 PDF 配方**（明确"别用 ego 浏览器打印"） | `docs/TRADE_DOC_TEMPLATES.md:161-163`：`chrome --headless=new --no-pdf-header-footer --print-to-pdf=<out> <file:///…html>` |
| **渲染确定性有门禁**：TS 版必须与归档 Python 版**逐字节等价**（18 份基线） | `frontend/src/lib/trade-doc/render.ts:4-6`；`scripts/verify-trade-doc-fixtures.py:1-11`（逐字节比对） |
| **CI 里本来就会装 Chromium** | `.github/workflows/frontend-ci.yml:72`（`npx playwright install chromium --with-deps`） |
| **CI 目前只做构建+部署**（没有"渲染/归档"任务） | `.github/workflows/deploy.yml:30-104`（build-frontend → deploy-worker） |
| **仓库未使用 Cloudflare Browser Rendering** | 全仓 grep `browser-rendering|browser_rendering` **0 命中** |

**一处文档与代码不一致（✅ 已核对并修正）**：`docs/TRADE_DOC_TEMPLATES.md:130` **曾**把接口写成
`GET /api/v1/trade-docs/{id}/render`（该路由不存在）；**该行已被修正为 `render-data`**，
现存文档与代码一致。实际两端只有 `render-data`
（orchestrator 路由清单：`backend/orchestrator/app/api/trade_docs.py:219,281,425,474,506,756,808,871`；
Worker：`backend/worker/src/main.py:3224,3333,3461,3474,3578` + `ws_docs_ext.py:123,204,341` + `ws_files.py:413,431,457,469`）。

---

## 二、可选路径（逐条给五维）

### 路径 A：**前端生成 PDF 字节再上传归档**

**机制**：在浏览器里把单证变成 PDF，再 POST 给现成端点 `…/files/upload`（`role=render_pdf`）。
两种子形态：

- **A1 手工兜底（今天就能用，零代码）**：用户点「打印 / 导出 PDF」（`doc-preview.tsx:66-69`）→
  在打印对话框里选"另存为 PDF" → 把文件重新上传到单证。
  端点、校验、版本让位**都已具备**（1.3 表）。
- **A2 自动（引入 jspdf + html2canvas）**：用 canvas 把 DOM 栅格化再拼 PDF，得到字节后自动上传。

**需要引入的依赖**：A1 无；A2 需要 `jspdf` + `html2canvas`（`frontend/package.json` 中**没有**这两个包；
现有依赖里只有 `@playwright/test`，见 `frontend/package.json:41`）。

**改动面**：A1 只加一个"上传 PDF"的入口（可复用 `use-trade-docs.ts:286` 的上传封装）；
A2 要加依赖 + 新渲染路径 + 与打印路径并存的第二套排版。

**成本与风险**：
- A2 的产物是**栅格化图片**（不可选文字、放大失真），且 canvas 重绘与 `@media print`
  （`frontend/src/lib/trade-doc/assets.json:22` 起的共享打印样式）**不是同一套渲染** ——
  字体、分页、深色表头（`docs/TRADE_DOC_TEMPLATES.md:75` 要求勾选"背景图形"）都可能不同。
- A1 完全依赖人工，且**用户本机打印设置**（纸型/缩放/背景）不受控。

**对"留档可追溯"的满足度**：A1 中（字节存得下、可追溯，但**不能保证归档件 == 系统认定的权威版**）；
A2 低（多一套渲染实现，最容易造成"看到的和归档的不是一版"）。

> **本文不推荐 A2**；A1 作为"零代码过渡手段"保留，但必须在界面上写明它的归档件**不是权威版**。

### 路径 B：**Worker 之外的执行环境离线渲染**（本机 / CI / 定时任务）

**机制**：一个**不在 Pyodide 里**的进程拿渲染输入 → 复用前端渲染器出 HTML → 用无头 Chrome 打印成 PDF
→ 调现成端点归档。仓库里这套料**已有一半**：

```
GET /trade-docs/{id}/render-data        （trade_docs.py:756）
   → scripts/render-trade-doc.ts        （render-trade-doc.ts:114，出 HTML）
   → chrome --headless=new --print-to-pdf （TRADE_DOC_TEMPLATES.md:163）
   → POST /trade-docs/{id}/files/upload?role=render_pdf （files.py:553）
```

**需要引入的依赖**：一个可执行 Chromium 的运行时 + 一个"谁来触发"的调度。
Chromium 侧成本已知：本机已有该命令的文档化用法；CI 里 `frontend-ci.yml:72` 已经在装 chromium。
**但仓库目前没有任何"渲染归档"任务**（`deploy.yml:30-104` 只构建+部署）。

**改动面**：给 `scripts/render-trade-doc.ts` 加一个 `--pdf`（内部起 Chrome/Playwright 打印）；
新增一个调用者（定时任务或人工脚本），并解决"服务账号怎么带鉴权调 API"。

**成本与风险**：
- 需要**一个始终可用或按需启动的执行者**（CI 定时、或运维机）；离线件天然带
  `OFFLINE COPY — not a ledger record` 水印（`scripts/render-trade-doc.ts:108-112`），
  归档时要显式 `--no-watermark` 才会与工位一致 —— **这条很容易漏，漏了归档件上会印着"离线副本"**。
- 触发时机不明确时，会与"签发即留档"的语义脱节。

**对"留档可追溯"的满足度**：**高**（真实 PDF 字节 + 与工位同一渲染器 + 有确定性门禁），
前提是把"触发时机、水印开关、模板版本"三件事钉死。

### 路径 C：**不做字节归档，只归档"渲染输入快照 + 模板/渲染器版本"**

**机制**：在签发时把**渲染所需的一切**冻结下来（`render-data` 的完整输入 + 模板/共享样式/渲染器版本指纹），
需要时按快照**重出**同版 HTML/PDF。今天已有部分基础：`raw_payload`（`workstation_links.py:270`）
在开单时冻结上游快照（`trade_docs.py:299,356`），`_payload_parts` 负责拆 `sources/custom`
（`trade_docs.py:606-607`）；渲染器与 Python 归档实现**逐字节等价**（`verify-trade-doc-fixtures.py:1-11`）。

**需要引入的依赖**：**无新依赖**。要加的是一列/一表（快照）与一个指纹（模板+样式+manifest 的内容 hash）。

**改动面**：
- `POST /trade-docs/{id}/confirm`（`trade_docs.py:425-471`；Worker `ws_docs_ext.py:204`）里写快照；
- 表侧加 `render_snapshot`（JSONB）/`template_hash`（TEXT）—— 现在代码里**没有**这两个字段（grep 0 命中）；
- 一个"按快照重出"的读取路径（可复用 `render-data` + `render-trade-doc.ts`）。

**成本与风险**：成本最低、可审计性最强（输入 + 版本身份都留了），
**但它存的是"可复现的配方"，不是 PDF 文件本身**；用户说"pdf 要存"时，这一条**单独不满足**。

**对"留档可追溯"的满足度**：**高（可复现）**，但**不等于"存了 PDF"**。适合作为其它路径的**底座**。

### 路径 D：**Cloudflare Browser Rendering 的 `/pdf`（由 Worker 调用）**

**机制**：Cloudflare 提供无头浏览器渲染服务，`/pdf` 端点接受 `html`（或 `url`）直接返回 PDF。
Worker 可以把前端渲染好的 HTML POST 给它，拿到 PDF 字节后走现成的 `_store_bytes` → `file_objects`。

**核实到的事实**（来自 Cloudflare 官方文档与 OpenAPI，**未在本仓库/本账户验证可用性**）：
- 端点存在：OpenAPI `POST /accounts/{account_id}/browser-rendering/pdf`（"Get PDF"）；
  官方文档当前写作 `/accounts/<accountId>/browser-run/pdf`（**命名不一致，未验证哪个是现行口径**）。
- 用法二选一：**REST API**（需 `Browser Rendering - Edit` 权限的 API Token）
  或 **Workers Binding**（`env.BROWSER.quickAction("pdf", {...})`，**不需要 token**）。
- 必填 `url` 或 `html` 二选一；官方文档写明**请求体上限 50MB**；REST API 限速在 Workers Paid 计划下为 10 req/s。
- **本仓库完全未使用该产品**（全仓 grep 0 命中），也没有 `env.BROWSER` 绑定。

**需要引入的依赖**：Cloudflare Browser Rendering 能力（binding 或 token）+ **确认当前套餐/配额/计费**
（**未验证**：当前账户是否为 Workers Paid、是否已开通、每单成本如何）。

**改动面**：新增一个端点（见 §三），前端多一个"归档"动作；**不需要**我们运维 Chrome。

**成本与风险**：不引入自建浏览器是最大优点；风险是**平台依赖 + 计费/配额未确认 + 输出与本地
Chrome 是否逐字节一致未验证**（不同 Chrome 版本与打印参数会改变分页）。

**对"留档可追溯"的满足度**：**高**（拿到的是真实 PDF 字节，且由 Cloudflare 托管的规范浏览器产生），
但"归档件与用户本地打印件是否一致"仍是一个**必须用规则回答**的问题（见 §四）。

---

## 三、推荐方案

### 3.1 选择

**推荐 = 「C 必做 + D 出字节（生产）+ B 兜底（离线/批量）」；A 只保留 A1 手工兜底，不引入 A2。**

理由（都可回溯到 §一 的事实）：

1. **C 是唯一"零依赖、永远成立"的留档**。渲染器已有逐字节等价门禁（`verify-trade-doc-fixtures.py:1-11`），
   输入又已经部分冻结在 `raw_payload`（`workstation_links.py:270`），补一个模板指纹就能保证"任何时候都能重出同一版"。
2. **PDF 字节必须找一个无头浏览器来产**（§1.4）。在 Cloudflare 上，D 是最短路径：不用自建执行者、
   不用往 Worker 塞 PDF 库；B 作为离线/批量补发与 D 不可用时的兜底。
3. **归档端点不用新写**：`POST /trade-docs/{id}/files/upload` 已能按 `role=render_pdf` 版本化归档
   （`files.py:553-579`），只差 §3.2 第 1 步那个"链接让位"缺口。
4. **A2 明确不做**：它等于承认"另有一套排版"，与"客户看到的就是归档的那版"直接冲突（§四 风险 1）。

### 3.2 最小落地步骤（具体到文件与端点）

> 顺序即依赖顺序；第 1、2 步是"不做就会留坑"的部分，第 3、4 步才是"出 PDF"。

**第 1 步（必做，修缺口）**：把链接层"覆盖"语义补全到 `render_pdf`。

- `backend/orchestrator/app/api/files.py:525`（`if body.role == "stamp_scan":`）
  与 `backend/worker/src/ws_files.py:445`（同条件）改成同时覆盖 `render_pdf`
  （复用同一套 `role='…_superseded'` 写法，例如 `render_pdf` → `render_pdf_superseded`，
  语义与 `stamp_scan_superseded` 一致）。
- 若不改这一步，归档第二版 PDF 后 `GET /trade-docs/{id}/files`（`files.py:488-497`，未过滤 `is_current`）
  会同时返回多份"当前 PDF"。

**第 2 步（必做，C 的底座）—— ✅ 2026-10-12 已实现（**与当时设想的三处不同，见下**）**：
签发时冻结"渲染输入指纹 + 模板/渲染器版本"。

- 落点：`POST /trade-docs/{id}/confirm`（orchestrator `backend/orchestrator/app/api/trade_docs.py`；
  Worker `backend/worker/src/ws_docs_ext.py`）。
- 实际存的是**指纹**（不是快照本体）：`raw_payload._render = {render_version, input_sha256, frozen_at}`，
  形状与冻结时机见 §〇.2。
- 与本文原设想的三处差异（**以实际实现为准**）：
  1. **不塞进 `custom`**：放在 `raw_payload` 的**顶层保留键** `_render`（与 `_audit` 同风格）——
     既不改 `PROTECTED_CUSTOM_FIELDS` 口径，也不会被 `custom` 覆盖；
  2. **不新增列/表**（迁移成本与并发风险都省了）；
  3. **不存 `render_snapshot` 本体**：只存摘要（原始设想里的"完整输入"含 data URI 图片，
     一张 PI 约 1.4MB，抄进 `raw_payload` 会撑爆行）⇒ 能证明"输入是否一致"，不能凭它重出。
     真要"按快照重出"，仍需另做（**未做**）。
- `template_hash` 在本实现里由 `render_version`（人工 bump 的常量）承担 —— 主动、便宜，
  但**靠人守**：改模板/渲染器必须 bump，理由与纪律见 §〇.2 与内核注释。

**第 3 步（出 PDF 字节）**：新增两端一致的端点 `POST /api/v1/trade-docs/{doc_id}/pdf`。

- 入参：`html`（前端**预览用的那一份**，见第 4 步）+ `template_hash`（可选，用于对账）。
- 服务端：`worker` 侧用 Browser Rendering（binding `env.BROWSER.quickAction("pdf", …)`，或 REST+token）；
  `orchestrator` 侧（本地/dev）用本机 Chrome 的既有配方（`docs/TRADE_DOC_TEMPLATES.md:163`）。
- 产出后**复用现有**写入路径：`_store_bytes` → `_create_file(kind="render_pdf", content_type="application/pdf", supersede=True)`
  → `attach_doc_file(role="render_pdf")`（`files.py:571-578`；`ws_files.py:480-487`）。
- **路由要两端齐平**（`scripts/route-parity.py`），否则线上 404/漂移。

**第 4 步（前端入口）**：在 `doc-preview.tsx` 旁加「归档本版 PDF」，把**预览同源的那份 HTML**
（`doc-preview.tsx:37-45` 的 `html`）交给第 3 步端点 —— 这样"归档的输入"与"用户看到的"就是同一个字符串。

**第 5 步（兜底，可选）**：`scripts/render-trade-doc.ts` 加 `--pdf`（内部起 Chrome/Playwright），
用于离线/批量补发；归档时必须 `--no-watermark`（`scripts/render-trade-doc.ts:108-112`）。

### 3.3 不做什么（防范围蔓延）

- **不在 Worker（Pyodide）里生成 PDF**，也不引入 `reportlab/weasyprint/pdfkit` 之类（§1.4）。
- **不引入 jspdf + html2canvas**（§二 A2 的理由）。
- **不把 PDF 字节写进业务表列**：沿用 `file_objects` + 对象存储（`storage` 三档优先级，§1.3）。
- **不改渲染器白名单**、不动 18 份渲染基线（`verify-trade-doc-fixtures.py` 的逐字节证明必须保持）。
- **不做 PDF 编辑/合并/加水印/电子签章**——本文只解决"留档"。
- **不擅自开通按量计费的 Browser Rendering**，也不擅自改动生产 secrets/绑定（需用户拍板）。
- **不为了"能出 PDF"而退役或复用历史 `file_objects` 行**：版本链靠 `supersedes_id`/`is_current`。

---

## 四、风险与边界

**风险 1（最关键）：「客户看到的是浏览器打印版，归档的是另一版」**

- 防法 a：**归档输入必须与预览同源** —— 前端把 `doc-preview.tsx:37-45` 用的那份 `html` 直接交给归档端点，
  不允许"再渲染一次"。
- 防法 b：**PDF 只由一个规范渲染器产生**（D 或 B），且把 `template_hash` + 输入 hash 一起入库，
  事后可核对"这份 PDF 是哪一版算出来的"。
- 防法 c：**明确"归档版为唯一权威版"**，并在 UI 上说明：用户本机打印（纸型/缩放/"背景图形"，
  见 `docs/TRADE_DOC_TEMPLATES.md:75`）产生的纸质件**以归档版为准**。
- 残余风险：用户本机打印设置差异**无法从技术上消除**，只能靠上述口径 + 归档 sha256 事后辨认。

**风险 2：Chromium 分页的已知限制**

- `docs/TRADE_DOC_TEMPLATES.md:290-294` 的既有实测结论：Chromium **忽略 `break-before/after: avoid`**，
  给 `table.sign` 加与不加产物 SHA256 相同 ⇒ "签章区绝不孤零零落在新页"**纯 CSS 保证不了**
  （真要做得动全部 18 个模板加包裹层，本次不做）。
- ⇒ **同一浏览器版本下可复现，跨版本可能变**。所以归档必须记录渲染器版本；
  并且不能用"字节不同"直接判定"单据被改过"。

**风险 3：时间/身份可信度**

- 归档件要记录：归档人、归档时间、来源（自动/人工）、对应单证状态。
  `confirm` 已有 `issued_at/issued_by`（`trade_docs.py:466-468`），归档动作应与之关联。

**风险 4：存储落点与体积**

- 三档优先级下，若生产 S3 密钥/binding 都不可用会**回退 inline 写库**（写 `file_objects.content` 列），
  PDF 上限 32MB（`rules.py:53`）⇒ 会撑大业务表。建议归档件在生产必须走对象存储，
  并在归档响应里如实回传 `storage`（现有实现已如此，`files.py:180-203`）。

**风险 5：权限与直链**

- 归档件是业务资料：访问控制沿用 `file_objects`/单证归属 + 短时效直链（`GET /file-objects/{id}/url`
  默认 900 秒），**不要**为 PDF 另开公开链接。

**风险 6：重复归档**

- 同一份 PDF 重复提交时，key 里带 `sha256`（`kaas_common/files` 的 `object_key`；有测试
  `backend/orchestrator/tests/test_files_kernel.py:97`「deterministic and dedupe by sha」卡住）可去重；
  但**版本语义仍以 `supersede` 为准**，不要在 UI 上把"去重"说成"已归档过"。

---

## 五、未验证事项（明确列出来，避免被当成结论）

> 共 6 条。**2026-10-11 晚更新：第 1–3 条已用真实调用核实**（结论见 §〇 表格），
> 第 6 条此前已核对并修正；**仍开放的是第 4、5 条**。

1. ~~**Cloudflare Browser Rendering 在本账户的可用性**~~ **✅ 已实测（§〇）**：可用、无需付费；
   账号订阅为 `teams_free` / `r2_paid`（均 price 0），Browser Rendering 自带
   Free 10 分钟/天、Paid 10 小时/月。
2. ~~**端点命名口径**~~ **✅ 已实测（§〇）**：`/browser-rendering/pdf` 与 `/browser-run/pdf`
   两条 POST 都返回 200；代码采用 OpenAPI 依据的 `/browser-rendering/pdf`。
3. ~~**Browser Rendering 输出与本地 Chrome `--print-to-pdf` 是否逐字节一致**~~ **✅ 已判为"不能假定一致"**：
   本次实测只证明"能拿到真 PDF 字节"，**没有**做与本地 Chrome 的逐字节比对；§四 风险 1/2 的
   口径（以归档版为准、记录渲染器）仍然适用。
4. **单证 HTML 的实际体积与渲染耗时**（文档只给到请求体 50MB 上限）—— **未实测**
   （本次探针是最小 HTML；内核把入参上限定在 2MB 作为防滥用上限）。
5. **生产是否真的存在 `render_pdf` 记录**：本文引用 `docs/PROBLEM_STATUS_2026-10-11.md:1873`
   的"生产 `trade_docs=0`"，**本次未直连生产库复查**。
6. ~~**`docs/TRADE_DOC_TEMPLATES.md:130` 写的 `GET /api/v1/trade-docs/{id}/render`**~~ **✅ 已核对并修正**：
   该路由在代码里确实不存在（已核实的路由清单见 §1.5），而**该文档行已被修正为 `render-data`**，
   现存说法与代码一致 —— 本条**不再是**未验证事项。

---

## 附：复现本文结论的关键命令

```bash
# 「render_pdf 没有生产者」：只在规则/迁移/让位判断/展示过滤/测试里出现
grep -rn "render_pdf" backend frontend | grep -v node_modules

# 「后端没有 PDF 能力 / 没有无头浏览器」
grep -rniE "weasyprint|reportlab|pdfkit|fpdf|pypdf|puppeteer|playwright" backend

# 「仓库未使用 Cloudflare Browser Rendering」
grep -rniE "browser-rendering|browser_rendering" . | grep -v node_modules

# 「没有模板/渲染器版本」（0 命中 = 缺口）
grep -rn "template_hash\|render_version" backend frontend

# 「前端根本没有调 render_pdf 的上传点」
grep -rn "files/upload\|stamp_scan" frontend/src

# 既有的两端端点清单（确认没有 /render）
grep -n "@router\.\(get\|post\|patch\|put\|delete\)" backend/orchestrator/app/api/trade_docs.py
grep -n "@app\.\(get\|post\|patch\|put\|delete\)" backend/worker/src/main.py
```
