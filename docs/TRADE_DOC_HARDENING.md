# 单证加固 A7（事实层 + 一致性引擎 + 回执 + 导出自检）· 活跃设计

> **状态：施工中（2026-10-21 起）**。本文件是 A7 的**活跃设计/口径**文档（施工依据），
> 历史复盘与原始方案在 `docs/archive/2026-10-20-closeout/TRADE_DOC_HARDENING_PLAN_2026-10-12.md`
> （只读留档；与本文冲突时以本文为准）。
> 待办账本：`docs/TODO.md` §A7（子项 A7-①~⑤）；拍板记录：`docs/UNCERTAIN.md` #17。

## 1. 目标（一句话）

把单证从「能开单」变成「不容易开错单」：payload 字段升级为**可追溯、有信任级、不可改写**的事实；
跨单证（同一交易域）事实差异可发现；收款差额有容差口径；`not_by_us` 单证有回执登记；
导出后自检默认阻断、可配置越过并落审计。

## 2. 分期与现状（2026-10-21）

| 期 | 内容 | 状态 |
|---|---|---|
| A7-内核 | 事实层 `facts.py`、一致性引擎 `consistency.py`、等价词表 `equivalents.py`（纯 stdlib） | ✅ 2026-10-21（87 条内核测试） |
| A7-结构 | `trade_doc_facts` 表（迁移 `202610200004`）+ ORM `TradeDocFact`；`trade_doc_receipts`/`trade_doc_doc_set_items`（迁移 `202610170003`） | ✅ 2026-10-21（114表→105+1；`alembic check` 无新操作） |
| A7-API | Worker 端点：facts 读/确认、consistency、lint、receipts、doc-set、verify-export、confirm 闸门 | 🔨 进行中 |
| A7-UI | 单证详情「一致性」页签、事实确认/信任级、回执登记、单证清单、导出后自检提示 | ⏳ |
| A7-验收 | 计划 §8 八条可执行断言 + 真实 18 类单证端到端（C12） | ⏳ |

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

## 5. 端点草案（A7-API，实施中）

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

## 6. 验收（计划 §8 可执行断言，UI/端到端阶段跑）

1. 一致性：删 CI 的 Incoterms 版本 → `FACT_CONFLICT(incoterm)`；SC `upon dispatch`→`before dispatch` 冲突；
   `before dispatch`→`upon dispatch (before delivery)` 不冲突（词表内）。
2. 可信级：存在 `trust=inferred` ⇒ confirm 返回 `FACT_UNVERIFIED`；确认后通过。
3. 不可改写：基线 `payment_deposit_ratio=0.30` 在派生单改成 0.5 ⇒ `FACT_IMMUTABLE`（带原值/新值）。
4. 单证清单：`pl.role=not_by_us` 时建 PL ⇒ `DOC_SET_NOT_ALLOWED`；`wood_packing=false` 时 PD 触发条件不满足 → 提示。
5. 引用完整性：停用 PL ⇒ 返回合同/装运通知里 6 条引用；未处理则导出阻断。
6. 收款：实收 847.93 vs 合同 847.95 ⇒ 容差内 `fx_rounding` 自动核销；差额 12.00 ⇒ `short_paid` 告警。
7. 导出自检：行高截断 ⇒ "单元格文本未出现在 PDF 中"；公章跨页 ⇒ "图片计数 ≠ 1"。
8. 双语对偶：只改中文栏 ⇒ `ZH_ONLY_CHANGE`（需改前/改后轨迹，属 UI 阶段）；英文 `buyer buyer` ⇒ 重复词告警。

## 7. 与其它待办的关系

- **A4 素材库**：与本文无关（图片走对象存储/去 base64，见 TODO A4 与拍板项 G-4）。
- **A5/A6**：A5 编辑体验会用本文的事实层做金额联动校验；A6 真单据对照是最终验收标准（需用户样例）。
- **C12**：真实 18 类单证端到端属"导出后自检"的验收前置（发布后）。
- **C1/C13**：`not_by_us` 回执与 outreach 收紧口径在本文 §5 之外，按各自待办处理。
