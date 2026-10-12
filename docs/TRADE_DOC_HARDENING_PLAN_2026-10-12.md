# 单证工位加固方案（源起：2026-10-12 Tim 单全流程实操复盘）

> 本文是**设计方案，不含实现**。目的是把 2026-10-12 一单真实出口单证的实操经验，
> 抽象成单证工位（trade-docs）可吸收的能力，让工位"从能开单"变成"不容易开错单"。
>
> 关联：[TRADE_DOC_WORKSTATION_STATUS.md](./TRADE_DOC_WORKSTATION_STATUS.md)（当前实现口径）·
> [TRADE_DOC_WORKSTATION_PLAN.md](./TRADE_DOC_WORKSTATION_PLAN.md) ·
> [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md)（现存问题）·
> [TRADE_DOC_TEMPLATES.md](./TRADE_DOC_TEMPLATES.md)

---

## 0. 一句话

今天的单证是**离线脚本**（`D:\projects\报价制作\.tools\`）一笔一笔手工生成的，过程中被客户当面揪出
**6 类实质错误**（口径漂移、推断写单、单据越权、引用悬空、金额零头、中英不同步）。
这些错误**全都不是排版问题，而是"事实层没有约束"**。本方案就是把约束补进工位。

---

## 1. 素材来源：Tim 单做了什么

一单真实业务（澳洲客户 Tim Lyons，USD 2,826.49，DAP 江苏扬州交货、由买方供货商拼柜出运），
从 PI 之后连续产出：**CI 商业发票 / Shipping Advice 装运通知 / ChAFTA COO 申报数据表 / Sales Contract 销售合同**
（原还出过 Packing List 装箱单、Packing Declaration 木包装声明，**按事实判定后停用删除**）。

配套脚本（可视为工位能力的**离线原型**，建议吸收；**源码已随本方案归档**，见 §11）：

| 脚本 | 能力 | 对应工位缺口 |
|---|---|---|
| `make_tim_post_pi_docs.py` | 一套 4 单证分页感知生成 + 公章锚定 | 模板/排版内核 |
| `verify_tim_post_pi.py` | xlsx 全文本 ⊆ PDF 文本（查遮挡截断）+ 公章图片计数=1（查劈页） | **导出后自检** |
| `check_pi_sc_ci.py` | 54 条业务事实 + 3 组条款原句的**三方一致性矩阵** | **跨单证一致性引擎** |
| `check_ct_vs_pi.py` | 合同对 PI 的 43 条承继核对 | 基线不可改写校验 |

---

## 2. 现状基线（工位已有什么）

| 已有能力 | 位置 | 说明 |
|---|---|---|
| 18 类单证枚举 | `backend/orchestrator/app/domain/enums.py` `DOC_TYPE` | 出口商自制 12 + 第三方签发 5 + 通用 1 |
| 状态机 draft→issued→void | `backend/kaas_common/trade_doc/rules.py` | issued 只能 void；`assert_draft` 拦 PATCH |
| 派生闸门 | 同上 `assert_derivable` | 仅 issued 源可派生，否则 SOURCE_NOT_CONFIRMED |
| 确认必填 + 行金额勾稽 | 同上 `validate_confirm` / `check_line_amount` | qty×price，ROUND_HALF_UP，4 位小数 |
| 字段合成优先级 | `payload.py` | 手工 > 派生 > 主体 > 默认；`freeze_snapshot` |
| 单号 | `docno.py` | `{PREFIX}-{YYYYMM}-{SEQ:04d}` |
| 派生引用表 | `trade_doc_doc_refs`（迁移 202609300001） | 记了引用，**但无引用完整性校验** |
| 付款计划枚举 | `enums.py` `SCHEDULE_TYPE(deposit/balance/full)` `SCHEDULE_STATUS(pending/paid/overdue)` | 有模型，**无"实收金额/差额"** |
| 前端必填检查 | `frontend/src/lib/trade-doc/compliance.ts` | `findMissingRequiredFields` / `isIssuable`，**只查字段是否为空** |
| 模板字段清单 | `frontend/src/lib/trade-doc/manifest.json` | 按 doc_type 列 fields（type/required/description） |

**缺口一句话**：现有校验全部是**单证内、字段级**的（空不空、qty×price 对不对）。
今天暴露的问题全部在**跨单证、事实级、可信级**，工位完全没有防线。

---

## 3. 复盘 → 抽象：今天真实翻车的 14 条

> 每条格式：**现象**（当天真实发生）→ **根因** → **抽象能力**（要进工位的东西）

| # | 现象（真实） | 根因 | 抽象能力 |
|---|---|---|---|
| 1 | CI 写了 `(Incoterms 2020)`，SC 只写 `DAP Yangzhou, Jiangsu, China` | 同一事实在多份单证里各写各的 | **事实一致性引擎**：同一交易内同名 fact 必须同值 |
| 2 | CI 写 `70% balance before dispatch`，SC 写 `upon dispatch (before delivery)` | 付款时点被"改述" | 付款条件作为**结构化 fact**（时点枚举 + 比例），不允许自由文本各写 |
| 3 | 核对脚本把绝缘子单价写成 0.3253，实际 2.18/6.7029=0.3252 | 人工抄数 | 单价/金额一律**由汇率与数量推导**，不提供手抄入口 |
| 4 | 客户反问"PI 中写的业务条款你不能更改" | 派生单可任意覆盖上游 | **基线优先 + 不可改写字段集**（PI 为客户签回基线） |
| 5 | 我从邮箱域名 `oneatmosphere.com` 推出买方公司名 "One Atmosphere" 写进合同 → 被严厉批评 | 系统/助手**推断值直接落单** | **fact.source / trust 分级**；推断值不得进 issued，导出渲染为 TBC |
| 6 | 我推断"整柜由钧骋报关"，写进 CI 的 Note → 用户：不要乱写 | 同上 | 同上 + **禁写"第三方动作"**白名单 |
| 7 | 木托 ISPM-15 声明被我当成事实写进木包装声明 | 缺"包装材质"来源 | 材质/包装类 fact 必须来自 PO/PI 或人工确认 |
| 8 | 装箱单我方并不该出（不负责装箱），却先出了一版 | 单证清单没有**责任方**概念 | **单证清单 checklist**：required/optional/not_by_us + issuer |
| 9 | 无木包装却出了 Packing Declaration | 同上，缺前置条件 | 单证**触发条件**（有木质包装才需 ISPM-15 声明） |
| 10 | 删掉装箱单后，合同/装运通知里 **6 处引用**要逐一清理 | 引用表只记不校验 | **引用完整性**：停用/删除即扫引用并阻断导出 |
| 11 | 定金合同 847.95、实收 847.93（差 0.02） | 无实收登记与容差口径 | **实收 + 差额归因 + 容差核销** |
| 12 | 公章"顶不住"签章行上边线：PNG 顶部有 14 行 (205,205,205,46) 白底残渣 | 上传端未做紧裁/残渣清理 | 公章**上传端规范化** + 锚点元数据 |
| 13 | 合同 5 页利用率 26%，半空页 | 无分页预算 | **分页预算器 + 原子区块** |
| 14 | 英文出现 `the buyer buyer to claim`；中英两栏只改一边 | 双语各存一份、无对偶校验 | **双语成对 fact + 导出前对偶 lint** |

---

## 4. 设计方案

### A. 事实层（Fact Model）—— 一切加固的地基

把"单证 payload 里的一坨字段"升级为**可追溯、有信任级、有不可改写属性的事实**。

```
TradeDocFact
  id, tenant_id, doc_id, doc_type, doc_no
  fact_key         # 规范化键：total_amount / unit_price[1] / incoterm / payment_deposit_ratio ...
  value            # 规范化值（金额→int minor unit；术语→枚举；日期→ISO）
  text_zh, text_en  # 双语成对（一句一事实，中英同一条记录）
  source           # pi | upstream_doc | manual | ai_suggested | inferred
  trust            # confirmed | unverified | inferred      ← 新增
  immutable        # 该事实在本交易内是否允许派生单覆盖
  confirmed_by / confirmed_at
  evidence_ref     # 来源单证号 / 附件 id / 对话消息 id
