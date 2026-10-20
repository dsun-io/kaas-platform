# 单证加固 A7（事实层 + 一致性引擎 + 回执 + 导出自检）· 已完成设计 + 验收记录

> **状态：✅ 已完成（2026-10-21 收口）**。内核 / 结构 / API / UI 全部落地并通过门禁：
> 内核 **87 测**（`tests/test_trade_doc_facts.py` + `tests/test_trade_doc_consistency.py`）、
> API **34 测**（`tests/test_trade_doc_hardening_api.py`）、前端面板 **9 测**
> （`doc-hardening-panels.test.tsx`）、契约 **12 测**（`doc-hardening-contract.test.ts`）；
> `POST /trade-docs/{id}/confirm` 默认拦截未确认事实（`allow_lint_override` 未对前端开放，越过必落审计）。
> **唯一尾巴**：导出后自检的 **UI** 需 PDF 文本抽取（`docs/TODO.md` C21）；真实 18 类单证端到端属 C12。
> 本文件既是 A7 的**设计/口径**（后续维护按此），也是**验收记录**；历史复盘与原始方案在
> `docs/archive/2026-10-20-closeout/TRADE_DOC_HARDENING_PLAN_2026-10-12.md`（只读留档；冲突以本文为准）。
> 待办账本：`docs/TODO.md` §A7（A7-①~⑤ **全部 ✅**）；拍板记录：`docs/UNCERTAIN.md` #17。

## 1. 目标（一句话）

把单证从「能开单」变成「不容易开错单」：payload 字段升级为**可追溯、有信任级、不可改写**的事实；
跨单证（同一交易域）事实差异可发现；收款差额有容差口径；`not_by_us` 单证有回执登记；
导出后自检默认阻断、可配置越过并落审计。

## 2. 分期与现状（2026-10-21）

| 期 | 内容 | 状态 |
|---|---|---|
| A7-内核 | 事实层 `facts.py`、一致性引擎 `consistency.py`、等价词表 `equivalents.py`（纯 stdlib） | ✅ 2026-10-21（87 条内核测试） |
| A7-结构 | `trade_doc_facts` 表（迁移 `202610200004`）+ ORM `TradeDocFact`；`trade_doc_receipts`/`trade_doc_doc_set_items`（迁移 `202610170003`） | ✅ 2026-10-21（114表→105+1；`alembic check` 无新操作） |
| A7-API | Worker 端点：facts 读/确认、consistency、lint、receipts、doc-set、verify-export、confirm 闸门（`ws_docs_hardening.py`） | ✅ 2026-10-21（34 条 API 测试） |
| A7-UI | 单证详情「加固」区：事实确认/信任级、一致性三档、收款登记、单证清单、导出后自检提示（`doc-hardening-*.tsx`） | ✅ 2026-10-21（面板 9 测 + 契约 12 测） |
| A7-验收 | 计划 §8 八条可执行断言（见 §6） | ✅ 1–6 已由 API 测覆盖；7–8 的**真实 PDF/打印**部分待 C21 与 build/e2e 人工复核；真实 18 类单证端到端属 C12 |

## 3. 内核 API（真源：`backend/kaas_common/trade_doc/`）

- `facts.py`：`Fact`（key/value/text_zh/text_en/source/trust/immutable/evidence/confirmed_*）、
  `normalize_fact_key`、`normalize_fact_value`、`extract_facts(payload, doc_type)`、`parse_payment_terms`、
  `gate_trust(facts, target_status)`、`check_immutable(base, derived)`、
  `derive_amount/derive_unit_price/assert_no_manual_amount/check_derived_amount`、`render_tbc`、
  错误码 `FACT_CONFLICT / FACT_UNVERIFIED / FACT_IMMUTABLE / FACT_MANUAL_AMOUNT / FACT_MISSING / EQUIVALENT_WORDING`。
- `consistency.py`：`diff_facts(doc_facts, root=…) → list[FactDiff]`（三态 **conflict / equivalent / missing**）、
  `lint_pair(source, derived) → list[FactCheck]`、`equivalent(a, b, extra=…)`、`IDENTITY_KEYS`。
- `equivalents.py`：`EQUIVALENT_GROUPS`（仅此处列出的才算等价）、`TIMING_GROUPS`、`INCO_TERMS`、
  `equivalent_text`（整串 → 付款条款签名 → Incoterms → 金额 → 日期）、`incoterm_parts/incoterm_equivalent`、
  `amount_parts/date_parts`、`normalize_text/canonical_phrase/payment_clause_signature`。

