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
**任何非 `data:` 的资源地址（含 CSS `url()`/`@import`）** 一律 **422**；HTML ≤2MB。
未配渲染器 → **503 `PDF_RENDERER_NOT_CONFIGURED`**（不假装成功）；上游失败/返回非 PDF → **502**。
证据：`backend/orchestrator/tests/test_render_pdf.py`、`backend/worker/tests/test_ws_render_pdf.py`、
`frontend/src/app/(app)/trade-docs/components/__tests__/doc-preview-auto-pdf.test.tsx`。
其中 `test_render_pdf.py` 另用 **18 份渲染基线**（`frontend/src/lib/trade-doc/__fixtures__/html/*.html`，
渲染器真实产物、与归档 Python 版逐字节对账）断言**全部**通过安全校验 —— 证明这道门不会误伤自家单据，
同时钉住"渲染器不得产出脚本/外链"。

**仍未做 / 未验证**：① 自动出字节**依赖在真实环境配好 binding（生产）或 token（本地）**，
未配置时接口如实 503；② 本仓库**没有**用真实单证跑过一次端到端（实测用的是最小 HTML 探针，
不是 18 类单证的真实 HTML）；③ **版面/分页仍然无法在无头环境验证**（见下文 §四 风险 1、风险 2：
Chromium 忽略 `break-before/after: avoid`，跨 Chrome 版本分页可能变）；④ C 方案（签发时冻结渲染输入
快照 + 模板指纹）**仍未做**，本文 §3.2 第 2 步仍是待办。

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

**第 2 步（必做，C 的底座）**：签发时冻结"渲染输入快照 + 模板/渲染器版本"。

- 落点：`POST /trade-docs/{id}/confirm`（orchestrator `backend/orchestrator/app/api/trade_docs.py:425-471`；
  Worker `backend/worker/src/ws_docs_ext.py:204`）。
- 存什么：`render_snapshot`（`render-data` 的完整输入，含企业主体与已解析图片源）
  + `template_hash`（模板 + 共享样式 + `manifest.json` 的内容 hash）
  + `renderer` 标识（例如产生时用的 Chrome/运行时版本）—— **这三样现在都没有落库**
  （前两个标识符 grep 0 命中；渲染器版本没有任何记录字段）。
- 存放位置：新增列或新表（迁移）；**不要**塞进 `raw_payload.custom`（那是给用户改的字段，
  且 `custom` 有 `PROTECTED_CUSTOM_FIELDS` 与审计语义，混用会破坏既有口径）。

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
