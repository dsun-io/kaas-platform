"""Kaas v2 · INT-R3 报价话术渲染器 (§5 T7)

根据报价结果字典生成客服可复制的中文话术脚本。
纯模板渲染，零 LLM 调用（铁律3）。
"""
from app.domain.category_normalizer import normalize_category, category_label


def render_quote_script(quote_result: dict) -> str:
    """生成中文报价话术（可复制文本）。

    Args:
        quote_result: 报价结果字典，包含:
            - status (str)
            - product_category (str)
            - spec_summary (str)
            - quantity (int)
            - weight_kg (float | None)
            - tiers (list[dict]) — 三档报价
            - accessory_lines (list[dict]) — 配件行
            - freight (dict | None)
            - totals (dict)
            - notes (list[str])

    Returns:
        中文话术字符串，可直接复制用于客服回复。
    """
    status = quote_result.get("status", "")

    if status != "matched":
        return _render_error_script(quote_result)

    lines = []
    spec_summary = quote_result.get("spec_summary", "")
    quantity = quote_result.get("quantity", 1)
    weight_kg = quote_result.get("weight_kg")
    product_category = quote_result.get("product_category", "")
    unit = _unit_for_category(product_category)

    # 抬头
    header_name = category_label(product_category)
    lines.append(f"【{header_name}报价单】")
    lines.append("")

    # 产品信息
    lines.append(f"产品: {spec_summary}")
    lines.append(f"数量: {quantity} {unit}")
    if weight_kg and normalize_category(product_category) != "post":
        lines.append(f"单{unit}重量: {weight_kg} kg")
        lines.append(f"总重量: {round(weight_kg * quantity, 1)} kg")
    lines.append("")

    # 三档报价
    tier_display = {"低": "逼单方案", "标准": "让利方案", "高": "优选方案"}
    tiers = quote_result.get("tiers", [])
    lines.append(f"报价梯度（元/{unit}）:")
    for t in tiers:
        label = tier_display.get(t.get("label", ""), t.get("label", ""))
        unit_price = t.get("unit_price", 0)
        total = t.get("total", 0)
        margin_rate = t.get("margin_rate")
        margin_str = f"（利润率 {((margin_rate - 1) * 100):.0f}%）" if margin_rate else ""
        lines.append(f"  {label}{margin_str}: {unit_price} 元/{unit}，合计 {total} 元")
    lines.append("")

    # 立柱
    accessories = quote_result.get("accessory_lines", [])
    if accessories:
        lines.append("立柱:")
        for acc in accessories:
            acc_total = acc.get("total", 0) or 0
            lines.append(
                f"  {acc.get('spec_summary', '')} "
                f"x {acc.get('quantity', 0)}{acc.get('unit', '个')} "
                f"= {acc_total} 元"
            )
        lines.append("")

    # 运费
    freight = quote_result.get("freight")
    if freight and freight.get("chosen"):
        chosen = freight["chosen"]
        lines.append(
            f"运费 ({freight.get('province', '')}): "
            f"{chosen['carrier']} {chosen['amount']} 元"
        )
        lines.append("")

    # 三档合计
    totals = quote_result.get("totals", {})
    lines.append("合计:")
    lines.append(f"  经济方案: {totals.get('low', 0)} 元")
    lines.append(f"  标准方案: {totals.get('standard', 0)} 元")
    lines.append(f"  优选方案: {totals.get('high', 0)} 元")
    lines.append("")

    # Disclaimer
    lines.append("---")
    lines.append("以上报价为系统自动生成，仅供客户参考，实际成交价以合同为准。")
    lines.append("如需调整数量、规格或配送地址，请与您的专属客服联系。")

    return "\n".join(lines)


def _render_error_script(quote_result: dict) -> str:
    """生成错误/异常状态的话术。"""
    status = quote_result.get("status", "unknown")
    notes = quote_result.get("notes", [])
    spec_summary = (
        quote_result.get("spec_summary", "")
        or quote_result.get("product_category", "")
    )

    header = f"【牛栏网报价 - {_status_label(status)}】"

    lines = [header, ""]
    if spec_summary:
        lines.append(f"产品: {spec_summary}")
        lines.append("")

    if notes:
        lines.append("说明:")
        for note in notes:
            lines.append(f"  - {note}")
        lines.append("")

    lines.append("---")
    lines.append("请人工确认，或尝试调整规格参数后重新报价。")

    return "\n".join(lines)


def _status_label(status: str) -> str:
    """将状态码转为中文标签。"""
    labels = {
        "no_match": "规格未匹配",
        "too_many": "规格匹配过多",
        "cost_pending": "价格待录入",
        "pricing_profile_missing": "定价策略未配置",
        "freight_missing": "运费未配置",
        "unsupported_category": "暂不支持品类",
    }
    return labels.get(status, f"未知状态({status})")


def _unit_for_category(product_category: str) -> str:
    cat = normalize_category(product_category)
    return {"niulanwang": "卷", "gouhuawang": "卷", "post": "根", "gabion": "个"}.get(cat, "个")
