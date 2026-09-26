"""单证渲染器 —— 由模板 + 业务数据生成 HTML 单据（英文印刷级）

设计要点
--------
1. 模板用 Python 标准库 string.Template（$var），**零第三方依赖**；
2. 共享样式 `_shared.css` 由本模块注入模板的 `$__style__`，
   9 类单证共用一份 CSS，样式不重复维护、系列单据视觉统一；
3. 缺失字段渲染为空字符串（`_RenderDict.__missing__`），单据上不会残留 `$placeholder`；
4. 所有业务值经 HTML 转义防注入，仅 `other` 单证的 `content` 字段按原始 HTML 透传；
5. 商品明细的列由**单据类型固定**（`_ITEM_COLUMNS`），不随数据键漂移 ——
   海关/银行审单要求版面稳定：商业发票不应冒出毛净重列（那属于装箱单）；
6. 自动派生并注入：金额英文大写、日期格式化、商品数量合计、卖方名称、页脚，
   模板可直接引用，无需调用方预先计算。
"""
import html
import json
import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from string import Template
from typing import Any

TEMPLATES_DIR = Path(__file__).parent.parent / "templates" / "trade_docs"
_SHARED_STYLE_PATH = TEMPLATES_DIR / "_shared.css"

# 共享样式注入占位符（模板中写 /*__SHARED_STYLE__*/）。
# 采用「渲染完成后字符串替换」而非模板变量：CSS 内容不经过 string.Template 解析，
# 即便将来在 CSS 里使用 $ 也不会被误当作占位符。
_STYLE_PLACEHOLDER = "/*__SHARED_STYLE__*/"

# 允许透传原始 HTML 的字段（其余值一律转义）
_RAW_HTML_FIELDS = {"content"}

# 数值型字段判定用的类型集合（DB 的 Numeric 列会取到 Decimal）
_NUMERIC_TYPES = (int, float, Decimal)


def _load_templates_manifest() -> dict:
    with open(TEMPLATES_DIR / "templates.json", "r", encoding="utf-8-sig") as f:
        return json.load(f)


_TEMPLATES_MANIFEST = _load_templates_manifest()


class _RenderDict(dict):
    """缺失键渲染为空串，避免单据上残留 $placeholder。"""

    def __missing__(self, key: str) -> str:
        return ""


# ── 对外接口 ────────────────────────────────────────────────────────────────

def get_available_templates() -> list[dict]:
    """返回所有可用模板列表"""
    return [
        {
            "doc_type": doc_type,
            "name_zh": spec["name_zh"],
            "name_en": spec["name_en"],
            "description": spec["description"],
        }
        for doc_type, spec in _TEMPLATES_MANIFEST.items()
    ]


def get_template_fields(doc_type: str) -> dict | None:
    """获取指定单证类型的字段定义"""
    spec = _TEMPLATES_MANIFEST.get(doc_type)
    return spec["fields"] if spec else None


def render_trade_doc(doc_type: str, data: dict[str, Any]) -> str:
    """渲染单证 HTML

    Args:
        doc_type: 单证类型(quotation/pi/contract/ci/pl/bl/co/insurance/other)
        data: 业务数据字典，字段见 templates.json

    Returns:
        渲染后的 HTML 字符串（自包含，含内联共享样式，可直接打印为 PDF）

    Raises:
        ValueError: 单证类型不支持或模板文件不存在
    """
    spec = _TEMPLATES_MANIFEST.get(doc_type)
    if not spec:
        raise ValueError(f"不支持的单证类型: {doc_type}")

    template_path = TEMPLATES_DIR / spec["template_file"]
    if not template_path.exists():
        raise ValueError(f"模板文件不存在: {template_path}")

    template_content = template_path.read_text(encoding="utf-8-sig")

    processed = _preprocess_data(doc_type, data)
    rendered = Template(template_content).substitute(_RenderDict(processed))
    # 共享样式最后注入：CSS 不经过模板引擎，避免其中出现 $ 时被误当作占位符
    return rendered.replace(_STYLE_PLACEHOLDER, _load_shared_style())


def _load_shared_style() -> str:
    """读取共享打印样式；文件缺失时退化为空（模板自身样式仍可用）"""
    if _SHARED_STYLE_PATH.exists():
        return _SHARED_STYLE_PATH.read_text(encoding="utf-8-sig")
    return ""


# ── 数据预处理 ──────────────────────────────────────────────────────────────

def _esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


