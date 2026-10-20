"""事实层（Fact Model）—— 单证 payload 的字段 → **可追溯、有信任级、有不可改写属性**的事实。

为什么需要这一层
----------------
2026-10-12 Tim 单复盘（`docs/archive/2026-10-20-closeout/TRADE_DOC_HARDENING_PLAN_2026-10-12.md`
§3）里真实翻车的 14 条，**没有一条是排版问题**，全是「事实层没有约束」：

    #2 付款时点被"改述"        → 付款条件必须是**结构化事实**（比例 + 时点），不能各写各的散文
    #4 "PI 里的业务条款你不能改" → 基线事实必须**不可改写**（immutable）
    #5 从邮箱域名推出买方公司名  → 推断值必须带**信任级**，未确认不得进 issued，导出渲染 TBC
    #3 绝缘子单价 0.3253（实际 2.18/6.7029）→ 金额只能**由数量×单价推导**，不提供手抄入口

本模块只做**纯函数 + 纯数据**：不连库、不读环境变量、不 import 三方库（Pyodide 可跑），
与 `rules.py` / `payload.py` 同级。数据库表、API、前端是下一阶段的事（本层先把口径钉死）。

三条硬规则（§4-A，全部返回结构化结果，不抛裸异常）
------------------------------------------------
1. `gate_trust(facts, "issued")` —— issued 的单证里不允许存在 `trust != confirmed` 的事实
   ⇒ `FACT_UNVERIFIED`（带 key 清单）。未确认事实导出时按 `render_tbc` 渲染
   `To be advised`/`待确认`，**不留空、不猜值**。
2. `check_immutable(基线, 派生)` —— `immutable=True` 的事实，派生单只能**原值引用**；
   改值 ⇒ `FACT_IMMUTABLE`（给出原值/新值）。今天"PI 条款不得更改"的机器化。
3. `derive_amount` / `assert_no_manual_amount` / `check_derived_amount` ——
   金额只能由 `数量 × 单价（÷ 汇率）` 推导；手填入口一律拒绝
   （`FACT_MANUAL_AMOUNT`），已落库的手填值核对不上 ⇒ `FACT_CONFLICT`。

payload 形状以实际落库的数据为准（`backend/worker/src/doc_payload.py`）
---------------------------------------------------------------------
    raw_payload = {
        "sources": {"order"|"quote"|"inquiry": 快照, "pi": 上游单证的整份 raw_payload},
        "custom":  {手工/派生字段},
        "derived": {溯源}, "_audit": [...],
    }

`extract_facts` 接受 `raw_payload`，也接受「`raw_payload` + 整行字段」
（`doc_no` / `currency` / `total_amount` / `issued_at` …）：Worker 侧直接传
`(_payload_of(row), row)` 摊平后的 dict 即可，内核不碰 ORM。

**不新造平行数据模型**：字段名一律复用 `payload_shared.TRADE_TERM_FIELDS` /
`DOC_NO_FIELDS`，合成优先级复用 `payload.compose_fields`（手工 > 派生 > 上游），
`custom` 的受保护字段边界复用 `payload_shared.PROTECTED_CUSTOM_FIELDS`
（手工内容不得覆盖行项/总金额，否则金额可被手填改写 —— 与渲染侧同一道闸门）。

取值的来源/信任级推定（`source` / `trust`）
------------------------------------------
| 值来自 | source | trust | 理由 |
|---|---|---|---|
| `custom.<字段>` 手工填 | `manual` | `confirmed` | 人填的即人认的 |
| 上游快照（`sources.*`） | `pi` / `upstream_doc` | `confirmed`；快照 `status` 是 draft/pending 等则 `unverified` | 派生闸门 `rules.assert_derivable` 只允许 issued 源被派生，快照本身是已确认基线 |
| 由付款条款**文本解析**出的比例/时点 | 继承文本字段的来源 | `unverified` | 解析是推断：签发前必须有人核对（§3 #5/#6 的教训） |
| 单据自身行字段 | `manual` | `confirmed` | 单号/日期是系统落库的自身标识 |

`confirmed_by` / `confirmed_at` 缺省为空表示"由来源单证担保"；人工确认请用
`confirm_fact(fact, by=..., at=...)` 生成新事实（本层不写库、不改历史）。

边界（明确不做）
--------------
- 不做 OCR / 图像理解（§9「不做」）；
- 不做单证清单与责任方（§4-C 是下一阶段，`not_by_us` 之类不在这里）；
- 不把 `custom` 里的受保护字段（`items`/`total_amount`）当事实来源 ——
  它们只能来自上游快照或系统推导（与 `build_render_data` 同一条边界）。
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, replace
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Iterable, Mapping, Optional, Sequence

from ..workstation.receipt_rules import receipt_tolerance
from . import equivalents
from .payload import compose_fields
from .payload_shared import DOC_NO_FIELDS, PROTECTED_CUSTOM_FIELDS, TRADE_TERM_FIELDS
from .rules import AMOUNT_DECIMALS, ITEMS_INVALID, RuleError, to_decimal

__all__ = [
    # 枚举与错误码
    "SOURCE_KINDS", "TRUST_LEVELS",
    "SOURCE_PI", "SOURCE_UPSTREAM", "SOURCE_MANUAL", "SOURCE_AI", "SOURCE_INFERRED",
    "TRUST_CONFIRMED", "TRUST_UNVERIFIED", "TRUST_INFERRED",
    "FACT_CONFLICT", "FACT_UNVERIFIED", "FACT_IMMUTABLE",
    "FACT_MANUAL_AMOUNT", "FACT_MISSING", "FACT_EQUIVALENT_WORDING",
    # 数据类
    "Fact", "RuleViolation", "PaymentTermPart",
    # 键 / 值 / 比较
    "IMMUTABLE_KEYS", "FACT_LABELS",
    "normalize_fact_key", "normalize_fact_value", "fact_kind", "fact_label",
    "decimal_text", "values_equal", "amount_tolerance",
    # 抽取与确认
    "extract_facts", "parse_payment_terms", "confirm_fact",
    # 三条硬规则 + TBC 渲染
    "gate_trust", "check_immutable",
    "derive_amount", "derive_unit_price", "assert_no_manual_amount", "check_derived_amount",
    "render_tbc", "TBC", "TBC_ZH", "TBC_EN",
]

# ─── 枚举与错误码 ──────────────────────────────────────────────────────────

SOURCE_PI = "pi"                  # PI 基线（客户签回的那份）
SOURCE_UPSTREAM = "upstream_doc"  # 其它上游单证（订单/报价/合同/询盘快照）
SOURCE_MANUAL = "manual"          # 人工填写
SOURCE_AI = "ai_suggested"        # AI 建议（未确认）
SOURCE_INFERRED = "inferred"      # 系统推断（域名→公司名这类）
SOURCE_KINDS: tuple[str, ...] = (
    SOURCE_PI, SOURCE_UPSTREAM, SOURCE_MANUAL, SOURCE_AI, SOURCE_INFERRED,
)

TRUST_CONFIRMED = "confirmed"     # 可按原值进 issued
TRUST_UNVERIFIED = "unverified"   # 未核对：签发前必须确认
TRUST_INFERRED = "inferred"       # 推断出来的：默认不得进 issued
TRUST_LEVELS: tuple[str, ...] = (TRUST_CONFIRMED, TRUST_UNVERIFIED, TRUST_INFERRED)

# 错误码（与 API 层 detail.code 对应，风格同 rules.py 的 SOURCE_NOT_CONFIRMED）
FACT_CONFLICT = "FACT_CONFLICT"                  # 跨单证/推导对不上
FACT_UNVERIFIED = "FACT_UNVERIFIED"              # issued 时存在未确认事实
FACT_IMMUTABLE = "FACT_IMMUTABLE"                # 不可改写事实被派生单改值
FACT_MANUAL_AMOUNT = "FACT_MANUAL_AMOUNT"        # 手填金额（不接受）
FACT_MISSING = "FACT_MISSING"                    # 派生单没承继基线事实
FACT_EQUIVALENT_WORDING = "FACT_EQUIVALENT_WORDING"  # 措辞不同但词表内等价（非冲突）

# 未确认事实的渲染占位（§4-A 规则 1：不留空、不猜值）
TBC = "TBC"
TBC_ZH = "待确认"
TBC_EN = "To be advised"


# ─── 不可改写事实集（§4-A 规则 2）─────────────────────────────────────────
#
# 口径："PI 里的业务条款不得更改"（真实翻车 #4）+ "fx_snapshot 冻结、全部派生单复用"（§4-E）。
# 只圈**条款类**事实：金额不在这里 —— 金额由"单源推导"（规则 3）保证，
# 而不是靠不可改写（部分出运时 CI 金额与 PI 天然不同，把金额设成不可改写会误报）。
IMMUTABLE_KEYS: tuple[str, ...] = (
    "incoterm",
    "payment_terms",
    "payment_deposit_ratio",
    "payment_deposit_timing",
    "payment_balance_ratio",
    "payment_balance_timing",
    "payment_full_ratio",
    "payment_full_timing",
    "currency",
    "fx_rate",
    "port_of_loading",
    "port_of_destination",
    "country_of_origin",
    "shipping_marks",
)

# 事实的中英标签（TBC 清单与界面用；`unit_price[1]` 这类带行号的键按基名取）
FACT_LABELS: dict[str, tuple[str, str]] = {
    "incoterm": ("贸易术语", "Incoterm"),
    "payment_terms": ("付款条件", "Payment Terms"),
    "payment_deposit_ratio": ("定金比例", "Deposit Ratio"),
    "payment_deposit_timing": ("定金时点", "Deposit Timing"),
    "payment_balance_ratio": ("尾款比例", "Balance Ratio"),
    "payment_balance_timing": ("尾款时点", "Balance Timing"),
    "payment_full_ratio": ("全额付款比例", "Full Payment Ratio"),
    "payment_full_timing": ("全额付款时点", "Full Payment Timing"),
    "currency": ("币种", "Currency"),
    "total_amount": ("总金额", "Total Amount"),
    "total_payable": ("应付总额", "Total Amount Payable"),
    "fx_rate": ("汇率", "Exchange Rate"),
    # A14：本单包装（来自产品 packaging[].method / 本单 packaging_id，不新增业务字段）
    "packing_method": ("包装方式", "Packing Method"),
    "packing_type": ("包装类型", "Packing Type"),
    "port_of_loading": ("装运港", "Port of Loading"),
    "port_of_destination": ("目的港", "Port of Destination"),
    "country_of_origin": ("原产国", "Country of Origin"),
    "shipping_marks": ("唛头", "Shipping Marks"),
    "doc_no": ("单号", "Document No."),
    "date": ("单据日期", "Document Date"),
    "buyer_name": ("买方", "Buyer"),
    "order_no": ("订单号", "Order No."),
    "quote_no": ("报价单号", "Quotation No."),
    "contract_no": ("合同号", "Contract No."),
    "pi_no": ("形式发票号", "Proforma Invoice No."),
    "qty": ("数量", "Quantity"),
    "unit_price": ("单价", "Unit Price"),
    "line_amount": ("行金额", "Line Amount"),
}


# ─── 纯数据类 ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Fact:
    """一条事实（§4-A 的 `TradeDocFact` 去掉 `id/tenant_id/doc_id/doc_no` 等 DB 字段）。

    为什么 DB 字段不在内核里：事实的**归属**（属于哪张单证）由调用方用
    `{doc_id: [Fact, ...]}` 的容器表达（见 `consistency.diff_facts`），
    内核不需要也不应该知道租户/主键 —— 那是持久化层的事，写进来就绑死了 DB。

    `value` 恒为**规范化文本**（构造时自动归一）：
    - 金额/比例/汇率/数量 → 十进制字符串（`Decimal("0.30")` → `"0.3"`）
    - 日期 → ISO（`2026-10-12`）
    - 术语/自由文本 → 保留原措辞（仅做排版归一，比较时再走 `equivalents`）

    `text_zh` / `text_en` 是**双语成对**的同一句事实（§8-8 双语对偶的基础）。
    提取阶段通常只填一侧（原文是哪种语言就填哪侧），另一侧留空表示"暂无译文"，
    **不允许为了凑齐而机翻**。
    """

    key: str
    value: str
    text_zh: str = ""
    text_en: str = ""
    source: str = SOURCE_MANUAL
    trust: str = TRUST_UNVERIFIED
    immutable: bool = False
    confirmed_by: Optional[Any] = None
    confirmed_at: Optional[str] = None
    evidence_ref: str = ""
    # 金额类事实的币种快照（扩展字段）：容差判定要按币种取「5 美分等值」，
    # 而 `currency` 本身是另一条独立事实，不该逼调用方去反查。
    currency: str = ""

    def __post_init__(self) -> None:
        key = str(self.key or "").strip()
        if not key:
            raise ValueError("Fact.key 不能为空")
        if self.source not in SOURCE_KINDS:
            raise ValueError(f"Fact.source 非法: {self.source!r}（可选 {SOURCE_KINDS}）")
        if self.trust not in TRUST_LEVELS:
            raise ValueError(f"Fact.trust 非法: {self.trust!r}（可选 {TRUST_LEVELS}）")
        object.__setattr__(self, "key", key)
        object.__setattr__(self, "value", normalize_fact_value(key, self.value))
        object.__setattr__(self, "text_zh", str(self.text_zh or "").strip())
        object.__setattr__(self, "text_en", str(self.text_en or "").strip())
        object.__setattr__(self, "currency", str(self.currency or "").strip().upper())

    @property
    def confirmed(self) -> bool:
        """是否已确认（只有 confirmed 才允许进 issued）。"""
        return self.trust == TRUST_CONFIRMED

    @property
    def bilingual(self) -> tuple[str, str]:
        """(中文, 英文)：命中的一侧或空串 —— 供双语对偶 lint 使用。"""
        return (self.text_zh, self.text_en)


@dataclass(frozen=True)
class RuleViolation:
    """一条规则违例（**结构化返回**，不抛裸异常；code 供 API 层落 detail.code）。

    `original` / `provided` 是规范化后的**值文本**（不是原对象），
    便于直接进 JSON / 审计；需要原始对象时看 `Fact.value`。
    """

    code: str
    detail: str
    keys: tuple[str, ...] = ()
    original: Optional[str] = None
    provided: Optional[str] = None
    evidence_ref: str = ""

    def as_dict(self) -> dict:
        """给 API/前端用的纯 dict（字段名与 code 对齐）。"""
        return {
            "code": self.code,
            "detail": self.detail,
            "keys": list(self.keys),
            "original": self.original,
            "provided": self.provided,
            "evidence_ref": self.evidence_ref,
        }


# ─── 键归一 ────────────────────────────────────────────────────────────────

# 同义写法 → 规范键。规范键优先采用**实际落库字段名**（`payload_shared` 的
# `TRADE_TERM_FIELDS` / `DOC_NO_FIELDS`），避免内核造出第二套字段名。
_KEY_ALIASES: dict[str, str] = {
    # 贸易条款（TRADE_TERM_FIELDS 同一批概念）
    "incoterm": "incoterm",
    "incoterms": "incoterm",
    "inco_term": "incoterm",
    "trade_term": "incoterm",
    "trade_terms": "incoterm",
    "price_term": "incoterm",
    "delivery_term": "incoterm",
    "delivery_terms": "incoterm",
    "贸易术语": "incoterm",
    "价格术语": "incoterm",
    "交货条款": "incoterm",
    "terminal": "incoterm",
    # 付款条件
    "payment_terms": "payment_terms",
    "payment_term": "payment_terms",
    "terms_of_payment": "payment_terms",
    "payment": "payment_terms",
    "付款条件": "payment_terms",
    "付款方式": "payment_terms",
    # 付款结构化（§8-3 的 payment_ratio_deposit 写法也认）
    "payment_deposit_ratio": "payment_deposit_ratio",
    "payment_ratio_deposit": "payment_deposit_ratio",
    "deposit_ratio": "payment_deposit_ratio",
    "deposit_percent": "payment_deposit_ratio",
    "定金比例": "payment_deposit_ratio",
    "payment_balance_ratio": "payment_balance_ratio",
    "payment_ratio_balance": "payment_balance_ratio",
    "balance_ratio": "payment_balance_ratio",
    "尾款比例": "payment_balance_ratio",
    "payment_full_ratio": "payment_full_ratio",
    "full_ratio": "payment_full_ratio",
    "payment_deposit_timing": "payment_deposit_timing",
    "deposit_timing": "payment_deposit_timing",
    "定金时点": "payment_deposit_timing",
    "payment_balance_timing": "payment_balance_timing",
    "balance_timing": "payment_balance_timing",
    "尾款时点": "payment_balance_timing",
    "payment_full_timing": "payment_full_timing",
    # 币种 / 金额 / 汇率
    "currency": "currency",
    "curr": "currency",
    "币种": "currency",
    "货币": "currency",
    "total_amount": "total_amount",
    "total": "total_amount",
    "grand_total": "total_amount",
    "total_value": "total_amount",
    "total_price": "total_amount",
    "contract_amount": "total_amount",
    "总金额": "total_amount",
    "合计": "total_amount",
    # 应付总额（A6-1）：真实单据里 "TOTAL AMOUNT PAYABLE" 与 "Total Goods Value" 分列，
    # 它是**含运费**的实际应付额，与 total_amount（历史口径的单一起总）不是同一事实。
    "total_payable": "total_payable",
    "total_amount_payable": "total_payable",
    "amount_payable": "total_payable",
    "payable_total": "total_payable",
    "应付总额": "total_payable",
    "应付总金额": "total_payable",
    "fx_rate": "fx_rate",
    "exchange_rate": "fx_rate",
    "ex_rate": "fx_rate",
    "汇率": "fx_rate",
    "汇价": "fx_rate",
    # 港口 / 原产地 / 唛头
    "port_of_loading": "port_of_loading",
    "port_of_shipment": "port_of_loading",
    "loading_port": "port_of_loading",
    "pol": "port_of_loading",
    "装运港": "port_of_loading",
    "起运港": "port_of_loading",
    "port_of_destination": "port_of_destination",
    "port_of_unloading": "port_of_destination",
    "port_of_discharge": "port_of_destination",
    "unloading_port": "port_of_destination",
    "destination_port": "port_of_destination",
    "pod": "port_of_destination",
    "目的港": "port_of_destination",
    "卸货港": "port_of_destination",
    "country_of_origin": "country_of_origin",
    "origin_country": "country_of_origin",
    "origin": "country_of_origin",
    "原产国": "country_of_origin",
    "产地": "country_of_origin",
    "shipping_marks": "shipping_marks",
    "shipping_mark": "shipping_marks",
    "marks": "shipping_marks",
    "唛头": "shipping_marks",
    # 单据自身标识
    "doc_no": "doc_no",
    "document_no": "doc_no",
    "doc_number": "doc_no",
    "document_number": "doc_no",
    "单号": "doc_no",
    "单据号": "doc_no",
    "date": "date",
    "doc_date": "date",
    "document_date": "date",
    "日期": "date",
    "单据日期": "date",
    # 行项目
    "qty": "qty",
    "quantity": "qty",
    "数量": "qty",
    "unit_price": "unit_price",
    "price": "unit_price",
    "unit_rate": "unit_price",
    "单价": "unit_price",
    "line_amount": "line_amount",
    "line_total": "line_amount",
    "行金额": "line_amount",
    "行小计": "line_amount",
    # 主体
    "buyer": "buyer_name",
    "buyer_name": "buyer_name",
    "customer_name": "buyer_name",
    "买方": "buyer_name",
}

_INDEXED_FIELD_RE = re.compile(
    r"^(?:items?|lines?|rows?|goods|rows?)\s*\[\s*(\d+)\s*\]\s*[._]\s*(.+)$", re.IGNORECASE
)
_TRAILING_INDEX_RE = re.compile(r"^(.*?)\s*\[\s*(\d+)\s*\]$")
_TRAILING_SEP_INDEX_RE = re.compile(r"^(.*?)[._#]\s*(\d+)$")
_SLUG_CLEAN_RE = re.compile(r"[^0-9a-z_\u4e00-\u9fff\[\]]+")


def _slug(text: str) -> str:
    """键的正常形式：小写、空格/连字符→下划线、去掉其它符号，保留中文与行号方括号。"""
    value = unicodedata.normalize("NFKC", str(text or "")).strip().lower()
    value = re.sub(r"[\s\-./]+", "_", value)
    value = _SLUG_CLEAN_RE.sub("", value)
    value = re.sub(r"_+", "_", value).strip("_")
    return value


def _split_index(text: str) -> tuple[Optional[int], str]:
    """把 `unit_price[1]` / `items[0].unit_price` / `qty_2` 拆成（行号, 字段名）。"""
    match = _INDEXED_FIELD_RE.match(text)
    if match is not None:
        return int(match.group(1)), match.group(2)
    match = _TRAILING_INDEX_RE.match(text)
    if match is not None:
        return int(match.group(2)), match.group(1)
    match = _TRAILING_SEP_INDEX_RE.match(text)
    if match is not None:
        return int(match.group(2)), match.group(1)
    return None, text


def normalize_fact_key(raw: Any) -> str:
    """把 payload 字段名 / 自由文本键归一成规范事实键。

    覆盖（§4-A 要求的至少这些）：`incoterm`、`payment_*`（比例/时点）、
    `total_amount`、`unit_price[i]`、`qty[i]`、`currency`、
    `port_of_loading` / `port_of_unloading`（→ `port_of_destination`，落库字段名）、
    `country_of_origin`、`doc_no`、`date`。

    **未知键不丢信息**：原样小写 + 下划线化后返回（`freight_note` → `freight_note`）。
    行号保留：`items[0].unit_price`、`unit_price_1`、`unit_price[1]` → `unit_price[1]`。
    """
    text = unicodedata.normalize("NFKC", str(raw or "")).strip()
    if not text:
        return ""
    index, base = _split_index(text)
    canonical = _KEY_ALIASES.get(_slug(base), _slug(base))
    if not canonical:
        return ""
    return f"{canonical}[{index}]" if index is not None else canonical


# ─── 值归一 / 事实分类 ────────────────────────────────────────────────────

# 金额类事实的基名：**容差只适用于这些**
_MONEY_BASES = frozenset({
    "total_amount", "line_amount", "amount", "subtotal",
    "deposit_amount", "balance_amount", "payment_deposit_amount",
    "payment_balance_amount", "freight_amount", "insurance_amount",
    # A6-1：含运费的实际应付额（与 total_amount 分开，容差规则一致）
    "total_payable",
})

_CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def _base_of(key: Any) -> str:
    return str(key or "").split("[")[0]


def fact_kind(key: Any) -> str:
    """事实的取值类型：`money` / `fx_rate` / `qty` / `ratio` / `date` / `text`。

    类型决定两件事：值怎么归一（金额→十进制串、日期→ISO）、
    比较时会不会走容差（**只有 money 走容差**）。
    """
    base = _base_of(key)
    if base in _MONEY_BASES:
        return "money"
    if base == "fx_rate":
        return "fx_rate"
    if base == "qty":
        return "qty"
    if base.endswith("_ratio"):
        return "ratio"
    if base == "date" or base.endswith("_date"):
        return "date"
    return "text"


def decimal_text(value: Any) -> str:
    """金额/比例/汇率的规范文本：`Decimal("0.30")` → `"0.3"`，`1000` → `"1000"`。

    为什么不用最小单位整数：单证里单价可以到 4 位小数（`0.3252`），
    换算成"分"会丢精度；十进制字符串两端都无损，且 `Decimal` 能直接吃。
    """
    if value is None or value == "":
        return ""
    try:
        number = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, ValueError):
        return equivalents.normalize_text(value)
    if number == number.to_integral_value():
        return format(number.quantize(Decimal(1)), "f")
    return format(number.normalize(), "f")


def normalize_fact_value(key: str, value: Any) -> str:
    """按事实类型归一取值（排版归一，不改语义；**不猜、不补零**）。"""
    kind = fact_kind(key)
    if kind in ("money", "fx_rate", "qty", "ratio"):
        return decimal_text(value)
    if kind == "date":
        parsed = equivalents.date_parts(value)
        if parsed is not None:
            return parsed.isoformat()
        # 解析不出就保留原文本（缺信息也要看得见，而不是变成空）
        return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value or ""))).strip()
    text = unicodedata.normalize("NFKC", str(value if value is not None else ""))
    text = re.sub(r"\s+", " ", text).strip()
    if _base_of(key) in ("currency",):
        text = text.upper()
    return text


# ─── A14：包装事实（本单包装来自产品 `spec.packaging[].method`）───────────────
#
# 为什么要有「包装类型」这个派生事实：A12 触发器能写 `packing_type != "wood"`
# 才出非木包装声明，但 `packing_method` 是产品里的自由文本（"木托盘"/"wooden pallet"/
# "纸箱+托盘" 都可能），直接拿它做条件必然写成十种口径。这里用**纯函数归类**把
# 自由文本收敛成 6 个枚举值，归类规则只有一处（前端/API 不另写）。
#
# 归类口径（顺序有意义）：
# 1. 空 / 明确"无包装"字样 ⇒ `none`；
# 2. 按分隔符（`+ / & 、 , ; 和 及`）切词，逐词归到 wood / bag / carton；
#    - 只命中 1 类 ⇒ 该类；
#    - 命中 2+ 类 ⇒ `mixed`（"木托盘+纸箱"）；
# 3. 没有分隔符时按关键词**优先级**（木 > 袋 > 箱）取第一类 ——
#    "木箱" 应归 wood 而不是 mixed（它就是一个木制容器，不是两种包装混用）；
# 4. 都不命中 ⇒ `other`（铁架/裸装等，交给业务人工判断，不硬塞进 6 类）。
PACKING_TYPES: tuple[str, ...] = ("wood", "bag", "carton", "none", "mixed", "other")

# 事实 origin（Worker 解析本单包装后传给 `extract_facts(packing=...)` 的标记）
PACKING_ORIGIN_ROW = "row"                              # 行 spec_snapshot.packaging_id 命中产品配置
PACKING_ORIGIN_PRODUCT_DEFAULT = "inferred:product_default"  # 本单没带 id ⇒ 产品默认包装
PACKING_ORIGIN_SNAPSHOT = "inferred:snapshot"           # 产品解析不到，退回快照里的包装名
PACKING_ORIGIN_NONE = "inferred:none"                   # 产品无包装配置 / 无法解析

_PACKING_NONE_WORDS = (
    "none", "no packing", "without packing", "n/a", "na", "-", "无包装", "不需包装", "无需包装",
)
# 关键词按**优先级**排列：先木、再袋、再箱（"木箱" 归 wood，见上方口径 3）
_PACKING_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("wood", ("木", "wood", "pallet", "托", "plywood", "lumber", "crate")),
    ("bag", ("袋", "bag", "sack")),
    ("carton", ("箱", "carton", "box", "case")),
)
_PACKING_DELIMITERS = re.compile(r"[+/&、,，;；]|(?:\band\b)|(?:[及和])")


def _packing_norm(method: Any) -> str:
    text = unicodedata.normalize("NFKC", str(method if method is not None else ""))
    return re.sub(r"\s+", " ", text).strip().lower()


def _packing_category(token: str) -> Optional[str]:
    for category, keywords in _PACKING_KEYWORDS:
        if any(keyword in token for keyword in keywords):
            return category
    return None


def classify_packing_type(method: Any) -> str:
    """包装方式自由文本 → `wood|bag|carton|none|mixed|other`（纯函数，无副作用）。

    `method` 为空 / 明确"无包装" ⇒ `none`；多类混用（带分隔符命中 2+ 类）⇒ `mixed`；
    未知措辞 ⇒ `other`（不猜成 wood —— 误判会直接导致"该出的非木声明不出"）。
    """
    text = _packing_norm(method)
    if not text or any(word == text for word in _PACKING_NONE_WORDS):
        return "none"

    tokens = [token.strip() for token in _PACKING_DELIMITERS.split(text) if token.strip()]
    if tokens:
        categories: list[str] = []
        for token in tokens:
            category = _packing_category(token)
            if category and category not in categories:
                categories.append(category)
        if len(categories) == 1:
            return categories[0]
        if len(categories) > 1:
            return "mixed"
        # 没有分隔符命中（或分隔后都没关键词）：按优先级取全文第一类
    for category, keywords in _PACKING_KEYWORDS:
        if any(keyword in text for keyword in keywords):
            return category
    if any(word in text for word in _PACKING_NONE_WORDS):
        return "none"
    return "other"


def _dec_or_none(value: Any) -> Optional[Decimal]:
    """宽容转 Decimal（非法值 → None，不抛异常）：比较路径上不该因脏数据中断。"""
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def amount_tolerance(currency: str, *values: Any) -> Decimal:
    """金额容差 —— 与 `workstation.receipt_rules.receipt_tolerance` **同口径**：

        max(5 美分等值, |金额| × 0.1%)

    为什么复用收款的那把尺子：单证之间的金额差异和实收 vs 应收是同一类问题
    （银行手续费/汇率尾差/分角尾数），两处各定一个阈值必然出现"收款能核销、
    单证却报冲突"的口径分裂。`UNCERTAIN #17 ③` 已裁决「每币种
    max(5 美分等值, 0.1%)」，本函数只是把多值取最大做成对称版本
    （比较 A/B 时用两者中较大的金额算容差，A→B 与 B→A 结果一致）。
    """
    code = str(currency or "USD").strip().upper() or "USD"
    worst = Decimal("0")
    for value in values:
        number = _dec_or_none(value)
        if number is None:
            continue
        worst = max(worst, receipt_tolerance(code, abs(number)))
    if worst == 0:
        worst = receipt_tolerance(code, Decimal("0"))
    return worst


def values_equal(
    key: str,
    first: Any,
    second: Any,
    *,
    currency: str = "",
    tolerance: bool = True,
    extra: Optional[Mapping[str, Any]] = None,
) -> bool:
    """同一事实键下两个值是否**可视为同一值**。

    - `money`：带容差比较（同 `amount_tolerance`）；
    - `fx_rate` / `qty` / `ratio`：**精确比较**（汇率/比例/数量不许"差不多"）；
    - `date`：按日期比较（格式差异不算冲突）；
    - `text`：走 `equivalents.equivalent_text`（**只在词表内**判等价）。

    `extra` 是**租户增量词表**（`{规范名: [措辞, ...]}`，参数传入、内核不读库），
    只有文本类事实会用到它。
    """
    kind = fact_kind(key)
    if kind in ("money", "fx_rate", "qty", "ratio"):
        left, right = _dec_or_none(first), _dec_or_none(second)
        if left is not None and right is not None:
            if kind == "money" and tolerance:
                return abs(left - right) <= amount_tolerance(currency, left, right)
            return left == right
        # 数值解析不出（历史脏数据）：退回文本比较，绝不擅自判等
        return equivalents.equivalent_text(first, second, extra)
    if kind == "date":
        left, right = equivalents.date_parts(first), equivalents.date_parts(second)
        if left is not None and right is not None:
            return left == right
        return equivalents.equivalent_text(first, second, extra)
    return equivalents.equivalent_text(first, second, extra)


def fact_label(key: Any) -> tuple[str, str]:
    """事实键 → （中文标签, 英文标签）；行号拼成「（第 2 行）」/「 (line 2)」。"""
    base = _base_of(key)
    index: Optional[int] = None
    match = _TRAILING_INDEX_RE.match(str(key or ""))
    if match is not None:
        index = int(match.group(2))
    zh, en = FACT_LABELS.get(base, (base, base))
    if index is not None:
        zh = f"{zh}（第{index}行）"
        en = f"{en} (line {index})"
    return zh, en


# ─── 三条硬规则 ───────────────────────────────────────────────────────────

def gate_trust(facts: Iterable[Fact], target_status: str) -> list[RuleViolation]:
    """规则 1：`issued` 的单证里不允许存在 `trust != confirmed` 的事实。

    返回**一条**聚合违例（`keys` 里是全部未确认事实的键，按字典序），
    而不是每个事实一条：签发是一个动作、一次拒绝，API 只需要一个
    `FACT_UNVERIFIED` + 待确认清单（前端据此列表让业务员逐项确认）。

    非 `issued` 目标（draft 保存等）一律放行：草稿阶段本来就是"还在改"。
    """
    if str(target_status or "") != "issued":
        return []
    unconfirmed = [fact for fact in facts if fact.trust != TRUST_CONFIRMED]
    if not unconfirmed:
        return []
    keys = tuple(sorted({fact.key for fact in unconfirmed}))
    inferred = sorted({
        fact.key for fact in unconfirmed
        if fact.trust == TRUST_INFERRED or fact.source in (SOURCE_AI, SOURCE_INFERRED)
    })
    detail = (
        f"存在 {len(unconfirmed)} 条未确认事实，不能签发：{', '.join(keys)}。"
        f"请逐项确认后再签发（未确认事实导出时按 TBC/待确认 渲染，不猜值、不留空）。"
    )
    if inferred:
        detail += f" 其中属推断值（不得直接进 issued）：{', '.join(inferred)}。"
    evidence = next((fact.evidence_ref for fact in unconfirmed if fact.evidence_ref), "")
    return [RuleViolation(code=FACT_UNVERIFIED, detail=detail, keys=keys, evidence_ref=evidence)]


def check_immutable(
    base_facts: Iterable[Fact],
    derived_facts: Iterable[Fact],
    *,
    currency: str = "",
    extra: Optional[Mapping[str, Any]] = None,
) -> list[RuleViolation]:
    """规则 2：`immutable=True` 的基线事实，派生单只能**原值引用**。

    - 值相同（或词表内等价措辞 —— `DAP Yangzhou` vs `DAP Yangzhou, Jiangsu, China`）
      ⇒ 允许，不算改值；
    - 值不同 ⇒ 一条 `FACT_IMMUTABLE`，带**原值/新值**，供界面一键"以基线为准"回填。

    `extra` 为租户增量词表（参数传入，内核不读库）。
    """
    base_index = {
        fact.key: fact for fact in base_facts if getattr(fact, "immutable", False)
    }
    if not base_index:
        return []
    violations: list[RuleViolation] = []
    for fact in derived_facts:
        base = base_index.get(fact.key)
        if base is None:
            continue
        if values_equal(fact.key, base.value, fact.value, currency=currency, extra=extra):
            continue
        violations.append(RuleViolation(
            code=FACT_IMMUTABLE,
            detail=(
                f"不可改写事实「{fact_label(fact.key)[0]}」被派生单改动："
                f"基线 {base.value!r} → 派生 {fact.value!r}；"
                "派生单只能原值引用，如需变更请作废基线并重开"
            ),
            keys=(fact.key,),
            original=base.value,
            provided=fact.value,
            evidence_ref=fact.evidence_ref or base.evidence_ref,
        ))
    return violations


def derive_amount(qty: Any, unit_price: Any, fx_rate: Any = None) -> Decimal:
    """规则 3：金额 = 数量 × 单价（给了汇率则 ÷ 汇率），4 位小数 ROUND_HALF_UP。

    汇率方向沿用真实单证口径（`0.3252 = 2.18 ÷ 6.7029`）：单价/金额是**外币**，
    `fx_rate` 是「1 外币 = ? 本币」，所以外币 = 本币金额 ÷ 汇率。
    """
    quantity = to_decimal(qty)
    price = to_decimal(unit_price)
    if quantity is None or price is None:
        raise RuleError(ITEMS_INVALID, "金额推导需要数量与单价（缺一不可）")
    amount = quantity * price
    rate = to_decimal(fx_rate)
    if rate is not None:
        if rate <= 0:
            raise RuleError(ITEMS_INVALID, f"汇率必须为正数：{rate}")
        amount = amount / rate
    return amount.quantize(Decimal(1).scaleb(-AMOUNT_DECIMALS), rounding=ROUND_HALF_UP)


def derive_unit_price(base_price: Any, fx_rate: Any = None) -> Decimal:
    """规则 3 的单价方向：外币单价 = 本币单价 ÷ 汇率（4 位小数）。

    直接对准真实翻车 #3（`2.18 ÷ 6.7029 = 0.3252` 被人工抄成 `0.3253`）：
    单价不提供手抄入口，只提供这条推导。
    """
    price = to_decimal(base_price)
    if price is None:
        raise RuleError(ITEMS_INVALID, "单价推导需要本币单价")
    rate = to_decimal(fx_rate)
    if rate is not None:
        if rate <= 0:
            raise RuleError(ITEMS_INVALID, f"汇率必须为正数：{rate}")
        price = price / rate
    return price.quantize(Decimal(1).scaleb(-AMOUNT_DECIMALS), rounding=ROUND_HALF_UP)


def assert_no_manual_amount(
    *,
    provided: Any = None,
    qty: Any = None,
    unit_price: Any = None,
    fx_rate: Any = None,
    field: str = "amount",
) -> Decimal:
    """规则 3 的写路径闸门：**拒绝手填金额**，返回系统推导值。

    金额只能由 `qty × unit_price（÷ fx_rate）` 推导 —— 真实翻车 #3 就是"手抄单价"
    抄错一位。这里连"手填但填对了"也不接受：一旦允许手填，下一次就一定有人填错，
    而错的那次不会报错。需要落库的是推导值，调用方不要把手填值转进来。

    与 `check_derived_amount` 的分工：本函数管**入口**（抛 `RuleError`，
    风格同 `rules.assert_draft`），那个管**存量数据的核对**（返回结构化违例）。
    """
    if provided is not None and provided != "":
        raise RuleError(
            FACT_MANUAL_AMOUNT,
            f"{field} 只能由「数量 × 单价 ÷ 汇率」推导，不接受手填；收到 {provided!r}",
        )
    return derive_amount(qty, unit_price, fx_rate)


def check_derived_amount(
    expected: Any,
    provided: Any,
    *,
    key: str = "amount",
    digits: int = AMOUNT_DECIMALS,
) -> list[RuleViolation]:
    """核对"推导值 vs 已提供（历史手填/外部抄来）的金额"。

    - `provided` 为空：没有手填值，无需核对 ⇒ 无违例；
    - `expected` 为空但有 `provided`：**没有推导依据却有钱数** ⇒ `FACT_MANUAL_AMOUNT`；
    - 两者都有但对不上（超过 `10^-digits`）⇒ `FACT_CONFLICT`，带两边数值与差额。
    """
    provided_dec = _dec_or_none(provided)
    if provided_dec is None:
        return []
    expected_dec = _dec_or_none(expected)
    if expected_dec is None:
        return [RuleViolation(
            code=FACT_MANUAL_AMOUNT,
            detail=(
                f"「{fact_label(key)[0]}」有手填值 {provided!r}，"
                "但没有可用的推导依据（数量×单价）；请补齐行项目后重算"
            ),
            keys=(key,),
            provided=decimal_text(provided_dec),
        )]
    difference = abs(provided_dec - expected_dec)
    threshold = Decimal(1).scaleb(-digits)
    if difference <= threshold:
        return []
    return [RuleViolation(
        code=FACT_CONFLICT,
        detail=(
            f"「{fact_label(key)[0]}」金额不一致：手填 {decimal_text(provided_dec)} "
            f"≠ 数量×单价推导 {decimal_text(expected_dec)}"
            f"（差 {decimal_text(difference.normalize())}）"
        ),
        keys=(key,),
        original=decimal_text(expected_dec),
        provided=decimal_text(provided_dec),
    )]


# ─── TBC 渲染（规则 1 的下半句）────────────────────────────────────────────

def render_tbc(facts: Iterable[Fact]) -> list[dict]:
    """把**未确认**事实渲染成 TBC 清单（`To be advised` / `待确认`）。

    §4-A 规则 1 的下半句：「未确认事实在导出时按 TBC 渲染清单输出
    （渲染成 To be advised/待确认，**不留空、不猜**）」。

    所以这里：
    - **绝不**输出 `fact.value`（那正是"猜值"）；
    - 中英两侧都填占位，永远不会渲染出空单元格；
    - 同一 key 只出一条（重复事实取第一条，避免同一行打两遍）。

    返回的 dict 可直接被模板/接口消费（JSON 友好）。
    """
    rendered: list[dict] = []
    seen: set[str] = set()
    for fact in sorted(facts, key=lambda item: (item.key, item.trust)):
        if fact.trust == TRUST_CONFIRMED:
            continue
        if fact.key in seen:
            continue
        seen.add(fact.key)
        label_zh, label_en = fact_label(fact.key)
        rendered.append({
            "key": fact.key,
            "label_zh": label_zh,
            "label_en": label_en,
            "placeholder": TBC,
            "value_zh": TBC_ZH,
            "value_en": TBC_EN,
            "text_zh": f"{label_zh}：{TBC_ZH}",
            "text_en": f"{label_en}: {TBC_EN}",
            "source": fact.source,
            "trust": fact.trust,
            "evidence_ref": fact.evidence_ref,
        })
    return rendered


# ─── 付款条件结构化 ────────────────────────────────────────────────────────

@dataclass(frozen=True)
class PaymentTermPart:
    """付款条件里的一条结构化片段：`(30%, deposit, upon_order_confirmation)`。

    §3 #2 的抽象能力："付款条件作为**结构化 fact**（时点枚举 + 比例），
    不允许自由文本各写各的"。`text` 保留原句片段，供人工核对与双语对照。
    """

    role: str                       # deposit | balance | full
    ratio: Decimal
    timing: Optional[str] = None    # 时点规范名；认不出则 None（不猜）
    text: str = ""


_PERCENT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*%")
_DEPOSIT_WORDS = ("deposit", "down payment", "advance", "prepay", "定金", "预付款", "首付")
_BALANCE_WORDS = ("balance", "尾款", "余款", "货款", "余额")
_SEGMENT_SPLIT_RE = re.compile(r"[,;、，；]|\s+\+\s+")


def _role_of(segment: str, ratio: Decimal) -> Optional[str]:
    lowered = unicodedata.normalize("NFKC", segment).casefold()
    deposit_hit = any(word in lowered for word in _DEPOSIT_WORDS)
    balance_hit = any(word in lowered for word in _BALANCE_WORDS)
    if deposit_hit and balance_hit:
        return None  # 一句话里两个角色都出现：不猜，交人工
    if deposit_hit:
        return "deposit"
    if balance_hit:
        return "balance"
    if ratio == 1:
        return "full"
    return None


def parse_payment_terms(
    value: Any, extra: Optional[Mapping[str, Any]] = None
) -> list[PaymentTermPart]:
    """把付款条件散文拆成结构化片段（比例 + 角色 + 时点枚举）。

    只认得出"带百分比 + 角色词"的片段；认不出的**直接跳过**（不猜），
    原文仍作为 `payment_terms` 事实保留 —— 少一条结构化事实，好过多一条错的。

    `extra` 是租户增量词表：租户自己的时点写法（如 `net 60 days after B/L`）
    只有传进来才能被认成枚举，否则该片段不会产出时点事实（宁缺勿猜）。
    """
    text = str(value or "").strip()
    if not text:
        return []
    parts: list[PaymentTermPart] = []
    for segment in _SEGMENT_SPLIT_RE.split(text):
        segment = unicodedata.normalize("NFKC", segment or "").strip()
        if not segment:
            continue
        match = _PERCENT_RE.search(segment)
        if match is None:
            continue
        try:
            percent = Decimal(match.group(1))
        except InvalidOperation:  # pragma: no cover - 正则已限数字
            continue
        if percent <= 0 or percent > 100:
            continue
        ratio = (percent / Decimal(100)).normalize()
        role = _role_of(segment, ratio)
        if role is None:
            continue
        parts.append(PaymentTermPart(
            role=role,
            ratio=ratio,
            timing=equivalents.timing_canonical(segment, extra),
            text=segment,
        ))
    return parts


# ─── 从 payload 抽取事实 ──────────────────────────────────────────────────

# 上游快照的优先顺序：PI 是客户签回的基线，最近的那份最能代表"已确认口径"。
_BASELINE_ORDER: tuple[str, ...] = ("pi", "contract", "order", "quote", "quotation", "inquiry")

# 上游单证号：不同单证各自的编号，跨单证必须一致（复盘 54 条里的"编号"一类）
_REF_FIELDS: dict[str, str] = {
    "pi": "pi_no",
    "contract": "contract_no",
    "order": "order_no",
    "quote": "quote_no",
    "quotation": "quote_no",
    "inquiry": "inquiry_no",
}

# 快照 status 里这些值表示"源还没定稿" ⇒ 从里面抽出来的事实不算已确认
_UNCONFIRMED_STATUSES = frozenset({"draft", "pending", "unverified", "void", "cancelled"})

_ITEM_FIELDS = ("qty", "unit_price", "line_amount")

_CLEAN_WHITESPACE = re.compile(r"\s+")


def _has_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple, dict, set)):
        return bool(value)
    return True


def _flatten_snapshot(snapshot: Any) -> dict:
    """把上游快照摊平成一张字段表（兼容两种形状）。

    - 订单/报价/询盘快照：本身就是平铺字段表；
    - 单证派生（`sources.pi` 存的是**上游单证的整份 raw_payload**）：先递归摊平它的
      `sources`，再叠上它的 `custom`（custom 优先 = 手工 > 派生，与 `compose_fields` 同序）。
    """
    if not isinstance(snapshot, Mapping):
        return {}
    if "sources" in snapshot or "custom" in snapshot:
        flat: dict = {}
        nested = snapshot.get("sources")
        if isinstance(nested, Mapping):
            for value in nested.values():
                flat.update(_flatten_snapshot(value))
        custom = snapshot.get("custom")
        if isinstance(custom, Mapping):
            flat.update({key: value for key, value in custom.items() if value is not None})
        # 单证自身的号/日期放在 custom 里；若没有，看看平铺字段兜底
        for key, value in snapshot.items():
            if key not in ("sources", "custom", "derived", "_audit") and value is not None:
                flat.setdefault(key, value)
        return flat
    return {key: value for key, value in snapshot.items() if value is not None}


def _baseline_snapshot(sources: Mapping[str, Any]) -> tuple[str, dict]:
    for kind in _BASELINE_ORDER:
        flat = _flatten_snapshot(sources.get(kind))
        if flat:
            return kind, flat
    return "", {}


def _baseline_trust(baseline: Mapping[str, Any]) -> str:
    status = str(baseline.get("status") or "").strip().lower()
    return TRUST_UNVERIFIED if status in _UNCONFIRMED_STATUSES else TRUST_CONFIRMED


def _bilingual(value: Any) -> tuple[str, str]:
    """原文只有一种语言：是中文进 `text_zh`，否则进 `text_en`（另一侧留空）。"""
    text = _CLEAN_WHITESPACE.sub(" ", str(value if value is not None else "")).strip()
    if not text:
        return "", ""
    return (text, "") if _CJK_RE.search(text) else ("", text)


def extract_facts(
    payload: Mapping[str, Any],
    doc_type: str,
    *,
    immutable_keys: Optional[Sequence[str]] = None,
    extra_equivalents: Optional[Mapping[str, Any]] = None,
    packing: Optional[Mapping[str, Any]] = None,
) -> list[Fact]:
    """从既有 payload 结构抽取事实（§4-A 的入口）。

    入参 `payload` 可以是 `raw_payload`，也可以是「`raw_payload` + 整行字段」
    （`doc_no` / `currency` / `total_amount` / `issued_at` / `status` 等）。
    Worker 侧建议：`extract_facts({**payload_of(row), **row}, doc_type)`。

    抽取范围（对齐 `check_pi_sc_ci.py` 的 54 条事实矩阵，去掉该脚本里
    "某段文字是否出现在 PDF 里"这类排版检查）：
    贸易条款 / 币种 / 金额 / 汇率 / 明细行（qty、unit_price、line_amount）/
    单据自身编号与日期（身份事实）/ 上游单号 / 买方 / 付款条件结构化。

    返回顺序稳定（条款 → 金额 → 明细 → 编号 → 引用 → 主体 → 付款结构），
    同 key 只保留第一次出现的值。

    `immutable_keys` 可覆盖"不可改写"清单（默认 `IMMUTABLE_KEYS`）；
    `extra_equivalents` 是租户增量词表，用于把租户自己的付款时点写法认成枚举
    （参数传入、内核不读库，见 `equivalents` 的维护口径）。

    `packing`（A14，可选）是本单包装的**解析结果**（Worker 负责从「行 packaging_id →
    产品 packaging[]」解析，内核不读产品库）：`{method, origin, packaging_id?, packaging_name?}`。
    传入时追加 `packing_method`（原文）/`packing_type`（`classify_packing_type` 归类枚举）；
    不传则**不产生**包装事实（保持既有调用方 payload 口径不变）。
    """
    data: dict = dict(payload) if isinstance(payload, Mapping) else {}
    doc_type = str(doc_type or "other").strip() or "other"
    raw_sources = data.get("sources")
    raw_custom = data.get("custom")
    sources: Mapping[str, Any] = raw_sources if isinstance(raw_sources, Mapping) else {}
    custom: Mapping[str, Any] = raw_custom if isinstance(raw_custom, Mapping) else {}

    immutable = set(IMMUTABLE_KEYS if immutable_keys is None else immutable_keys)

    # 手工层：受保护字段（items/total_amount）不得由 custom 覆盖 —— 与渲染侧同一道闸门，
    # 否则"手填内容改总金额"这个坑会从事实层再开一次。
    manual = {
        key: value for key, value in custom.items()
        if key not in PROTECTED_CUSTOM_FIELDS and value is not None
    }

    baseline_kind, baseline = _baseline_snapshot(sources)
    baseline_source = SOURCE_PI if baseline_kind == "pi" else SOURCE_UPSTREAM
    baseline_trust = _baseline_trust(baseline)
    effective = compose_fields(derived=baseline, manual=manual) if (baseline or manual) else {}

    def origin(raw_key: str) -> tuple[str, str, str]:
        """(source, trust, evidence_ref) —— 这个字段的值到底是谁给的。"""
        if raw_key in manual:
            return SOURCE_MANUAL, TRUST_CONFIRMED, f"custom.{raw_key}"
        if raw_key in baseline:
            prefix = f"sources.{baseline_kind}." if baseline_kind else "sources."
            return baseline_source, baseline_trust, f"{prefix}{raw_key}"
        if raw_key in data:
            return SOURCE_MANUAL, TRUST_CONFIRMED, raw_key
        return SOURCE_INFERRED, TRUST_UNVERIFIED, ""

    facts: list[Fact] = []
    seen: set[str] = set()

    def add(
        raw_key: str,
        value: Any,
        *,
        key: Optional[str] = None,
        source: Optional[str] = None,
        trust: Optional[str] = None,
        evidence: Optional[str] = None,
        text_zh: str = "",
        text_en: str = "",
        currency: str = "",
    ) -> Optional[Fact]:
        fact_key = key or normalize_fact_key(raw_key)
        if not fact_key or fact_key in seen:
            return None
        resolved_source, resolved_trust, resolved_evidence = origin(raw_key)
        if text_zh or text_en:
            zh, en = text_zh, text_en
        else:
            zh, en = _bilingual(value) if fact_kind(fact_key) == "text" else ("", "")
        fact = Fact(
            key=fact_key,
            value=value,
            text_zh=zh,
            text_en=en,
            source=source or resolved_source,
            trust=trust or resolved_trust,
            immutable=fact_key in immutable,
            evidence_ref=evidence if evidence is not None else resolved_evidence,
            currency=currency,
        )
        seen.add(fact_key)
        facts.append(fact)
        return fact

    # 1) 贸易条款块（字段名与 payload_shared.TRADE_TERM_FIELDS 完全一致）
    for field_name in TRADE_TERM_FIELDS:
        if _has_value(effective.get(field_name)):
            add(field_name, effective[field_name])

    # 2) 币种 / 总金额 / 汇率
    currency = ""
    if _has_value(effective.get("currency")):
        fact = add("currency", effective["currency"])
        currency = fact.value if fact is not None else ""
    if _has_value(effective.get("total_amount")):
        add("total_amount", effective["total_amount"], currency=currency)
    # 应付总额（A6-1 真实单据校准）：含内陆运费的实际应付额，与 total_amount 分开抽取。
    # 真实 PI/CI 把它拆成两币种字段（total_payable_cny / total_payable_usd），
    # 这里按单据币种取对应一侧；两币种值都由渲染侧推导，事实层只记录单据币种口径。
    payable: Any = None
    payable_key = ""
    for candidate in ("total_payable", "total_amount_payable", "amount_payable"):
        if _has_value(effective.get(candidate)):
            payable, payable_key = effective[candidate], candidate
            break
    if payable is None:
        by_currency = (
            "total_payable_cny"
            if str(currency).upper() in ("CNY", "RMB")
            else "total_payable_usd"
        )
        if _has_value(effective.get(by_currency)):
            payable, payable_key = effective[by_currency], by_currency
    if _has_value(payable):
        # 用命中的**原始字段名**做 origin 查询：否则 custom.total_payable_usd 会被误标成"推断值"
        add(payable_key, payable, key="total_payable", currency=currency)
    if _has_value(effective.get("fx_rate")):
        add("fx_rate", effective["fx_rate"])

    # 2.5) 包装事实（A14）：**本单包装由调用方解析后传入**，内核不读产品库。
    #
    # `packing` 契约（Worker `_resolve_packing` 产出）：
    #   {"method": "木托盘", "origin": "row" | "inferred:product_default"
    #                | "inferred:snapshot" | "inferred:none",
    #    "packaging_id": "pk_1"?, "packaging_name": "木托盘"?}
    # `origin` 是产品配置/行的**来源标记**：`row` = 本单行 packaging_id 命中；
    # `inferred:product_default` = 本单没带 id、回退产品默认包装（任务要求显式标注）。
    #
    # trust 一律 confirmed：包装是**产品配置的确定性推导**，不是业务员填的待确认值；
    # 若标 unverified，任何一张带包装的单据都会因 `gate_trust` 签不出去（事实层的闸门
    # 是给"人工声明值"用的，不适用于配置派生值）。
    if packing:
        packing_origin = str(packing.get("origin") or PACKING_ORIGIN_NONE)
        packaging_id = str(packing.get("packaging_id") or "").strip()
        packaging_name = str(packing.get("packaging_name") or "").strip()
        if packing_origin == PACKING_ORIGIN_ROW and packaging_id:
            evidence = f"spec_snapshot.packaging_id={packaging_id}"
        elif packing_origin == PACKING_ORIGIN_PRODUCT_DEFAULT:
            evidence = PACKING_ORIGIN_PRODUCT_DEFAULT
            if packaging_id:
                evidence += f" (packaging_id={packaging_id})"
            elif packaging_name:
                evidence += f" (packaging={packaging_name})"
        elif packing_origin == PACKING_ORIGIN_SNAPSHOT:
            evidence = PACKING_ORIGIN_SNAPSHOT
        else:
            evidence = PACKING_ORIGIN_NONE

        source = SOURCE_MANUAL if packing_origin == PACKING_ORIGIN_ROW else SOURCE_INFERRED
        method_text = normalize_fact_value(
            "packing_method", packing.get("method") or "none",
        ) or "none"

        def add_packing(fact_key: str, fact_value: Any) -> None:
            if fact_key in seen:
                return
            zh, en = _bilingual(fact_value)
            facts.append(Fact(
                key=fact_key,
                value=fact_value,
                text_zh=zh,
                text_en=en,
                source=source,
                trust=TRUST_CONFIRMED,
                immutable=False,
                evidence_ref=evidence,
            ))
            seen.add(fact_key)

        # `packing_method` 保留产品里的**原文**（可读、可追溯）；`packing_type` 是归类枚举
        add_packing("packing_method", method_text)
        add_packing("packing_type", classify_packing_type(method_text))

    # 3) 明细行：qty[i] / unit_price[i] / line_amount[i]（行号 1 起，与界面一致）
    items = effective.get("items")
    if isinstance(items, (list, tuple)):
        for index, item in enumerate(items, 1):
            if not isinstance(item, Mapping):
                continue
            item_source, item_trust, item_evidence = origin("items")
            item_currency = str(item.get("currency") or currency or "").upper()
            for field_name in _ITEM_FIELDS:
                if not _has_value(item.get(field_name)):
                    continue
                add(
                    field_name,
                    item[field_name],
                    key=f"{normalize_fact_key(field_name)}[{index}]",
                    source=item_source,
                    trust=item_trust,
                    evidence=f"{item_evidence}[{index}].{field_name}" if item_evidence else "",
                    currency=item_currency,
                )

    # 4) 单据自身编号 / 日期（身份事实；一致性引擎默认不跨单证比较，见 consistency.IDENTITY_KEYS）
    #
    # 身份事实的信任级**不能**落到"推断"：单号是系统发的、日期是系统记的（行字段），
    # 若把它们标成 unverified，任何一张单证都会因为"单据日期没确认"而签不出去。
    def add_identity(raw_key: str, value: Any, key: str) -> None:
        source, trust, evidence = origin(raw_key)
        if trust != TRUST_CONFIRMED:
            source, trust, evidence = SOURCE_MANUAL, TRUST_CONFIRMED, evidence or "row"
        add(raw_key, value, key=key, source=source, trust=trust, evidence=evidence)

    no_field, date_field = DOC_NO_FIELDS.get(doc_type, (None, None))
    own_no = data.get("doc_no")
    if not _has_value(own_no) and no_field:
        own_no = effective.get(no_field)
    if _has_value(own_no):
        add_identity(no_field or "doc_no", own_no, "doc_no")
    own_date = None
    for candidate in (effective.get(date_field) if date_field else None,
                      data.get("doc_date"), data.get("issued_at"), data.get("created_at")):
        if _has_value(candidate):
            own_date = candidate
            break
    if _has_value(own_date):
        add_identity(date_field or "date", own_date, "date")

    # 5) 上游单号（PI 号 / 合同号 / 订单号 / 报价单号）—— 复盘"编号"一类事实
    for kind in _BASELINE_ORDER:
        snapshot = sources.get(kind)
        if snapshot is None:
            continue
        flat = _flatten_snapshot(snapshot)
        ref_field = _REF_FIELDS.get(kind)
        if not ref_field:
            continue
        value = flat.get(ref_field)
        if not _has_value(value):
            value = flat.get("doc_no")
        if not _has_value(value):
            continue
        add(
            ref_field,
            value,
            key=normalize_fact_key(ref_field),
            source=SOURCE_PI if kind == "pi" else SOURCE_UPSTREAM,
            trust=_baseline_trust(flat),
            evidence=f"sources.{kind}.{ref_field}",
        )

    # 6) 买方（真实翻车 #5：从邮箱域名"推出"买方公司名写进合同 —— 这条正是推断值）
    for raw_key in ("buyer", "buyer_name", "customer_name"):
        if _has_value(manual.get(raw_key)):
            add(raw_key, manual[raw_key], key="buyer_name")
            break
    else:
        if _has_value(baseline.get("customer_name")):
            add("customer_name", baseline["customer_name"], key="buyer_name")

    # 7) 付款条件结构化（§3 #2）：比例 + 时点；解析是推断 ⇒ trust=unverified
    payment_text = effective.get("payment_terms")
    if _has_value(payment_text):
        payment_source, _, payment_evidence = origin("payment_terms")
        for part in parse_payment_terms(payment_text, extra_equivalents):
            ratio_key = f"payment_{part.role}_ratio"
            parsed_evidence = f"{payment_evidence}（解析）" if payment_evidence else "解析"
            add(
                ratio_key,
                part.ratio,
                key=ratio_key,
                source=payment_source,
                trust=TRUST_UNVERIFIED,
                evidence=parsed_evidence,
                text_zh=part.text if _CJK_RE.search(part.text) else "",
                text_en="" if _CJK_RE.search(part.text) else part.text,
            )
            if part.timing:
                timing_key = f"payment_{part.role}_timing"
                add(
                    timing_key,
                    part.timing,
                    key=timing_key,
                    source=payment_source,
                    trust=TRUST_UNVERIFIED,
                    evidence=parsed_evidence,
                    text_zh=part.text if _CJK_RE.search(part.text) else "",
                    text_en="" if _CJK_RE.search(part.text) else part.text,
                )

    return facts


def confirm_fact(
    fact: Fact,
    *,
    by: Optional[Any] = None,
    at: Optional[str] = None,
) -> Fact:
    """人工确认一条事实（返回**新**事实，不改原对象 —— 事实层不写库、不改历史）。"""
    return replace(
        fact,
        trust=TRUST_CONFIRMED,
        confirmed_by=by if by is not None else fact.confirmed_by,
        confirmed_at=at if at is not None else fact.confirmed_at,
    )
