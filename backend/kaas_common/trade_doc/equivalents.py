"""等价措辞表 —— 单证加固 A7 一致性引擎的**语义等价白名单**（纯函数、stdlib only）。

为什么要有单独一个文件
----------------------
「同一事实在两份单证里措辞不同」是出口单证最常见的翻车点（2026-10-12 Tim 单复盘：
PI 写 `70% balance before dispatch`、SC 写 `upon dispatch (before delivery)`；
CI 写 `(Incoterms 2020)`、SC 只写 `DAP Yangzhou, Jiangsu, China`）。
但**自动把差异吞掉比报错更贵**：信用证审单按字面，词表外的"差不多"就是不符点。
所以本模块的定位是**白名单**，而不是模糊匹配器：

    · 只有 `EQUIVALENT_GROUPS` 里列出的措辞、以及本模块**明确定义**的
      结构化归一（Incoterms 版式、金额大小写、日期格式）才判等价；
    · 其余一律按「不等价」上交 —— 由 `consistency.diff_facts` 报 `FACT_CONFLICT`。
      **绝不静默吞差异**，也绝不靠"相似度"猜。

维护口径（`docs/UNCERTAIN.md` #17 ②，2026-10-17 裁决）
------------------------------------------------------
全局词表放在共享内核（本文件，仅 internal 可改）；**租户增量以参数传入**
（`extra`），内核不读库、不碰任何三方依赖 —— 这是"纯函数层"的边界。
`extra` 形状与 `EQUIVALENT_GROUPS` 相同：`{规范名: [措辞, ...]}`，
可以给已有分组追加措辞，也可以新增分组；同名冲突时**租户增量优先**
（租户口径覆盖全局默认，但删不掉全局条目）。

结构化归一的边界（同样属于白名单，逐条写在下面）
------------------------------------------------
1. **Incoterms**：`DAP Yangzhou` ≡ `DAP Yangzhou, Jiangsu, China`（地点逐段前缀），
   但**版本必须一致** —— `(Incoterms 2020)` 少写/多写就是冲突（真实翻车 #1：
   CI 写了版本、SC 没写）。裸 `DAP`（无地点）与 `DAP Yangzhou` 也算冲突。
2. **金额**：`USD 2,826.49` ≡ `SAY US DOLLARS TWO THOUSAND EIGHT HUNDRED AND TWENTY SIX
   AND CENTS FORTY NINE ONLY` ≡ `美元贰仟捌佰贰拾陆元肆角玖分`。
   解析失败一律**不当成 0、不当成相等**（返回 None，退回文本比较 → 报冲突让人看）。
   千分位/小数位写法差异（`2,826.49` / `2826.490`）也归在这里 —— 属排版差异。
3. **日期**：`2026-10-12` ≡ `12 Oct 2026` ≡ `October 12, 2026` ≡ `2026年10月12日`。
4. **付款条款整句**（`payment_clause_signature`）：把整句压成
   （比例, 时点规范名, 去掉时点与比例后的残余文字）的签名，**只放过时点措辞这一处差异**。
   真实单证写的是整句（`70% balance before dispatch`），词表列的是片段
   （`before dispatch`），只做整串比较的话那条等价规则永远命不中。
5. **全半角 / 中英标点 / 大小写 / 空白**：属排版归一（`normalize_text`），不是语义等价。

已知**不做**的（故意留给人工）
------------------------------
- 不做模糊匹配（编辑距离、同义词词典、向量相似度）：一旦"看着像"就放过，
  下次真不符点时系统会沉默，而这正是本方案要消灭的东西。
- 不做中文金额的 `亿` + `万` 复合写法（超过一亿的合同不在本工位口径内；
  解析器遇到会返回 None，退化为文本比较 → 报冲突，而不是算错）。
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping, Optional

__all__ = [
    "EQUIVALENT_GROUPS",
    "TIMING_GROUPS",
    "INCO_TERMS",
    "IncotermParts",
    "AmountParts",
    "normalize_text",
    "canonical_phrase",
    "timing_canonical",
    "timing_match",
    "payment_clause_signature",
    "incoterm_parts",
    "incoterm_equivalent",
    "amount_parts",
    "date_parts",
    "equivalent_text",
]

# ─── 一、等价措辞白名单（唯一数据源）─────────────────────────────────────────
#
# 口径：**仅此处列出的才算等价。** 新增一条等于承认"这两种写法是真的同一件事"，
# 必须能在真实单证里指出来（下面的注释就是出处）；拿不准时宁可加进冲突清单，
# 让业务员在界面上按"以基线为准"回填 —— 那是显式动作，不是系统替人拍板。
EQUIVALENT_GROUPS: dict[str, tuple[str, ...]] = {
    # 付款时点：定金（Tim 单 PI/SC/CI 三份都用这几种写法中的一种）
    "upon_order_confirmation": (
        "upon order confirmation",
        "upon confirmation of the order",
        "after order confirmation",
        "upon order placement",
        "订单确认后",
        "订单确认时",
    ),
    # 尾款时点：真实翻车 #2 —— PI/CI 写 `before dispatch`、SC 写
    # `upon dispatch (before delivery)`，同一时点的两种写法（§4-E 的枚举名取后者）。
    #
    # ⚠️ 裸 `upon dispatch` **故意不在本组**（见下一个分组）：少写
    # "(before delivery)" 这个限定语在信用证审单里就是不符点，不由系统替业务员认定等价。
    "upon_dispatch_before_delivery": (
        "upon dispatch (before delivery)",
        "upon dispatch before delivery",
        "before dispatch",
        "before delivery",
        "prior to delivery",
        "发货前",
        "装运前",
    ),
    # 裸 `upon dispatch`：只与"同义换词"等价，与上面的限定语版本**不等价**
    "upon_dispatch": (
        "upon dispatch",
        "at dispatch",
        "on dispatch",
    ),
    # 余款凭单：信用证/DP 场景
    "against_documents": (
        "against documents",
        "against shipping documents",
        "upon presentation of documents",
        "凭单付款",
    ),
    # 定金已付的三种写法（真实单证：SC 写 `already paid by the buyer`、
    # CI 写 `Paid by Buyer`；§4-E「收款状态回写」允许按模板改写这句，
    # 但它表达的是**同一件事**，不该被一致性引擎当成冲突）
    "paid_by_buyer": (
        "paid by the buyer",
        "paid by buyer",
        "already paid by the buyer",
        "has been paid by the buyer",
        "the deposit has been paid",
        "定金已付",
        "已由买方支付",
    ),
}

# 付款时点类分组的子集：只有这些参与「付款条件文本 → 结构化时点枚举」的归一。
# （`paid_by_buyer` 是收款状态措辞，不是时点，混进来会把状态误读成时间。）
TIMING_GROUPS: tuple[str, ...] = (
    "upon_order_confirmation",
    "upon_dispatch_before_delivery",
    "upon_dispatch",
    "against_documents",
)

# ─── 二、Incoterms 2020 术语代码 ────────────────────────────────────────────
INCO_TERMS: tuple[str, ...] = (
    "EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP",
)

# ─── 三、文本归一（排版层面，不含语义）─────────────────────────────────────
#
# NFKC 负责：全角字母/数字/标点（`，` `（` `：`）、`㎡`、`①` 等兼容字符。
# 剩下的中文专用标点 NFKC 不处理，手工补；统一成 ASCII 后再折叠空白。
_PUNCT_MAP = {
    "\u3000": " ",   # 全角空格
    "\u3001": ",",   # 、顿号 → 逗号
    "\u3002": ".",   # 。句号 → 点
    "\u2014": "-",   # — em dash
    "\u2013": "-",   # – en dash
    "\u2010": "-",   # ‐ hyphen
    "\u2011": "-",   # ‑ non-breaking hyphen
    "\u201c": '"',
    "\u201d": '"',
    "\u2018": "'",
    "\u2019": "'",
    "\uff65": ".",   # ･ 半角中黑
}

_SPACE_AROUND_PUNCT = re.compile(r"\s*([,;:()\[\]%/])\s*")
_WHITESPACE = re.compile(r"\s+")


def normalize_text(value: Any) -> str:
    """文本归一：全半角/大小写/空白/中英标点 —— **只做排版归一，不做语义猜测**。

    归一后仍是"人写的字符串"，只保证同一句话的不同排版写法得到同一个结果。
    空值统一成 `""`（调用方据此判"缺事实"）。
    """
    if value is None:
        return ""
    text = unicodedata.normalize("NFKC", str(value))
    for source, target in _PUNCT_MAP.items():
        text = text.replace(source, target)
    text = text.casefold()
    text = _WHITESPACE.sub(" ", text)
    # 标点两侧的空格不携带信息："Yangzhou, Jiangsu" 与 "Yangzhou,Jiangsu" 必须同形。
    text = _SPACE_AROUND_PUNCT.sub(r"\1", text)
    return text.strip()


# ─── 四、词表查询 ──────────────────────────────────────────────────────────

def _variant_index(extra: Optional[Mapping[str, Any]] = None) -> dict[str, str]:
    """`归一化措辞 → 规范名` 索引：内置表打底，租户增量覆盖（后写优先）。"""
    index: dict[str, str] = {}
    for canonical, variants in EQUIVALENT_GROUPS.items():
        for variant in variants:
            index[normalize_text(variant)] = canonical
    for canonical, variants in (extra or {}).items():
        if not canonical or not variants:
            continue
        if isinstance(variants, str):
            variants = (variants,)
        for variant in variants:
            text = normalize_text(variant)
            if text:
                index[text] = str(canonical)
    return index


_BASE_INDEX: dict[str, str] = _variant_index()


def canonical_phrase(value: Any, extra: Optional[Mapping[str, Any]] = None) -> Optional[str]:
    """整串命中词表时返回规范名，否则 None（**不猜**）。

    只认"整串等于表里某条措辞"，不做包含匹配 —— 包含匹配交给 `timing_canonical`
    （它只用于"这条付款条件里的时点是什么"，且只在 `TIMING_GROUPS` 内找最长命中）。
    """
    text = normalize_text(value)
    if not text:
        return None
    if extra:
        override = _variant_index(extra).get(text)
        if override is not None:
            return override
    return _BASE_INDEX.get(text)


def timing_match(
    value: Any, extra: Optional[Mapping[str, Any]] = None
) -> Optional[tuple[str, str]]:
    """在一句话里找**付款时点**：(规范名, 命中的归一化措辞)；认不出返回 None。

    只认白名单里列出的措辞，并在其中取**最长命中**：
    `upon dispatch (before delivery)` 必须压过任何更短的片段，
    否则限定语会被吃掉、`upon dispatch` 与它被误判成同一件事。

    内置口径只在 `TIMING_GROUPS` 内找（`paid_by_buyer` 这类"收款状态措辞"
    不是时点，混进来会把状态误读成时间）；**租户增量里新增的分组算作时点分组**
    —— 租户加条目就是为了让自己的时点写法被认出来，这一点由租户自己负责。
    """
    text = normalize_text(value)
    if not text:
        return None
    index = _variant_index(extra)
    timing_names = set(TIMING_GROUPS) | set((extra or {}).keys())
    best: Optional[tuple[str, str]] = None
    for variant, canonical in index.items():
        if canonical not in timing_names or not variant:
            continue
        if variant in text and (best is None or len(variant) > len(best[1])):
            best = (canonical, variant)
    return best


def timing_canonical(value: Any, extra: Optional[Mapping[str, Any]] = None) -> Optional[str]:
    """从一句付款条件里认**付款时点**的规范名；认不出返回 None。"""
    matched = timing_match(value, extra)
    return matched[0] if matched else None


# ─── 五之二、付款条件的结构化签名 ──────────────────────────────────────────
#
# 为什么还要多这一层（除了词表）：
# 真实单证里的付款条款是**整句**（`30% deposit upon order confirmation,
# 70% balance before dispatch`），而词表里列的是**片段**（`before dispatch`）。
# 只做整串比较的话，"改述"永远命中不了词表 —— 那条 `before dispatch` ≡
# `upon dispatch (before delivery)` 的等价规则就废了。
#
# 做法（仍然是白名单，仍然不猜）：把整句压成
#     ((比例, 时点规范名, 去掉时点与比例后的残余文字), ...)
# 也就是**只对"时点措辞"这一处放过差异**，其余文字（`deposit`/`balance`/角色词）
# 必须完全一致。任一片段认不出时点 ⇒ 返回 None（不做结构判定，退化为文本比较 → 冲突）。

_PERCENT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*%")
_SEGMENT_SPLIT_RE = re.compile(r"[,;]")


def _percent_text(raw: str) -> str:
    try:
        return format(Decimal(raw).normalize(), "f")
    except InvalidOperation:  # pragma: no cover - 正则已限数字
        return raw


def payment_clause_signature(
    value: Any, extra: Optional[Mapping[str, Any]] = None
) -> Optional[tuple[tuple[str, str, str], ...]]:
    """把整句付款条件压成结构签名；任一片段认不出时点/比例 ⇒ None。

    `30% deposit upon order confirmation, 70% balance before dispatch`
    → `(("30", "upon_order_confirmation", "deposit"), ("70", "upon_dispatch_before_delivery", "balance"))`
    """
    text = normalize_text(value)
    if not text or "%" not in text:
        return None
    parts: list[tuple[str, str, str]] = []
    for segment in _SEGMENT_SPLIT_RE.split(text):
        segment = segment.strip()
        if not segment:
            continue
        percent = _PERCENT_RE.search(segment)
        if percent is None:
            return None
        matched = timing_match(segment, extra)
        if matched is None:
            return None
        canonical, variant = matched
        residual = segment.replace(variant, " ")
        residual = _PERCENT_RE.sub(" ", residual)
        residual = _WHITESPACE.sub(" ", residual).strip(" .,:;-()[]/")
        parts.append((_percent_text(percent.group(1)), canonical, residual))
    if not parts:
        return None
    return tuple(sorted(parts))


# ─── 五、Incoterms 结构化归一 ───────────────────────────────────────────────

@dataclass(frozen=True)
class IncotermParts:
    """一条贸易术语的拆解：`DAP Yangzhou, Jiangsu, China (Incoterms 2020)`。

    - `code`    三字母术语代码（大写，取自 `INCO_TERMS`）
    - `place`   交货地点原文（归一后，逐段比较用）
    - `version` Incoterms 版本（如 `"2020"`）；**未写则 None** —— None 与
      `"2020"` 不相等，这正是"版本被删掉"要报冲突的原因。
    """

    code: str
    place: str
    version: Optional[str] = None

    @property
    def place_segments(self) -> tuple[str, ...]:
        return tuple(seg for seg in (s.strip() for s in self.place.split(",")) if seg)


_INCO_RE = re.compile(r"^([a-z]{3})\b[\s,:;.\-]*(.*)$")
_INCO_VERSION_RE = re.compile(r"\(?\bincoterms?\b\s*®?\s*(\d{4})\s*\)?")
_INCO_VERSION_LOOSE_RE = re.compile(r"\bincoterms?\s*®?\s*(\d{4})\b")


def incoterm_parts(value: Any) -> Optional[IncotermParts]:
    """解析贸易术语串；不是 Incoterms 写法时返回 None（不猜、不报错）。"""
    text = normalize_text(value)
    if not text:
        return None
    match = _INCO_RE.match(text)
    if match is None:
        return None
    code = match.group(1).upper()
    if code not in INCO_TERMS:
        return None
    rest = match.group(2)

    version: Optional[str] = None
    found = _INCO_VERSION_RE.search(rest) or _INCO_VERSION_LOOSE_RE.search(rest)
    if found is not None:
        version = found.group(1)
        # 版本标记可能是 "(incoterms 2020)"，连括号一起删，避免地点里留残渣
        rest = _INCO_VERSION_RE.sub(" ", rest)
        rest = re.sub(r"\bincoterms?\b\s*®?\s*\d{4}\b", " ", rest)

    place = rest.strip(" \t-–—,;:()[]")
    place = _WHITESPACE.sub(" ", place).strip()
    return IncotermParts(code=code, place=place, version=version)


def _place_compatible(a: str, b: str) -> bool:
    """地点兼容：两侧都空 → 真；一侧空 → 假；否则**逐段前缀**相等。

    `DAP Yangzhou` ⊂ `DAP Yangzhou, Jiangsu, China`（少写省/国不算改事实），
    但 `DAP Yangzhou, Jiangsu` 与 `DAP Yangzhou, Anhui` 在第二段分叉 → 不等价。
    """
    seg_a = tuple(s for s in (x.strip() for x in a.split(",")) if s)
    seg_b = tuple(s for s in (x.strip() for x in b.split(",")) if s)
    if not seg_a and not seg_b:
        return True
    if not seg_a or not seg_b:
        return False
    shorter, longer = (seg_a, seg_b) if len(seg_a) <= len(seg_b) else (seg_b, seg_a)
    return longer[: len(shorter)] == shorter


def incoterm_equivalent(a: Any, b: Any) -> bool:
    """两条贸易术语是否等价（代码同 + 版本同 + 地点前缀兼容）。"""
    left, right = incoterm_parts(a), incoterm_parts(b)
    if left is None or right is None:
        return False
    if left.code != right.code:
        return False
    if (left.version or "") != (right.version or ""):
        return False
    return _place_compatible(left.place, right.place)


# ─── 六、金额（含中英大写）─────────────────────────────────────────────────

@dataclass(frozen=True)
class AmountParts:
    """一条金额的解析结果。`currency` 为 None 表示文本里没写币种（不算冲突）。"""

    value: Decimal
    currency: Optional[str] = None


# 币种写法（多词优先；ASCII 用词边界匹配，中文直接包含）
_CURRENCY_ALIASES: tuple[tuple[str, str], ...] = (
    ("us dollars", "USD"), ("us dollar", "USD"),
    ("dollars", "USD"), ("dollar", "USD"), ("usd", "USD"), ("美元", "USD"), ("美金", "USD"),
    ("chinese yuan", "CNY"), ("rmb", "CNY"), ("yuan", "CNY"), ("cny", "CNY"), ("人民币", "CNY"),
    ("euros", "EUR"), ("euro", "EUR"), ("eur", "EUR"), ("欧元", "EUR"),
    ("pounds sterling", "GBP"), ("sterling", "GBP"), ("pounds", "GBP"),
    ("pound", "GBP"), ("gbp", "GBP"), ("英镑", "GBP"),
    ("yen", "JPY"), ("jpy", "JPY"), ("日元", "JPY"),
    ("aud", "AUD"), ("澳元", "AUD"),
    ("cad", "CAD"), ("加元", "CAD"),
    ("hkd", "HKD"), ("港元", "HKD"), ("港币", "HKD"),
)

_CN_CURRENCY_WORDS = ("人民币", "美元", "美金", "欧元", "英镑", "日元", "港元", "港币", "澳元", "加元")

_CN_DIGITS = {"零": 0, "〇": 0, "壹": 1, "贰": 2, "叁": 3, "肆": 4,
              "伍": 5, "陆": 6, "柒": 7, "捌": 8, "玖": 9}
_CN_UNITS = {"拾": 10, "佰": 100, "仟": 1000}
_CN_SECTIONS = {"万": 10 ** 4, "亿": 10 ** 8}
_CN_AMOUNT_CHARS = set("零〇壹贰叁肆伍陆柒捌玖拾佰仟万亿元圆角分整正")

_EN_ONES = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
_EN_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
            "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
_EN_SCALES = {"hundred": 100, "thousand": 1000, "million": 10 ** 6}
_EN_NOISE = {
    "say", "only", "and", "cent", "cents", "point", "the", "amount", "total",
    "value", "equals", "equal", "exactly", "in", "of",
}

_NUM_RE = re.compile(r"^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$")


def _currency_of(text: str) -> Optional[str]:
    for alias, code in _CURRENCY_ALIASES:
        if alias.isascii():
            if re.search(rf"\b{re.escape(alias)}\b", text):
                return code
        elif alias in text:
            return code
    return None


def _cn_int(text: str) -> Optional[int]:
    """中文大写整数部分；遇到无法确定的写法返回 None（宁可报冲突，也不算错）。"""
    if "亿" in text and "万" in text:
        # 亿+万 复合写法（>1 亿）不在本工位口径内：给 None 退化为文本比较，
        # 而不是返回一个可能错一位的数字。
        return None
    total = 0
    section = 0
    number = 0
    seen = False
    for char in text:
        if char in _CN_DIGITS:
            number = _CN_DIGITS[char]
            seen = True
        elif char in _CN_UNITS:
            section += (number or 1) * _CN_UNITS[char]
            number = 0
            seen = True
        elif char in _CN_SECTIONS:
            section += number
            number = 0
            total = (total + section) * _CN_SECTIONS[char]
            section = 0
            seen = True
        elif char in (" ", "整", "正"):
            continue
        else:
            return None
    if not seen and text.strip():
        return None
    return total + section + number


def _cn_fraction(text: str) -> Optional[Decimal]:
    """中文大写小数部分：`肆角玖分` → 0.49。空/`整`/`正` → 0。"""
    text = text.replace(" ", "")
    if not text or text in ("整", "正"):
        return Decimal("0")
    tenths = Decimal("0")
    hundredths = Decimal("0")
    matched = False
    for char, scale in (("角", Decimal("0.1")), ("分", Decimal("0.01"))):
        pos = text.find(char)
        if pos < 0:
            continue
        digit = text[pos - 1] if pos > 0 else ""
        if digit not in _CN_DIGITS:
            return None
        value = Decimal(_CN_DIGITS[digit]) * scale
        if char == "角":
            tenths = value
        else:
            hundredths = value
        matched = True
    if not matched:
        return None
    return tenths + hundredths


def _parse_cn_amount(text: str) -> Optional[Decimal]:
    if not any(char in _CN_AMOUNT_CHARS for char in text):
        return None
    body = text
    for word in _CN_CURRENCY_WORDS:
        body = body.replace(word, " ")
    integer_part, fraction_part = "", ""
    has_yuan = False
    for marker in ("元", "圆"):
        if marker in body:
            integer_part, _, fraction_part = body.partition(marker)
            has_yuan = True
            break
    if not has_yuan:
        # 没有"元"时也可能只有角分（`肆角玖分`）；连角分都没有就不是金额写法。
        if "角" not in body and "分" not in body:
            return None
        fraction_part = body
    amount = _cn_int(integer_part)
    if amount is None:
        return None
    fraction = _cn_fraction(fraction_part)
    if fraction is None:
        return None
    return Decimal(amount) + fraction


def _en_int(words: list[str]) -> Optional[int]:
    total = 0
    current = 0
    seen = False
    for word in words:
        if word in _EN_ONES:
            current += _EN_ONES[word]
            seen = True
        elif word in _EN_TENS:
            current += _EN_TENS[word]
            seen = True
        elif word == "hundred":
            current = (current or 1) * 100
            seen = True
        elif word in ("thousand", "million"):
            total += (current or 1) * _EN_SCALES[word]
            current = 0
            seen = True
        elif word in _EN_NOISE:
            continue
        else:
            return None
    if not seen:
        return None
    return total + current


def _parse_en_amount(text: str) -> Optional[Decimal]:
    """英文大写金额：`SAY US DOLLARS TWO THOUSAND ... AND CENTS FORTY NINE ONLY`。"""
    body = text
    for alias, _code in _CURRENCY_ALIASES:
        if alias.isascii():
            body = re.sub(rf"\b{re.escape(alias)}\b", " ", body)
        else:
            body = body.replace(alias, " ")
    words = [w for w in re.split(r"[\s\-]+", body) if w]
    if not any(w in _EN_ONES or w in _EN_TENS or w in _EN_SCALES for w in words):
        return None
    split_at = None
    for i, word in enumerate(words):
        if word in ("cent", "cents"):
            split_at = i
            break
    integer_words = words if split_at is None else words[:split_at]
    cents_words = [] if split_at is None else words[split_at + 1:]
    # 紧跟 cents 之前的 "and" 属于连接词，交给 _en_int 忽略
    integer = _en_int(integer_words)
    if integer is None:
        return None
    cents = _en_int(cents_words) if cents_words else 0
    if cents is None or cents < 0 or cents > 99:
        return None
    return Decimal(integer) + Decimal(cents) / Decimal(100)


def _parse_numeric_amount(text: str) -> Optional[Decimal]:
    body = text
    for alias, _code in _CURRENCY_ALIASES:
        if alias.isascii():
            body = re.sub(rf"\b{re.escape(alias)}\b", " ", body)
        else:
            body = body.replace(alias, " ")
    body = re.sub(r"\b(say|only|amount|total|value|equals?|exactly)\b", " ", body)
    body = _WHITESPACE.sub(" ", body).strip()
    if not body or not _NUM_RE.match(body):
        return None
    try:
        return Decimal(body.replace(",", ""))
    except InvalidOperation:  # pragma: no cover - 正则已挡住
        return None


def amount_parts(value: Any) -> Optional[AmountParts]:
    """金额解析（数字 / 英文大写 / 中文大写）；解析不出返回 None（不猜、不补零）。

    返回 `AmountParts(value, currency)`；`currency` 缺失时为 None，
    比较时"一侧没写币种"不算冲突（币种本身是独立事实，由 `currency` 键负责）。
    """
    text = normalize_text(value)
    if not text:
        return None
    currency = _currency_of(text)
    for parser in (_parse_cn_amount, _parse_en_amount, _parse_numeric_amount):
        parsed = parser(text)
        if parsed is not None:
            return AmountParts(value=parsed, currency=currency)
    return None


# ─── 七、日期结构化归一 ────────────────────────────────────────────────────

_MONTHS = {
    "january": 1, "jan": 1,
    "february": 2, "feb": 2,
    "march": 3, "mar": 3,
    "april": 4, "apr": 4,
    "may": 5,
    "june": 6, "jun": 6,
    "july": 7, "jul": 7,
    "august": 8, "aug": 8,
    "september": 9, "sep": 9, "sept": 9,
    "october": 10, "oct": 10,
    "november": 11, "nov": 11,
    "december": 12, "dec": 12,
}

_DATE_ISO_RE = re.compile(r"^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$")
_DATE_ISO_TIME_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})[t ]")
_DATE_CN_RE = re.compile(r"^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?$")
_DATE_DMY_RE = re.compile(r"^(\d{1,2})[-/ ]([a-z]+)\.?[-/ ,]*(\d{4})$")
_DATE_MDY_RE = re.compile(r"^([a-z]+)\.?[-/ ](\d{1,2})[-/ ,]*(\d{4})$")


def date_parts(value: Any) -> Optional[date]:
    """日期解析：ISO / 年月日 / `12 Oct 2026` / `October 12, 2026`。

    统一成 `datetime.date`；解析不出返回 None（例如 `2026-10` 这种不完整写法）。
    """
    text = normalize_text(value)
    if not text:
        return None

    match = _DATE_ISO_TIME_RE.match(text) or _DATE_ISO_RE.match(text)
    if match is not None:
        return _safe_date(int(match.group(1)), int(match.group(2)), int(match.group(3)))

    match = _DATE_CN_RE.match(text)
    if match is not None:
        return _safe_date(int(match.group(1)), int(match.group(2)), int(match.group(3)))

    match = _DATE_DMY_RE.match(text)
    if match is not None:
        month = _MONTHS.get(match.group(2))
        if month is not None:
            return _safe_date(int(match.group(3)), month, int(match.group(1)))

    match = _DATE_MDY_RE.match(text)
    if match is not None:
        month = _MONTHS.get(match.group(1))
        if month is not None:
            return _safe_date(int(match.group(3)), month, int(match.group(2)))
    return None


def _safe_date(year: int, month: int, day: int) -> Optional[date]:
    try:
        return date(year, month, day)
    except ValueError:
        return None


# ─── 八、统一入口 ──────────────────────────────────────────────────────────

def equivalent_text(a: Any, b: Any, extra: Optional[Mapping[str, Any]] = None) -> bool:
    """两条文本是否语义等价（**白名单内**才算）。

    判定顺序（先便宜后贵，任一命中即等价）：
    1. 归一后完全相同（含两侧都空）；
    2. 整串命中词表且规范名相同；
    3. 两侧都是付款条款整句 → 结构签名相同（比例 + 时点规范名 + 残余文字）；
    4. 两侧都能解析成 Incoterms → 代码/版本/地点逐段比较；
    5. 两侧都能解析成金额 → 币种+数值比较（千分位、大小写差异在这里收敛）；
    6. 两侧都能解析成日期 → 日期比较。
    其余一律 False（由调用方报冲突，绝不静默）。
    """
    left, right = normalize_text(a), normalize_text(b)
    if left == right:
        return True
    if not left or not right:
        return False

    left_phrase = canonical_phrase(left, extra)
    right_phrase = canonical_phrase(right, extra)
    if left_phrase is not None and right_phrase is not None:
        if left_phrase == right_phrase:
            return True
        # 两个都在词表里但分属不同分组 ⇒ 明确不等价（不要再去试金额/日期）
        return False

    # 付款条款整句：只放过"时点措辞"这一处差异（比例、角色词、其余文字必须一致）
    left_clause = payment_clause_signature(left, extra)
    right_clause = payment_clause_signature(right, extra)
    if left_clause is not None and right_clause is not None:
        return left_clause == right_clause

    if incoterm_equivalent(left, right):
        return True

    left_amount, right_amount = amount_parts(left), amount_parts(right)
    if left_amount is not None and right_amount is not None:
        if left_amount.currency and right_amount.currency:
            if left_amount.currency != right_amount.currency:
                return False
        return left_amount.value == right_amount.value

    left_date, right_date = date_parts(left), date_parts(right)
    if left_date is not None and right_date is not None:
        return left_date == right_date

    return False