# 可由行项自动汇总的合计字段：合计字段 → 行项候选键（取第一个命中的）
_AUTO_SUMS: dict[str, tuple[str, ...]] = {
    "total_qty": ("qty", "quantity"),
    "total_packages": ("package", "packages", "carton_no"),
    "total_gross_weight": ("gross_weight",),
    "total_net_weight": ("net_weight",),
    "total_volume": ("volume",),
}

# 取整展示的合计（其余合计保留 2 位小数）
_INT_TOTALS = {"total_qty", "total_packages"}


def _preprocess_data(doc_type: str, data: dict[str, Any]) -> dict[str, str]:
    """预处理数据：复杂类型转 HTML 片段，标量按语义格式化/转义"""
    # 汇总上下文：业务未显式提供合计时由行项汇总，供表格 TOTAL 行与汇总栏使用
    context: dict[str, Any] = dict(data)
    for field, item_keys in _AUTO_SUMS.items():
        if context.get(field) in (None, ""):
            summed = _sum_numeric(data.get("items"), item_keys)
            if summed is not None:
                context[field] = summed

    result: dict[str, str] = {}

    for key, value in data.items():
        if value is None or value == "":
            result[key] = ""
        elif isinstance(value, (list, tuple)):
            result[key] = _render_items_table(list(value), doc_type, context) if value else ""
        elif isinstance(value, dict):
            result[key] = _render_address_block(value)
        elif isinstance(value, _NUMERIC_TYPES):
            result[key] = _format_number(key, value)
        elif key in _RAW_HTML_FIELDS:
            result[key] = str(value)
        elif _is_date_key(key):
            result[key] = _format_date(value)
        else:
            result[key] = _esc(value)

    result.update(_derive_fields(doc_type, data, context, result))
    return result


def _derive_fields(doc_type: str, data: dict[str, Any], context: dict[str, Any],
                   result: dict[str, str]) -> dict[str, str]:
    """派生模板常用字段：金额大写、数量合计、卖方名、页脚"""
    derived: dict[str, str] = {}

    # 金额英文大写（报关 / 信用证审单必需）
    currency = str(data.get("currency") or "USD").strip().upper()
    for field, amount_key in (("total_amount_words", "total_amount"),
                              ("insured_amount_words", "insured_amount")):
        amount = data.get(amount_key)
        if amount not in (None, ""):
            derived[field] = _esc(amount_in_words(amount, currency))

    # 合计字段（数量/件数/毛净重/体积）：模板未自带时补上
    for field in _AUTO_SUMS:
        if not result.get(field) and context.get(field) not in (None, ""):
            raw = context[field]
            derived[field] = _format_qty(raw) if field in _INT_TOTALS else f"{float(raw):,.2f}"

    # 卖方名称（签章区提示语用）
    seller = data.get("seller") if isinstance(data.get("seller"), dict) else {}
    derived["seller_name"] = _esc(seller.get("company") or seller.get("name") or "")

    # 页脚：单据英文名 + 卖方名
    name_en = _TEMPLATES_MANIFEST.get(doc_type, {}).get("name_en", "")
    footer = data.get("footer_note")
    derived["footer_note"] = _esc(footer) if footer else _esc(name_en)

    return derived


# 不带 _date 后缀、但语义为日期的字段：同样格式化为 26-Sep-2026
_DATE_KEYS = {"date", "valid_until", "etd", "eta"}


def _is_date_key(key: str) -> bool:
    kl = key.lower()
    return kl.endswith("_date") or kl in _DATE_KEYS


def _format_number(key: str, value: Any) -> str:
    """按字段语义格式化数字：金额/重量/体积保留 2 位，数量取整"""
    kl = key.lower()
    if isinstance(value, Decimal):
        value = float(value)
    if any(h in kl for h in ("amount", "price", "insured")) or any(
        h in kl for h in ("weight", "volume")
    ):
        return f"{value:,.2f}"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


_MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _format_date(value: Any) -> str:
    """统一为国际单证常用写法 26-Sep-2026；非日期原样返回"""
    if isinstance(value, (datetime, date)):
        return f"{value.day:02d}-{_MONTH_ABBR[value.month - 1]}-{value.year}"
    text = str(value).strip()
    match = re.match(r"^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", text)
    if match:
        year, month, day = (int(g) for g in match.groups())
        if 1 <= month <= 12:
            return f"{day:02d}-{_MONTH_ABBR[month - 1]}-{year}"
    return _esc(text)


# ── 金额英文大写 ────────────────────────────────────────────────────────────