## 4. 实现裁决（内核作者 2026-10-21，**后续 UI/验收按此口径**）

1. **容差只用于总额/行金额**（`max(5 美分等值, 0.1%)`）；`unit_price/qty/fx_rate/*_ratio` 精确比较——
   5 美分下限对单价 0.3252 相当于 15% 宽容度，会吞掉真实翻车（0.3253 vs 0.3252）。
2. `root` 双语义：命中 `doc_facts` 的键即基线；否则视为交易域名（默认 order），基线取插入序第一份。
3. **身份事实不跨单证比**：`doc_no`/`date`（`IDENTITY_KEYS`）默认排除；引用完整性另属一层。
4. **diff 三态**：`equivalent` 对应产品形态"⚠ 等价措辞"，**绝不静默吞差异**；`check_missing` 默认关。
5. **付款条款用结构签名**（比例 + 时点规范名 + 去时点/比例后的残余文字），只放过时点措辞差异；
   角色词（deposit/balance）必须一致；裸 `upon dispatch` 不与带限定语版本等价（少限定语即不符点）。
6. **付款条款解析结果 = unverified** ⇒ confirm 前必须逐项确认（A7-API 的"确认事实"路径；
   这是**预期交互**，不是 bug）。
7. **不可改写只圈条款**（incoterm/payment_*/currency/fx_rate/ports/origin/marks）；金额不 immutable
   （部分出运时 CI 与 PI 金额天然不同）。
8. `assert_no_manual_amount` 是严格入口闸门（手填金额即 `FACT_MANUAL_AMOUNT`，填对也不收）；
   存量脏数据走 `check_derived_amount` 报 `FACT_CONFLICT`。
9. `items`/`total_amount` 仍受 `PROTECTED_CUSTOM_FIELDS` 保护（与渲染侧同一道闸门）。
10. 中文大写金额不支持"亿+万"复合写法（>1 亿）→ 退化为文本比较报冲突（不算错）。
11. 租户增量词表通过 `extra` 透传，内核不读库；租户新增分组也按"时点分组"处理。
12. 双语：抽取只填原文一侧，不机翻；`render_tbc` 两侧恒有占位，不存在空单元格。

## 5. 端点（A7-API，**已实现**：`backend/worker/src/ws_docs_hardening.py`）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/v1/trade-docs/{id}/facts` | 事实列表（payload 抽取 + `trade_doc_facts` 覆盖 trust/immutable/双语/证据） |
| POST | `/api/v1/trade-docs/{id}/facts/confirm` | 确认事实（keys 空=全部 unverified），写 confirmed_by/at |
| PATCH | `/api/v1/trade-docs/{id}/facts/{key}` | 改 trust/immutable/双语/证据；**改 value 一律 422** |
| GET | `/api/v1/trade-docs/{id}/consistency` | 同交易域事实 diff（conflict/equivalent/missing 三态） |
| POST | `/api/v1/trade-docs/{id}/lint` | 组合检查：trust/immutable/金额推导/引用完整性/清单允许性 |
| GET/POST | `/api/v1/trade-docs/{id}/receipts` | 收款登记（容差判定写 `trade_doc_receipts`） |
| GET/PUT | `/api/v1/trade-docs/{id}/doc-set` | 单证清单（role/issuer/trigger，全量替换） |
| POST | `/api/v1/trade-docs/{id}/doc-set/{doc_type}/receipt` | `not_by_us` 回执：pending→received/waived |
| POST | `/api/v1/trade-docs/{id}/verify-export` | 导出后自检（文本⊆PDF、图片计数）；默认阻断，可越过并落审计 |
| — | `POST /trade-docs/{id}/confirm`（扩展） | 签发前跑 lint blocking 项，`FACT_UNVERIFIED` 等阻断 |

## 6. 验收（计划 §8 可执行断言 · **2026-10-21 执行结果**）

1. ✅ 一致性：删 CI 的 Incoterms 版本 → `FACT_CONFLICT(incoterm)`；SC `upon dispatch`→`before dispatch` 冲突；
   `before dispatch`→`upon dispatch (before delivery)` 不冲突（词表内）。
   — 已由 `test_trade_doc_hardening_api.py::test_consistency_*` 覆盖。