```

三条硬规则（工位里的业务规则，进 `kaas_common`）：

1. **trust 闸门**：`issued` 的单证里不允许存在 `trust != confirmed` 的事实；
   未确认事实在导出时按 `TBC` 渲染清单输出（渲染成 `To be advised`/`待确认`，**不留空、不猜**）。
2. **不可改写**：`immutable=True` 的事实，派生单只能**原值引用**，覆盖请求一律拒绝并给出
   `FACT_IMMUTABLE`（今天"PI 条款不得更改"的机器化）。
3. **单源推导**：`unit_price` / `amount` / `total` 只能由 `qty × price ÷ fx_snapshot` 推导，
   不提供手抄入口（消灭第 3 条那类抄数错误）。

### B. 一致性引擎（Consistency Kernel）

新增 `backend/kaas_common/trade_doc/consistency.py`（纯 stdlib，与 `rules.py` 同级）：

```
diff_facts(docs: list[TradeDocPayload]) -> list[FactDiff]
  # 同一交易（同 order/customer/contract 链）内，同名 fact 不同值 → 一条 diff
  # 语义等价表：措辞不同但等价（"before dispatch" ≡ "upon dispatch (before delivery)"）→ 不算 diff
  # 容差：金额容忍 ±0.05 或 0.1%（可配置），汇率必须完全一致