_CURRENCY_WORDS: dict[str, tuple[str, str]] = {
    "USD": ("US DOLLARS", "CENTS"),
    "CNY": ("CHINESE YUAN", "FEN"),
    "RMB": ("CHINESE YUAN", "FEN"),
    "EUR": ("EUROS", "CENTS"),
    "GBP": ("POUNDS STERLING", "PENCE"),
    "AUD": ("AUSTRALIAN DOLLARS", "CENTS"),
    "CAD": ("CANADIAN DOLLARS", "CENTS"),
    "NZD": ("NEW ZEALAND DOLLARS", "CENTS"),
    "HKD": ("HONG KONG DOLLARS", "CENTS"),
    "SGD": ("SINGAPORE DOLLARS", "CENTS"),
    "JPY": ("JAPANESE YEN", ""),
    "CHF": ("SWISS FRANCS", "CENTIMES"),
}

_ONES = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE",
         "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN",
         "SEVENTEEN", "EIGHTEEN", "NINETEEN"]
_TENS = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"]
_SCALES = ["", " THOUSAND", " MILLION", " BILLION"]


def _below_thousand(num: int) -> str:
    """0-999 转英文单词（百位后用 AND，符合金额大写的传统读法）"""
    parts: list[str] = []
    if num >= 100:
        parts.append(f"{_ONES[num // 100]} HUNDRED")
        num %= 100
        if num:
            parts.append("AND")
    if num >= 20:
        tens, ones = divmod(num, 10)
        parts.append(_TENS[tens] + (f"-{_ONES[ones]}" if ones else ""))
    elif num > 0:
        parts.append(_ONES[num])
    return " ".join(parts)


def _int_to_words(num: int) -> str:
    """非负整数转英文单词（按千分位分段）"""
    if num == 0:
        return "ZERO"
    groups: list[str] = []
    index = 0
    while num > 0:
        num, remainder = divmod(num, 1000)
        if remainder:
            groups.append(_below_thousand(remainder) + _SCALES[index])
        index += 1
    return " ".join(reversed(groups))


def amount_in_words(amount: Any, currency: str = "USD") -> str:
    """金额转英文大写，如 `SAY US DOLLARS TWENTY-SIX THOUSAND FOUR HUNDRED AND FIFTY ONLY`

    金额非法（None / 空 / 非数字）时返回空串，由模板渲染为空。
    """
    try:
        value = float(Decimal(str(amount)))
    except (InvalidOperation, TypeError, ValueError):
        return ""
    if value < 0:
        return ""

    unit_word, cent_word = _CURRENCY_WORDS.get(
        str(currency).strip().upper(), (str(currency).strip().upper(), "CENTS")
    )

    whole = int(value)
    cents = int(round((value - whole) * 100))
    if cents == 100:  # 四舍五入进位
        whole += 1
        cents = 0

    words = f"SAY {unit_word} {_int_to_words(whole)}"
    if cents and cent_word:
        words += f" AND {cent_word} {_int_to_words(cents)}"
    return words + " ONLY"


# ── 收发货人 / 银行信息区块 ─────────────────────────────────────────────────

def _render_address_block(obj: dict) -> str:
    """渲染地址块：公司名加粗，联系信息带标签，便于识别与审单"""
    lines: list[str] = []
    if obj.get("company"):
        lines.append(f"<strong>{_esc(obj['company'])}</strong>")
    if obj.get("name"):
        lines.append(_esc(obj["name"]))
    if obj.get("address"):
        lines.append(_esc(obj["address"]))
    if obj.get("contact"):
        lines.append(f"Attn: {_esc(obj['contact'])}")
    if obj.get("phone"):
        lines.append(f"Tel: {_esc(obj['phone'])}")
    if obj.get("fax"):
        lines.append(f"Fax: {_esc(obj['fax'])}")
    if obj.get("email"):
        lines.append(f"E-mail: {_esc(obj['email'])}")
    if obj.get("bank"):
        lines.append(_esc(obj["bank"]))
    if obj.get("account"):
        lines.append(f"A/C: {_esc(obj['account'])}")
    if obj.get("swift"):
        lines.append(f"SWIFT: {_esc(obj['swift'])}")
    return "<br>".join(lines)


# ── 商品明细表 ──────────────────────────────────────────────────────────────

