"""Kaas v2 · 话术模板 (§5 T7)

根据报价状态生成自然语言回复。
matched 路径：零 LLM 纯模板（铁律3）
estimated 路径：LLM 话术 + 降级模板
spec_not_supported：纯模板
"""
from app.services.llm_client import get_llm_client


async def generate_quote_response(
    status: str,
    unit_price: float | None,
    unit: str,
    currency: str,
    product_category: str,
    confidence: str,
    notes: str | None = None,
    spec_summary: str = "",
    price_range: str = "",
    kb_chunks: list[dict] | None = None,
) -> str:
    """根据报价结果生成客户响应文本。"""
    if status == "matched":
        return render_script_template_only({
            "status": "matched",
            "unit_price": f"{unit_price}",
            "unit": unit,
            "currency": currency,
            "product_category": product_category,
        })

    if status == "estimated":
        template_ctx = {
            "status": "estimated",
            "product_category": product_category,
            "spec_summary": spec_summary,
            "price_range": price_range or f"{unit_price} {currency}/{unit}",
            "unit_price": f"{unit_price}",
            "unit": unit,
            "currency": currency,
        }
        try:
            llm = get_llm_client()
            return await llm.generate_script(template_ctx)
        except Exception:
            return render_script_template_only(template_ctx)

    # spec_not_supported
    return render_script_template_only({
        "status": "spec_not_supported",
        "product_category": product_category,
    })


def render_script_template_only(template_context: dict) -> str:
    """TemplateOnlyClient 调用的纯模板渲染。
    LLM 全挂时用，保证业务不中断（铁律3·零 LLM 降级）。
    """
    status = template_context.get("status", "estimated")
    product_category = template_context.get("product_category", "")
    unit_price = template_context.get("unit_price", "N/A")
    unit = template_context.get("unit", "")
    currency = template_context.get("currency", "")
    price_range = template_context.get("price_range", "N/A")

    if status == "matched":
        return (
            f"您好，{product_category}当前报价 "
            f"{unit_price} {unit}。"
        )
    elif status == "estimated":
        return (
            f"您好，{product_category}参考价区间 "
            f"{price_range}，仅供参考。"
            f"\n⚠️ 此为估算价，非成交价，需人工确认。"
        )
    else:
        return "抱歉，该规格暂不支持，请联系客服了解可选规格。"