lint_pair(source_doc, derived_doc) -> ItemCheck   # 承继核对（今天 check_ct_vs_pi.py 的 43 条 = 其子集）
```

配套：`definition_of_equivalent` 等价词表（如 `upon order confirmation` ≡ `upon confirmation of the order`），
由人工维护、单独成文件，**不允许把差异静默吞掉**——只在词表内才判等价。

**产品形态**：单证详情页一个「一致性」页签，列出
`✓ 一致 54 项 / ⚠ 等价措辞 2 项 / ✗ 冲突 1 项`，冲突项可一键"以基线为准"回填。

### C. 单证清单与责任方（Doc Set & Issuer）

把"这一次交易该出哪些单证"做成显式清单，而不是靠人记：

```
TradeDocSetItem
  doc_type        # 复用 enums.DOC_TYPE
  role            # required | optional | not_by_us
  issuer          # ours | buyer | third_party:ccpit | carrier | insurer
  trigger         # 触发条件表达式，如 wood_packing == true → pack_declaration
  evidence_required  # 是否必须回执/他方签章
  status          # pending | received | waived(reason)
```

价值：今天的 **装箱单（not_by_us：由装箱方出）/ 木包装声明（trigger: 有木质包装）** 都能被系统表达，
不会再出现"我方越权出单"或"无木包装却出 ISPM-15 声明"。
清单外的单证**不允许被引用**（见 D）。

### D. 引用完整性（Referential Integrity）

- `trade_doc_doc_refs` 增加方向与类型：`annex_of / derives_from / references_in_text`。
- **停用/作废/删除**一份单证 → 立即扫引用方，返回 `DOC_REF_BROKEN` 清单（今天 6 处引用的自动化）。
- 校验规则：被引用单证必须是 `issued` 且 `valid`；引用单证里出现的单号文本必须能在 refs 中命中
  （防"正文写了单号但没登记引用"）。
- 导出前必跑：任一处 `DOC_REF_BROKEN` → **阻断导出**（可选 warning 模式）。

### E. 金额与收款（Money & Receipt）

在既有 `SCHEDULE_TYPE/STATUS` 之上补：

```
PaymentSchedule: type, ratio, amount, due_trigger(enum), due_date, status
Receipt:         schedule_id, received_amount, received_at, bank_ref,
                 diff, diff_reason(bank_charge | fx_rounding | short_paid | other), fx_rate_used