2. ✅ 可信级：存在 `trust=inferred` ⇒ confirm 返回 `FACT_UNVERIFIED`；确认后通过。
   — `test_confirm_blocked_by_unverified_facts_then_passes_after_confirm`。
3. ✅ 不可改写：基线 `payment_deposit_ratio=0.30` 在派生单改成 0.5 ⇒ `FACT_IMMUTABLE`（带原值/新值）。
   — `test_lint_flags_rewritten_immutable_term` + `test_confirm_blocked_by_rewritten_immutable_term`。
4. ✅ 单证清单：`pl.role=not_by_us` 时建 PL ⇒ `DOC_SET_NOT_ALLOWED`；`wood_packing=false` 时 PD 触发条件不满足 → 提示。
   — `test_lint_flags_not_by_us_doc_type` + `test_doc_set_put_*`。
5. ✅ 引用完整性：停用 PL ⇒ 返回合同/装运通知里 6 条引用；未处理则导出阻断。
   — `test_lint_flags_broken_doc_reference`（`DOC_REF_BROKEN` blocking）。
6. ✅ 收款：实收 847.93 vs 合同 847.95 ⇒ 容差内 `fx_rounding` 自动核销；差额 12.00 ⇒ `short_paid` 告警。
   — `test_receipt_within_tolerance_auto_reconciled` / `test_receipt_beyond_tolerance_is_short_paid`。
7. ⏳ **部分**：导出自检的 **API 契约**已测（`test_verify_export_*` 4 条：默认阻断、图片计数不符、`allow_override` 越过并落审计）；
   **真实 PDF 文本抽取**（行高截断 ⇒ "单元格文本未出现在 PDF 中"；公章跨页 ⇒ "图片计数 ≠ 1"）
   **待 build/e2e + 人工打印复核**（UI 依赖 PDF 文本抽取，见 `docs/TODO.md` C21）。
8. ⏳ **部分**：双语对偶的内核/API 基础（双语成对、`text_zh/text_en` 叠加、改值 422）已测；
   「只改中文栏」的**改前/改后轨迹**属 UI 交互，**待 build/e2e 人工复核**（未单列待办，并入 C21）。

## 7. 与其它待办的关系

- **A4 素材库**：与本文无关（图片走对象存储/去 base64，见 TODO A4 与拍板项 G-4）。
- **A5/A6**：A5 编辑体验会用本文的事实层做金额联动校验；A6 真单据对照是最终验收标准（需用户样例）。
- **C12**：真实 18 类单证端到端属"导出后自检"的验收前置（发布后）。
- **C1/C13**：`not_by_us` 回执与 outreach 收紧口径在本文 §5 之外，按各自待办处理。

## 8. 导出后自检 UI（C21 · 2026-10-21 落地）

> **补记**：文件头部「唯一尾巴（导出后自检 UI 需 PDF 文本抽取）」与 §6-7 里的 UI ⏳ 项，
> **UI 侧已由本节关闭**；"真实 18 类单证端到端 + 人工打印复核"仍属 C12（发布后），不在本节。

### 8.1 职责划分（写死，不许漂移）

| 层 | 职责 | 位置 |
|---|---|---|
| 前端 | **只抽事实**：PDF 文本、图片绘制张数；从"与预览同源"的渲染 HTML 抽应出现的文本；从渲染数据算期望图片数 | `frontend/src/lib/trade-doc/pdf-extract.ts` |
| 后端 | **唯一裁决**：文本⊆PDF、图片计数相符；默认 422 阻断，`allow_override` 才放行并写 `trade_doc.export_override` 审计 | `backend/worker/src/ws_docs_hardening.py` `verify_trade_doc_export` |
| UI | 展示三态：通过 / 阻断（逐条明细）/ 无法自检（解析失败，**不调用后端**）；**不提供 allow_override 入口** | `frontend/src/app/(app)/trade-docs/components/doc-export-verify-panel.tsx` |

入口：单证详情 →「单证加固」→「导出自检」tab。自检对象优先取**已归档的** `role=render_pdf`
（`GET /trade-docs/{id}/files` 里 `is_current` 的那份；字节走 `GET /file-objects/{id}/content`，
Bearer 授权）；没有归档件时用文件选择器直接选本地导出的 PDF（不伪造来源）。

### 8.2 文本清单从哪来

