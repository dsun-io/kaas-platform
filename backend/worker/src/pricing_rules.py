"""品类规范化与定价录入规则。

⚠️ 口径：方案 B 收敛后只有一个运行时（本 Worker），orchestrator 业务壳已删，本文件
即唯一实现，无需再与第二侧保持同步；改本文件即改唯一真源。
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Optional

# 中文 label → code 映射表（同 orchestrator）
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

_VALID_CODES = frozenset({
    "niulanwang", "gouhuawang", "post", "gabion",
    "fence", "barbed_wire", "steel_grating", "other",
    "chain_link",
})

_ALIAS_TO_CODE: dict[str, str] = {
    "chain_link": "gouhuawang",
}

_CODE_TO_STORED_FORMS: dict[str, list[str]] = {}
for _label, _code in _LABEL_TO_CODE.items():
    _CODE_TO_STORED_FORMS.setdefault(_code, [_code]).append(_label)

# cost_unit → cost_type 映射（同 orchestrator pricing_data._UNIT_TO_COST_TYPE）
UNIT_TO_COST_TYPE = {
    "元/kg": "cost_per_kg",
    "元/卷": "cost_per_roll",
    "元/捆": "cost_per_bundle",
    "元/平方米": "cost_per_sqm",
    "元/个": "fixed",
    "元/根": "fixed",
}

# 进入 spec_hash 的规格字段（同 orchestrator pricing_data._SPEC_FIELDS）
SPEC_FIELDS = [
    "product_category", "product_type", "wire_diameter",
    "height", "mesh_width", "mesh_spec", "roll_length",
]


def normalize_category(raw: str) -> str:
    """将任意 product_category 输入规范化为系统内部 code（同 orchestrator）。"""
    if not raw:
        return ""
    value = raw.strip()
    if value in _VALID_CODES:
        return _ALIAS_TO_CODE.get(value, value)
    if value in _LABEL_TO_CODE:
        return _LABEL_TO_CODE[value]
    lower = value.lower()
    if lower in _VALID_CODES:
        return _ALIAS_TO_CODE.get(lower, lower)
    return value


def expand_category_search(code: str) -> list[str]:
    """返回该 code 在库中所有可能的存储形式（兼容中文历史数据）。"""
    return _CODE_TO_STORED_FORMS.get(code, [code])


def build_spec_dict(body: dict) -> dict:
    """从请求体提取规格字段构建 spec_hash 输入字典。"""
    return {k: body.get(k) for k in SPEC_FIELDS if body.get(k) is not None}


def parse_date(value) -> Optional[datetime]:
    """解析日期字符串为 UTC datetime，None/空串返回 None。"""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    try:
        d = date.fromisoformat(str(value)[:10])
        return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def to_float(value):
    """数值列入库前转换：str/数字 → float；空/非法 → None。

    asyncpg 对数值列严格要求 float；spec_hash 仍用 body 原始值计算（同 orchestrator）。
    """
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
