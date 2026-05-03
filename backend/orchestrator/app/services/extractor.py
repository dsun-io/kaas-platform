"""Kaas v2 · 参数提取器 (§5 T5)

从自然语言/结构化输入中提取产品规格参数。
使用 LLM function_call (via fallback 链) + 正则兜底。
"""
import re
from app.services.llm_client import llm_with_fallback

_EXTRACT_SCHEMA = {
    "name": "extract_product_spec",
    "description": "从用户输入中提取产品规格参数",
    "parameters": {
        "type": "object",
        "properties": {
            "mesh_size": {
                "type": "string",
                "description": "网孔尺寸，如 50x50",
            },
            "wire_diameter": {
                "type": "number",
                "description": "丝径 mm，如 2.5",
            },
            "width": {
                "type": "number",
                "description": "宽度 m",
            },
            "height": {
                "type": "number",
                "description": "高度 m",
            },
            "quantity": {
                "type": "integer",
                "description": "数量",
            },
        },
    },
}


async def extract_product_spec(
    prompt: str,
    product_category: str,
) -> dict:
    """从用户输入提取产品规格参数。

    优先使用 LLM function_call（带 fallback 链），失败时正则兜底。
    """
    result = await llm_with_fallback(
        prompt=prompt,
        function_name="extract_product_spec",
        function_schema=_EXTRACT_SCHEMA,
        context={"product_category": product_category},
    )

    # 正则兜底：提取网孔和丝径（LLM 全挂时保证业务不中断）
    if not result:
        result = _regex_fallback(prompt)

    return result


def _regex_fallback(prompt: str) -> dict:
    """正则兜底提取常见规格字段。"""
    result = {}
    mesh_match = re.search(r"(\d{2,3})\s*[xX×]\s*(\d{2,3})", prompt)
    if mesh_match:
        result["mesh_size"] = f"{mesh_match.group(1)}x{mesh_match.group(2)}"

    wire_match = re.search(
        r"(?:丝径|线径|wire|直径)[：:\s]*(\d+(?:\.\d+)?)", prompt, re.IGNORECASE
    )
    if wire_match:
        result["wire_diameter"] = float(wire_match.group(1))

    qty_match = re.search(r"(\d+)\s*(?:个|件|只|平方米|m²|米|m)", prompt)
    if qty_match:
        result["quantity"] = int(qty_match.group(1))

    return result