# 各单据类型的**固定列**：(字段 key, 英文表头, 对齐方式)
# 版面稳定是审单要求：同一类单据的表头、列序不随数据波动。
_ITEM_COLUMNS: dict[str, list[tuple[str, str, str]]] = {
    "quotation": [
        ("no", "No.", "c"),
        ("product_name", "Description of Goods", "l"),
        ("specification", "Specification", "l"),
        ("qty", "Quantity", "r"),
        ("qty_unit", "Unit", "c"),
        ("unit_price", "Unit Price", "r"),
        ("line_amount", "Amount", "r"),
    ],
    "pi": [
        ("no", "No.", "c"),
        ("product_name", "Description of Goods", "l"),
        ("specification", "Specification", "l"),
        ("qty", "Quantity", "r"),
        ("qty_unit", "Unit", "c"),
        ("unit_price", "Unit Price", "r"),
        ("line_amount", "Amount", "r"),
    ],
    "contract": [
        ("no", "No.", "c"),
        ("product_name", "Description of Goods", "l"),
        ("specification", "Specification", "l"),
        ("qty", "Quantity", "r"),
        ("qty_unit", "Unit", "c"),
        ("unit_price", "Unit Price", "r"),
        ("line_amount", "Amount", "r"),
    ],
    # 商业发票：目的国海关普遍要求 HS Code
    "ci": [
        ("no", "No.", "c"),
        ("product_name", "Description of Goods", "l"),
        ("specification", "Specification", "l"),
        ("qty", "Quantity", "r"),
        ("qty_unit", "Unit", "c"),
        ("unit_price", "Unit Price", "r"),
        ("line_amount", "Amount", "r"),
        ("hs_code", "HS Code", "c"),
    ],
    # 装箱单：以包装与重量体积为核心
    "pl": [
        ("no", "No.", "c"),
        ("product_name", "Description of Goods", "l"),
        ("specification", "Specification", "l"),
        ("package", "Packages", "c"),
        ("qty", "Quantity", "r"),
        ("qty_unit", "Unit", "c"),
        ("gross_weight", "G.W. (KGS)", "r"),
        ("net_weight", "N.W. (KGS)", "r"),
        ("volume", "Meas. (CBM)", "r"),
    ],
    # 原产地证：以 HS Code 与重量为核心
    "co": [
        ("no", "No.", "c"),
        ("product_name", "Description of Goods", "l"),
        ("specification", "Specification", "l"),
        ("qty", "Quantity", "r"),
        ("qty_unit", "Unit", "c"),
        ("gross_weight", "G.W. (KGS)", "r"),
        ("net_weight", "N.W. (KGS)", "r"),
        ("hs_code", "HS Code", "c"),
    ],
    # 重量单：只关心数量与重量，不含包装细节
    "weight_list": [
        ("no", "No.", "c"),
        ("product_name", "Description of Goods", "l"),
        ("specification", "Specification", "l"),
        ("qty", "Quantity", "r"),
        ("qty_unit", "Unit", "c"),
        ("gross_weight", "G.W. (KGS)", "r"),
        ("net_weight", "N.W. (KGS)", "r"),
    ],
    # 装运通知：货物摘要 + 包装与毛重
    "shipping_advice": [
        ("no", "No.", "c"),
        ("product_name", "Description of Goods", "l"),
        ("specification", "Specification", "l"),
        ("qty", "Quantity", "r"),
        ("qty_unit", "Unit", "c"),
        ("package", "Packages", "c"),
        ("gross_weight", "G.W. (KGS)", "r"),
    ],
    # 质量/检验证明：以 HS Code 与规格为核心
    "quality_cert": [
        ("no", "No.", "c"),
        ("product_name", "Description of Goods", "l"),
        ("specification", "Specification", "l"),
        ("qty", "Quantity", "r"),
        ("qty_unit", "Unit", "c"),
        ("hs_code", "HS Code", "c"),
    ],
    # 报关信息：按申报要素排列（项号 / 商品编号 / 品名规格 / 数量 / 单价总价），
    # 重量等汇总项置于表格下方的汇总栏，避免表格列过多影响可读性
    "customs_declaration": [
        ("no", "Item No.", "c"),
        ("product_name", "Description of Goods", "l"),
        ("specification", "Specification", "l"),
        ("hs_code", "HS Code", "c"),
        ("qty", "Quantity", "r"),
        ("qty_unit", "Unit", "c"),
        ("unit_price", "Unit Price", "r"),
        ("line_amount", "Amount", "r"),
    ],
}

# 汇总行取值来源：列 key → 汇总数据 key
_TOTAL_SOURCE = {
    "qty": "total_qty",
    "package": "total_packages",
    "line_amount": "total_amount",
}


def _render_items_table(items: list[dict], doc_type: str | None = None,
                        context: dict | None = None) -> str:
    """渲染商品明细表：优先按单据类型固定列，无定义时回退为数据驱动列"""
    if not items:
        return ""
    columns = _ITEM_COLUMNS.get(doc_type or "")
    if columns:
        return _render_fixed_table(items, columns, context or {})
    return _render_dynamic_table(items)


