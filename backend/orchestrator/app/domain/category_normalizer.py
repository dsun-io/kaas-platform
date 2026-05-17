"""Kaas v2 · 品类编码规范化

统一将外部输入的 product_category（可能是中文 label 或英文 code）
normalize 为系统内部稳定 code。

原则:
- 中文 label → code
- 英文 code → 透传（归化为标准形式）
- 未知品类 → 透传原值（由调用方校验）
"""

# 中文 label → code 映射表
_LABEL_TO_CODE: dict[str, str] = {
    "牛栏网": "niulanwang",
    "勾花网": "gouhuawang",
    "立柱": "post",
    "石笼网": "gabion",
    "围栏": "fence",
    "刺绳": "barbed_wire",
    "钢格板": "steel_grating",
    "其他": "other",
}

# 合法 code 集合（同时兼容 pricing_data _CATEGORIES）
_VALID_CODES = frozenset({
    "niulanwang", "gouhuawang", "post", "gabion",
    "fence", "barbed_wire", "steel_grating", "other",
    "chain_link",
})

# code 别名映射（历史遗留/别名 → 标准 code）
_ALIAS_TO_CODE: dict[str, str] = {
    "chain_link": "gouhuawang",
}

# code → 可能的 DB 中存储形式（兼容历史数据中的中文 category）
_CODE_TO_STORED_FORMS: dict[str, list[str]] = {}
for _label, _code in _LABEL_TO_CODE.items():
    _CODE_TO_STORED_FORMS.setdefault(_code, [_code]).append(_label)


def normalize_category(raw: str) -> str:
    """将任意 product_category 输入规范化为系统内部 code。

    Args:
        raw: 前端/API 传入的原始值（可能是中文 label 或英文 code）

    Returns:
        系统内部标准 code 字符串

    Examples:
        normalize_category("牛栏网") → "niulanwang"
        normalize_category("niulanwang") → "niulanwang"
        normalize_category("立柱") → "post"
    """
    if not raw:
        return ""

    value = raw.strip()

    # Step 1: 直接命中合法 code → 归化别名再返回
    if value in _VALID_CODES:
        return _ALIAS_TO_CODE.get(value, value)

    # Step 2: 中文 label → code
    if value in _LABEL_TO_CODE:
        return _LABEL_TO_CODE[value]

    # Step 3: 大小写容错
    lower = value.lower()
    if lower in _VALID_CODES:
        return _ALIAS_TO_CODE.get(lower, lower)

    # Step 4: 未知品类 → 透传原值
    return value


def expand_category_search(code: str) -> list[str]:
    """返回该 code 在 DB 中所有可能的存储形式。

    用于兼容历史数据：老数据可能存储为中文 label（如 "牛栏网"），
    新数据统一存储为 code（如 "niulanwang"）。
    查询时用 .in_(expand_category_search(code)) 即可同时匹配新旧数据。

    Args:
        code: 规范化后的品类 code

    Returns:
        [code, label1, label2, ...] 或仅 [code]（若无已知 label）
    """
    return _CODE_TO_STORED_FORMS.get(code, [code])


# code → label（用于 UI 展示）
_CODE_LABEL: dict[str, str] = {v: k for k, v in _LABEL_TO_CODE.items()}


def category_label(code: str) -> str:
    """返回品类的中文展示名称。"""
    return _CODE_LABEL.get(code, code)


def is_supported_category(category: str) -> bool:
    """检查品类是否受支持（用于报价引擎白名单校验）。"""
    code = normalize_category(category)
    return code in (
        "niulanwang",
        "gouhuawang",
        "post",
        "gabion",
        "fence",
        "barbed_wire",
        "steel_grating",
        "other",
    )