用 `renderTradeDoc(doc_type, data)`（**与预览/打印同一份渲染器**）生成 HTML，再取段落级元素
（`td/th/h1..h6/p/li/caption…`）的 `textContent`（去空白、去重）。理由：单据上写的是格式化后的
字符串（千分位、金额大写、日期），拿原始字段值比对会整批假报警；后端按"去掉全部空白"做子串
比对，能吸收 PDF 的断行/插空格。

### 8.3 图片计数口径（后端默认 key 只有 `stamp`）

PDF 抽取无法区分"公章"和"产品图"，而后端默认期望是 `{"stamp": 1}`（一张单证只盖一枚章）。
本系统单证只可能渲染两种图（`company_stamp` 至多 1 张 + `product_photos` N 张），且两者都能从
**渲染数据（服务器装配的真值）**算出，因此：

- `expected_image_counts.stamp` = 渲染数据里的**公章**期望张数（0/1）；
- `image_counts.stamp` = 抽取的图片总数 − 渲染数据里**可渲染产品图**张数（"非产品图图片数"）。

两者相等 ⟺ "PDF 里的图片总数 == 渲染数据应该渲染的图片总数"，仍由后端做相等裁决。
图片按**绘制操作**计数（`paintImageXObject` / `paintInlineImageXObject` / `paintImageXObjectRepeat`；
遮罩/纯色填充不算内容图）——同一张公章跨页重复绘制会各算一次，正是"公章劈页"的检测信号。

### 8.4 依赖与体积（pdf.js 只在点「自检」时加载）

- 依赖：`pdfjs-dist@4.10.38`（选 v4 而非 v6：v6 依赖 `Uint8Array.prototype.toHex` 等更新运行时 API，
  v4 engines `node>=20`、Chromium 兼容面更广；本地 Node 24 实测 v6 报 `toHex is not a function`）。
- **动态 import**（`await import("pdfjs-dist")`）⇒ 不进首屏包，首屏影响 **0**；
  首次点「自检」增量下载 ≈ **99–133 KB gzip**（v4 `build/pdf.min.mjs` 98.7 KB gzip / `pdf.mjs` 133 KB gzip）
  \+ **≈402 KB gzip** worker（`build/pdf.worker.min.mjs`，同样按需拉取）。
- worker 地址用 `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)` 交给打包器发射。
  **发布检查项**：`NEXT_EXPORT=1 pnpm build` 后确认该 worker 资产已随构建产出（本次未跑 build）；
  若打包器未发射，自检会显示"解析失败"（不会假通过），届时把 worker 放进 `public/` 并改 `workerSrc`。

### 8.5 失败语义与已知限制

- **通过**：后端 200 → 绿色"自检通过（后端裁决）"+ 页数/图片数/核对文本数；`overridden=true` 会额外
  标"已越过并留痕"（普通 UI 不会出现）。
- **阻断**：后端 422 `EXPORT_SELF_CHECK_FAILED` → 红色面板逐条列 `missing_texts`（行高截断）与
  `image_mismatches`（如公章 2 张）；文案明确"修正版式后重新导出再自检，越过需管理员留痕"。
- **无法自检**：PDF 加密/非 PDF/坏文件/超 32MB → 黄色面板如实提示，**不调用后端**、不显示通过。
- 已知限制：PDF 连字（ﬁ）或强制连字符断词可能造成个别"文本缺失"误报（后端去空白比对已覆盖
  多数断行）；图片计数按绘制次数、不含遮罩类装饰。误报时以阻断明细为准人工判断，**不提供自动越权**。

### 8.6 测试

- `frontend/src/lib/trade-doc/__tests__/pdf-extract.test.ts`（**12 条**）：文本拼接、图片绘制计数口径、
  错误映射（加密/非 PDF/其它）、worker 配置幂等、HTML→文本、期望图片数、请求体 `stamp` 翻译。
- `frontend/src/app/(app)/trade-docs/components/__tests__/doc-export-verify-panel.test.tsx`（**4 条**）：
  通过 / 阻断 / 解析失败（**不调用后端**）/ 无归档件时本地文件自检。
- 真实 PDF 抽取：用真 `pdfjs-dist@4.10.38` + 手写最小 PDF（1 页、1 张 2×2 RGB 图、文本
  `Hello PDF Self-Check`）在 Node 一次性验证 → 抽取结果 `pages=1, images=1, text` 完全一致
  （脚本不入库；CI 只跑 mock 的确定性用例）。