def _render_fixed_table(items: list[dict], columns: list[tuple[str, str, str]],
                        context: dict) -> str:
    head = "".join(f"<th>{label}</th>" for _, label, _ in columns)

    rows: list[str] = []
    for index, item in enumerate(items, start=1):
        cells = []
        for key, _label, align in columns:
            # 序号列由行号生成（不受数字格式化影响），其余取行项字段，缺列留空以固定版面
            rendered = str(index) if key == "no" else _render_cell(key, item.get(key, ""))
            cells.append(f'<td class="{align}">{rendered}</td>')
        rows.append("<tr>" + "".join(cells) + "</tr>")

    total_row = _render_total_row(columns, context)
    if total_row:
        rows.append(total_row)

    return (
        '<table class="items">'
        f"<thead><tr>{head}</tr></thead>"
        f"<tbody>{''.join(rows)}</tbody>"
        "</table>"
    )


def _render_cell(key: str, value: Any) -> str:
    """单元格取值：数量取整、金额千分位两位小数、文本转义"""
    if value is None or value == "":
        return ""
    if isinstance(value, _NUMERIC_TYPES):
        if isinstance(value, Decimal):
            value = float(value)
        kl = key.lower()
        if "qty" in kl or kl in {"package", "packages"}:
            return _format_qty(value)
        return f"{value:,.2f}"
    return _esc(value)


def _format_qty(value: Any) -> str:
    try:
        num = float(Decimal(str(value)))
    except (InvalidOperation, TypeError, ValueError):
        return _esc(value)
    return str(int(num)) if num.is_integer() else f"{num:g}"


def _sum_numeric(items: Any, keys: tuple[str, ...]) -> float | None:
    """汇总行项中的指定数值字段（按 keys 顺序取第一个命中的键）；无命中返回 None"""
    if not isinstance(items, list):
        return None
    total = 0.0
    found = False
    for item in items:
        if not isinstance(item, dict):
            continue
        for key in keys:
            raw = item.get(key)
            if isinstance(raw, _NUMERIC_TYPES) and not isinstance(raw, bool):
                try:
                    total += float(raw)
                except (TypeError, ValueError):
                    continue
                found = True
                break
    return total if found else None


def _render_total_row(columns: list[tuple[str, str, str]], context: dict) -> str:
    """生成表格内 TOTAL 汇总行（数量合计 + 金额合计），无可用汇总值时省略"""
    summary: dict[int, str] = {}
    currency = str(context.get("currency") or "").strip()

    for index, (key, _label, _align) in enumerate(columns):
        source_key = _TOTAL_SOURCE.get(key)
        if not source_key:
            continue
        raw = context.get(source_key)
        if raw in (None, ""):
            continue
        if source_key == "total_amount":
            amount = _render_cell("line_amount", raw)
            summary[index] = f"{currency} {amount}".strip() if amount else ""
        else:
            summary[index] = _format_qty(raw)

    if not summary:
        return ""

    first = min(summary)
    cells = [f'<td class="l" colspan="{first}">TOTAL</td>']
    for index in range(first, len(columns)):
        if index in summary:
            cells.append(f'<td class="{columns[index][2]}">{summary[index]}</td>')
        else:
            cells.append("<td></td>")
    return '<tr class="total">' + "".join(cells) + "</tr>"


_ITEM_HEADER_MAP = {
    "no": "No.",
    "product_name": "Description of Goods",
    "description": "Description of Goods",
    "specification": "Specification",
    "qty": "Quantity",
    "quantity": "Quantity",
    "qty_unit": "Unit",
    "unit_price": "Unit Price",
    "line_amount": "Amount",
    "gross_weight": "G.W. (KGS)",
    "net_weight": "N.W. (KGS)",
    "volume": "Meas. (CBM)",
    "hs_code": "HS Code",
    "package": "Packages",
    "carton_no": "Carton No.",
}


def _render_dynamic_table(items: list[dict]) -> str:
    """回退实现：列由数据键决定（供未定义固定列的单据类型使用）"""
    columns: list[str] = []
    for item in items:
        for key in item.keys():
            if key not in columns:
                columns.append(key)

    head = "".join(f"<th>{_ITEM_HEADER_MAP.get(col, col)}</th>" for col in columns)

    rows: list[str] = []
    for item in items:
        cells = "".join(
            f'<td class="l">{_render_cell(col, item.get(col, ""))}</td>' for col in columns
        )
        rows.append(f"<tr>{cells}</tr>")

    return (
        '<table class="items">'
        f"<thead><tr>{head}</tr></thead>"
        f"<tbody>{''.join(rows)}</tbody>"
        "</table>"
    )