```

规则：
- **容差**：`|diff| ≤ max(0.05, 0.1%)` → 自动核销并记 `fx_rounding`；否则挂 `short_paid` 告警（今天 0.02）。
- **付款条件结构化**：`(30%, upon_order_confirmation)` / `(70%, upon_dispatch_before_delivery)` 进 fact 层，
  三份单证共用同一 fact → 不再各写各的（第 2 条）。
- **收款状态回写**：deposit 变 `paid` 时，允许在 CI/合同上生成"已收"表述（今天客户要求"写上 30% 定金买方已支付"），
  但**只在 fact 层改状态**，各单证按模板渲染。
- **fx_snapshot 冻结**：`{rate, source, quoted_at}` 随单证冻结，全部派生单复用（今天 6.7029 / 2026-09-28）。

### F. 排版 · 导出 · 附件（Export Hardening）

| 子项 | 设计 |
|---|---|
| 分页预算器 | 共享 `layout_budget.py`：页面可用高度（横向 A4 ≈ 600pt @ fitToWidth）− 区块累计高度；超预算把**整块**下移（今天 `finish()` 的抽象） |
| 原子区块 | 签章区/公章/货表标记 `keep_together`，禁止跨页撕裂 |
| 导出后自检 | 必跑三件套：① 单元格文本集合 ⊆ PDF 文本（查遮挡截断）② 图片计数按页断言（公章=1、不劈页）③ 数值勾稽重算。失败即阻断或强提示 |
| 公章上传规范化 | Canvas 端：**去白底（含浅灰残渣，阈值 min(R,G,B)>200）+ 紧裁 + 缩到目标宽**；记录 `anchor=签署行上边线`、`size_pt`、`dpi`；前端预览叠印效果 |
| 双语对偶 | fact 层 `text_zh/text_en` 成对；导出前 lint：两侧 fact 键集合相等、金额/日期/单号两侧都在、英文重复词体检（`\b(\w+)\s+\1\b`） |
| 术语规范器 | `incoterm` 必须 `术语 + 指定地点 + (Incoterms 20xx)`；`country_of_origin` 用 ISO/惯例写法；金额附大写；日期统一 `Month D, YYYY`（英文单证） |
| 签章位元数据 | 模板声明 `signature_slots`：`seller_stamp` / `buyer_sign`(是否需要) / `none`（今天"CI 要不要客户签字"这类问题由模板回答，而不是每次问人） |

---

## 5. 数据模型草案（新增/变更）

| 对象 | 变更 | 备注 |
|---|---|---|
| `trade_doc_facts`（新表） | fact_key/value/trust/source/immutable/text_zh/text_en/confirmed_* | 核心新表；payload 快照仍保留，facts 做校验与比对 |
| `trade_doc_doc_set`（新表） | doc_set_id / doc_type / role / issuer / trigger / status | 交易维度清单 |
| `trade_doc_doc_refs`（改） | + `ref_kind`、`broken_at`、`replaced_by_doc_id` | 引用完整性 |
| `trade_doc_receipts`（新表） | schedule_id / received_amount / diff / diff_reason / fx_rate_used | 实收与差额 |
| `trade_doc_lint_runs`（新表，可选） | doc_id / rule_code / severity / detail / ran_at | 校验留痕（对银行/审计有说服力） |

迁移：沿用 `scripts/sync_schema_additive.py`（只增不删）+ `stamp_alembic.py`，不碰历史迁移链
（参见 `TRADE_DOC_WORKSTATION_STATUS.md` §3 踩坑）。

---

## 6. 接口草案

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/v1/trade-docs/{id}/lint` | 单证级 lint（必填 + 术语 + 双语 + 排版预算），返回 `{ok, items[]}` |
| GET | `/api/v1/trade-docs/{id}/consistency` | 跨单证事实 diff（含等价措辞、冲突项） |
| POST | `/api/v1/trade-docs/{id}/confirm` | **扩展**：确认前必跑 lint + consistency，新增 `FACT_UNVERIFIED` / `FACT_IMMUTABLE` / `DOC_REF_BROKEN` 错误码 |
| POST | `/api/v1/trade-doc-sets` | 建/改交易单证清单（role/issuer/trigger） |
| POST | `/api/v1/trade-docs/{id}/receipts` | 登记实收（含差额归因） |
| POST | `/api/v1/trade-docs/{id}/verify-export` | 导出后自检（前端把 xlsx/pdf 摘要回传，后端比对留痕） |

错误码家族（建议与现有 `SOURCE_NOT_CONFIRMED` / `CONFIRM_INVALID` 同级）：
`FACT_UNVERIFIED`、`FACT_IMMUTABLE`、`FACT_CONFLICT`、`DOC_REF_BROKEN`、`DOC_SET_NOT_ALLOWED`、`LAYOUT_OVERFLOW`。

---

## 7. 优先级与分期

| 期 | 内容 | 价值 | 估重 |
|---|---|---|---|
| **P0** | D 引用完整性 + F 导出后自检（文本⊆PDF、图片计数） | 直接消灭"删单留悬空引用""公章劈页/文字遮挡" | S |
| **P0** | F 公章上传规范化（去残渣+紧裁）+ 锚点元数据 | 消灭"章贴不住/压字" | S |
| **P1** | A 事实层（source/trust/immutable）+ B 一致性引擎（含等价词表） | 消灭口径漂移、推断写单、"PI 不得改" | M |
| **P1** | E 收款容差与差额归因；付款条件结构化 | 消灭零头纠纷、付款时点各写各的 | M |
| **P2** | C 单证清单与责任方（含 trigger） | 消灭"越权出单/无谓出单" | M |
| **P2** | F 分页预算器 + 原子区块 + 双语对偶 lint + 术语规范器 | 排版与专业性 | L |
| **P2** | `trade_doc_lint_runs` 留痕 | 对银行/审计的可解释性 | S |

（估重：S ≈ 半天~1 天；M ≈ 2~3 天；L ≈ 1 周，含前端面板。）

---

## 8. 验收标准（可执行断言）

1. **一致性**：构造一份 CI，把 Incoterms 版本删掉 → `consistency` 报 `FACT_CONFLICT(incoterm)`；
   把 SC 的 `upon dispatch` 改成 `before dispatch`（不在等价词表内）→ 报冲突。
2. **可信级**：`trust=inferred` 的 fact 存在时，`confirm` 返回 `FACT_UNVERIFIED`；
   把该 fact 标为 confirmed 后可 confirm。
