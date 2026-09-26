"""平台默认的出口费用结构（贸易术语阶梯）。

为什么「结构」与「金额」要分开
------------------------------
出口环节会发生的费用项是**固定的**：

    厂→港的内陆运费 → 港杂费 → 报关费 → 海运费 → 保险费

会变的只有**每单的金额**（海运费一周一变、报关费按票）。

所以：

  · **结构**（有哪些费用项、怎么计价、每个术语档位累加哪些）
      —— 平台声明一次，很稳定；
  · **金额** —— 报价时按当期实际填。

这样界面不必把「FOB 到底包含哪些费」这类业务知识写死在前端，
业务也不必每次从零拼一遍阶梯。金额天然带时效，结构不带 —— 混在一起
会导致每次调海运价都要把结构重填一遍。

口径（与本项目既有的工厂内部报价表一致）
----------------------------------------
    EXW  出厂价，不含任何出口附加费
    FOB  = EXW + 内陆运费 + 港杂费 + 报关费
    CFR  = FOB + 海运费
    CIF  = CFR + 保险费（按 CIF 加成投保）

阶梯是**逐档累加**的：每一档只列自己新增的费用项，引擎从 EXW 往上加。
所以既不能把内陆运费写进 CFR 档（会重复计一次），也不能把海运费写进 CIF 档
（CFR 已经含了）。

刻意**不把银行手续费放进阶梯**：既有报价表的口径是「银行手续费不计入产品单价」
（汇率取银行现汇买入价，价差已含在汇率里；让利时自留的退税额构成对冲池，
覆盖率高于实际银行费用）。若某个客户确实要单独计，报价页可以把它作为一个
费用项填进去 —— 但不该默认加到每一张报价上。
"""
from __future__ import annotations


# 每项费用都带 `value: None`：界面拿到模板后**原样回传、只把 value 填成数字**。
# 因此模板的形状就是请求里 `terms` 的形状，界面不需要做任何结构转换。
DEFAULT_EXPORT_TERMS: dict = {
    "base": "EXW",
    "quote_as": "CIF",
    "weight_field": "weight_per_piece_kg",
    "items": {
        "inland_freight": {
            "name": "内陆运费（厂 → 港）",
            "name_en": "Inland freight (factory → port)",
            "mode": "per_shipment",
            "unit_hint": "元 / 整批",
            "note": "整批一次，引擎会按订单件数摊到单卷。",
            "value": None,
        },
        "port_charges": {
            "name": "港杂费",
            "name_en": "Port charges",
            "mode": "per_shipment",
            "unit_hint": "元 / 整批",
            "note": "码头操作、装箱、堆存、单证等。",
            "value": None,
        },
        "customs_fee": {
            "name": "报关费",
            "name_en": "Customs clearance fee",
            "mode": "per_shipment",
            "unit_hint": "元 / 整批",
            "note": "报关行、查验、单证费等。",
            "value": None,
        },
        "ocean_freight": {
            "name": "海运费",
            "name_en": "Ocean freight",
            "mode": "per_weight_ton",
            "unit_hint": "元 / 吨",
            "note": "按计费吨填。若船公司按整箱报，把箱费折成吨单价即可。",
            "value": None,
        },
        "insurance": {
            "name": "保险费",
            "name_en": "Insurance",
            "mode": "insurance_of_cif",
            "unit_hint": "费率（0.003 = 3‰）",
            "note": "按 CIF 加成投保：保险费 = CIF × 投保加成(110%) × 费率。",
            "value": None,
        },
    },
    "ladder": [
        {"code": "EXW", "label": "出厂价", "label_en": "EXW", "items": []},
        {
            "code": "FOB",
            "label": "离岸价（装运港船上交货）",
            "label_en": "FOB",
            # 只列本档新增：厂到港 + 出口报关环节
            "items": ["inland_freight", "port_charges", "customs_fee"],
        },
        {
            "code": "CFR",
            "label": "成本加运费",
            "label_en": "CFR",
            # 只列本档新增：主运费
            "items": ["ocean_freight"],
        },
        {
            "code": "CIF",
            "label": "到岸价（含运费与保险）",
            "label_en": "CIF",
            # 只列本档新增：保险（按 CIF 加成，故必须在 CFR 之后）
            "items": ["insurance"],
        },
    ],
}


def default_terms_template() -> dict:
    """给界面的模板：结构、口径与计价方式齐全，金额留空待填。

    返回的就是请求 `terms` 的形状 —— 界面原样回传即可，不做结构转换。
    """
    return {
        "base": DEFAULT_EXPORT_TERMS["base"],
        "quote_as": DEFAULT_EXPORT_TERMS["quote_as"],
        "weight_field": DEFAULT_EXPORT_TERMS["weight_field"],
        "items": {k: dict(v) for k, v in DEFAULT_EXPORT_TERMS["items"].items()},
        "ladder": [dict(r) for r in DEFAULT_EXPORT_TERMS["ladder"]],
    }
