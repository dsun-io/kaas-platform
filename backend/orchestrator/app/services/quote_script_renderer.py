"""Kaas v2 · INT-R3 报价话术渲染器 (§5 T7)

根据报价结果字典生成客服可复制的中文话术脚本。
纯模板渲染，零 LLM 调用（铁律3）。
"""


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

    # 抬头
    lines.append("【牛栏网报价单】")
    lines.append("")

    # 产品信息
    lines.append(f"产品: {spec_summary}")
    lines.append(f"数量: {quantity} 卷")
    if weight_kg:
        lines.append(f"单卷重量: {weight_kg} kg")
        lines.append(f"总重量: {round(weight_kg * quantity, 1)} kg")
    lines.append("")

    # 三档报价
    tiers = quote_result.get("tiers", [])
    lines.append("报价梯度（元/卷）:")
    for t in tiers:
        label = t.get("label", "")
        unit_price = t.get("unit_price", 0)
        total = t.get("total", 0)
        lines.append(f"  {label}: {unit_price} 元/卷，合计 {total} 元")
    lines.append("")

    # 配件
    accessories = quote_result.get("accessory_lines", [])
    if accessories:
        lines.append("配件:")
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
    lines.append(f"  低配: {totals.get('low', 0)} 元")
    lines.append(f"  标准: {totals.get('standard', 0)} 元")
    lines.append(f"  高配: {totals.get('high', 0)} 元")
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
    lines.append("请联系管理员处理，或尝试调整规格参数后重新报价。")

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