3. **不可改写**：基线 PI 的 `payment_ratio_deposit=0.30` 在派生 SC 上被改成 0.5 → `FACT_IMMUTABLE`。
4. **单证清单**：清单里 `pl.role=not_by_us` 时，建 PL 返回 `DOC_SET_NOT_ALLOWED`；
   `wood_packing=false` 时 PD 的 trigger 不满足 → 出单前提示"本单无需该声明"。
5. **引用完整性**：停用 PL → 返回合同/装运通知里 6 条引用（今天真实数量）→ 未处理则导出阻断。
6. **收款**：登记实收 847.93 对合同 847.95 → 自动判 `fx_rounding`（在容差内）并核销；差额 12.00 → `short_paid` 告警。
7. **导出自检**：故意把某行行高压到截断 → `verify-export` 报"单元格文本未出现在 PDF 中"；
   故意让公章跨页 → 报"图片计数 ≠ 1"。
8. **双语对偶**：只改中文栏 → lint 报 `ZH_ONLY_CHANGE`；英文出现 `buyer buyer` → 报重复词。

---

## 9. 与既有文档的关系 / 不做什么

**关系**：本方案是 `TRADE_DOC_WORKSTATION_STATUS.md` §4「未完成」第 3、5 项（模板风格、排版回归）的
**加固版补充**，并把 `compliance.ts`（字段级）升级为**事实级 + 跨单证级**。
`MULTI_PRODUCT_QUOTE_PLAN.md` 的派生链口径不变；本方案只在其上加"基线优先 / 不可改写 / 引用完整性"。

**不做（本期）**：
- 不做 OCR/自动识别客户回传单证（只登记，不做图像理解）；
- 不做海关/CCPIT/保险的在线对接口（第三方签发单证只登记编号与状态）；
- 不做多语言（仅中英）；
- 不在工位内做计价（维持现状：计价在报价工位）。

---

## 10. 待确认（并入 UNCERTAIN.md 的候选）

1. 一致性引擎的**交易边界**怎么定？建议：以 `order`（或 `contract`）为根，同一 order 下的所有单证为一个 fact 域。
2. 等价词表由谁维护、是否允许租户自定义（建议：全局默认表 + 租户增量表，仅 internal 可改）。
3. 收款容差阈值（建议 0.05 USD 或 0.1%，取大者）是否按币种区分。
4. `not_by_us` 单证是否需要"由对方提供后回执登记"流程（影响清单状态机）。
5. 导出后自检失败时：**阻断**还是**强提示可越过**（建议默认阻断，tenant 可配）。

---

## 11. 原型脚本归档（源码随附）

本次实操的 16 个脚本原本只在本机 `D:\projects\报价制作\.tools\`，而该目录被 `.gitignore` 排除、不在任何版本库中，
**换设备即丢**。现已随本方案一并归档：

👉 [`docs/archive/2026-10-12-tim-doc-prototypes/`](./archive/2026-10-12-tim-doc-prototypes/)
（含逐脚本说明、关键算法要点、运行依赖、敏感信息提示）

| 脚本 | 吸收到哪个模块 |
|---|---|
| `make_tim_post_pi_docs.py` | **F** 分页预算器 / 原子区块 / 签章位 / 行高估算 |
| `verify_tim_post_pi.py` | **F** 导出后自检（文本 ⊆ PDF、图片计数） |
| `check_pi_sc_ci.py` | **B** 一致性引擎（四列事实矩阵原型） |
| `check_ct_vs_pi.py` | **A/B** 基线承继核对（43 条） |
| `tighten_stamp.py` / `prep_stamp.py` | **F** 公章上传规范化（去白底残渣 + 紧裁） |
| `xlsx2pdf.ps1` | **F** 导出通道（Excel COM `ExportAsFixedFormat`） |
| `diag_ct_pages.py` / `measure_pdf_pages.py` / `check_ct_overflow.py` / `check_tim_rows.py` | **F** 分页/溢出诊断工具 |
| `render_tim_docs.py` / `list_tim_signareas.py` | **F** 目检流程 / 签章位核对 |
| `dump_tim_sources.py` / `archive_tim_sources.py` | 数据溯源 |

> ⚠️ 脚本内硬编码了真实业务常量（卖方抬头/税号/收款账号/SWIFT、客户邮箱、真实价格）——
> 仓库若转公开需先脱敏；**公章图片刻意未归档**（印章图像属高风险资料）。

**实现对照**：工位落地时以 §4 的模块设计为准，脚本只作**算法与坑位参考**，
不直接搬运（工位是前端 exceljs + 浏览器打印、后端零图像库，与脚本的 openpyxl + Excel COM 路线不同）。
