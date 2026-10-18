"""平台默认的出口费用结构（贸易术语阶梯）。

为什么「结构」与「金额」要分开
------------------------------
出口环节会发生的费用项是**固定的**：

    厂→港的内陆运费 → 港杂费 → 报关费 → 海运费 → 保险费
    → 目的港费用及送货到门 → 进口关税及税费

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
    FOB  = EXW + 国内费用（本地费用）
    CFR  = FOB + 海运费
    CIF  = CFR + 保险费（按 CIF 加成投保）
    DAP  = CIF + 目的港费用及送货到门（不含进口关税与增值税）
    DDP  = DAP + 进口关税及税费（完税到门）

DAP / DDP 是「目的地交货」的两档：DAP 只把货运到客户门口，进口环节的
关税与增值税仍由买方承担；DDP 由卖方完税，所以比 DAP 多一项进口税费。
两者都用 `per_shipment`（整批金额，引擎按件数摊到单卷），
不需要新的计价方式 —— 计价方式只区分「怎么摊」，不区分「谁承担」。

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
    # 用户 2026-10-18 口径：默认按 EXW 报价；选其它条款时界面再展开对应费用项。
    "quote_as": "EXW",
    "weight_field": "weight_per_piece_kg",
    "items": {
        # 2026-10-18：国内三项（内陆运费/港杂费/报关费）合并为一项。
        # 原因（用户）：各货代名称不统一，且除这三项还有别的国内环节费用；
        # 拆成固定三项反而逼业务"对号入座"，合并成"国内费用（本地费用）"更贴合实际。
        "domestic_charges": {
            "name": "国内费用（本地费用）",
            "name_en": "Domestic charges",
            "mode": "per_shipment",
            "unit_hint": "元 / 整批",
            "note": "含内陆运费、港杂费、报关费等所有国内环节费用；按货代实际报价整批填写。",
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
        "destination_charges": {
            "name": "目的港费用及送货到门",
            "name_en": "Destination charges & delivery to door",
            "mode": "per_shipment",
            "unit_hint": "元 / 整批",
            "note": (
                "含目的港操作费、清关服务费与送货到门运费；"
                "不含进口关税与增值税（DAP 口径）。"
            ),
            "value": None,
        },
        "import_taxes": {
            "name": "进口关税及税费",
            "name_en": "Import duties & taxes",
            "mode": "per_shipment",
            "unit_hint": "元 / 整批",
            "note": (
                "DDP 口径：按目的国实际关税 / 增值税填写"
                "（可让货代或清关行按 HS 编码与申报价值试算）。"
            ),
            "value": None,
        },
    },
    "ladder": [
        {"code": "EXW", "label": "出厂价", "label_en": "Ex Works", "items": []},
        {
            "code": "FOB",
            "label": "离岸价（装运港船上交货）",
            "label_en": "Free On Board",
            # 只列本档新增：国内费用（合并了原内陆运费/港杂费/报关费）
            "items": ["domestic_charges"],
        },
        {
            "code": "CFR",
            "label": "成本加运费",
            "label_en": "Cost and Freight",
            # 只列本档新增：主运费
            "items": ["ocean_freight"],
        },
        {
            "code": "CIF",
            "label": "到岸价（含运费与保险）",
            "label_en": "Cost, Insurance and Freight",
            # 只列本档新增：保险（按 CIF 加成，故必须在 CFR 之后）
            "items": ["insurance"],
        },
        {
            "code": "DAP",
            "label": "到门价（目的地交货）",
            "label_en": "Delivered at Place",
            # 只列本档新增：目的港费用及送货到门（进口税费仍由买方承担）
            "items": ["destination_charges"],
        },
        {
            "code": "DDP",
            "label": "完税到门价（含进口税费）",
            "label_en": "Delivered Duty Paid",
            # 只列本档新增：进口关税及税费（故必须接在 DAP 之后）
            "items": ["import_taxes"],
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
