"""单证渲染器 - 从模板和业务数据生成 HTML 单据"""
import json
from string import Template
from pathlib import Path
from typing import Any

TEMPLATES_DIR = Path(__file__).parent.parent / "templates" / "trade_docs"


def _load_templates_manifest() -> dict:
    with open(TEMPLATES_DIR / "templates.json", "r", encoding="utf-8-sig") as f:
        return json.load(f)


_TEMPLATES_MANIFEST = _load_templates_manifest()


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
        data: 业务数据字典,字段见 templates.json

    Returns:
        渲染后的 HTML 字符串

    Raises:
        ValueError: 单证类型不支持或模板文件不存在
    """
    spec = _TEMPLATES_MANIFEST.get(doc_type)
    if not spec:
        raise ValueError(f"不支持的单证类型: {doc_type}")

    template_path = TEMPLATES_DIR / spec["template_file"]
    if not template_path.exists():
        raise ValueError(f"模板文件不存在: {template_path}")

    with open(template_path, "r", encoding="utf-8-sig") as f:
        template_content = f.read()

    # 预处理:将嵌套对象和数组转换为 HTML 片段
    processed_data = _preprocess_data(data)

    template = Template(template_content)
    return template.safe_substitute(processed_data)


def _preprocess_data(data: dict[str, Any]) -> dict[str, str]:
    """预处理数据,将复杂类型转换为 HTML 字符串"""
    result = {}

    for key, value in data.items():
        if value is None:
            result[key] = ""
        elif isinstance(value, (list, tuple)):
            # 数组转换为表格行
            result[key] = _render_items_table(value) if value else ""
        elif isinstance(value, dict):
            # 对象转换为地址块
            result[key] = _render_address_block(value)
        elif isinstance(value, (int, float)):
            # 数字格式化(金额保留2位小数)
            if "amount" in key.lower() or "price" in key.lower() or "total" in key.lower():
                result[key] = f"{value:,.2f}"
            else:
                result[key] = str(value)
        else:
            result[key] = str(value)

    return result


def _render_address_block(obj: dict) -> str:
    """渲染地址块(公司/个人/银行信息)"""
    lines = []
    for field in ["name", "company", "address", "contact", "phone", "email", "fax", "account", "bank", "swift"]:
        if field in obj and obj[field]:
            lines.append(str(obj[field]))
    return "<br>".join(lines) if lines else ""


def _render_items_table(items: list[dict]) -> str:
    """渲染商品明细表格"""
    if not items:
        return ""

    # 收集所有列名
    columns = []
    for item in items:
        for key in item.keys():
            if key not in columns:
                columns.append(key)

    # 生成表头
    header_map = {
        "product_name": "品名",
        "description": "描述",
        "specification": "规格",
        "qty": "数量",
        "qty_unit": "单位",
        "unit_price": "单价",
        "line_amount": "金额",
        "gross_weight": "毛重(KGS)",
        "net_weight": "净重(KGS)",
        "volume": "体积(CBM)",
        "hs_code": "HS编码",
        "package": "包装",
    }
    headers = [f"<th>{header_map.get(col, col)}</th>" for col in columns]

    # 生成数据行
    rows = []
    for item in items:
        cells = []
        for col in columns:
            value = item.get(col, "")
            if isinstance(value, (int, float)):
                if "price" in col or "amount" in col:
                    value = f"{value:,.2f}"
                elif "weight" in col or "volume" in col:
                    value = f"{value:,.3f}" if value else ""
                else:
                    value = str(value)
            cells.append(f"<td>{value}</td>")
        rows.append("<tr>" + "".join(cells) + "</tr>")

    return (
        '<table class="items-table">'
        "<thead><tr>" + "".join(headers) + "</tr></thead>"
        "<tbody>" + "".join(rows) + "</tbody>"
        "</table>"
    )

