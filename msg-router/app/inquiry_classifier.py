"""
咨询类型轻量分类器（基于关键词规则）
不引入 ML 依赖，仅使用标准库
"""

from __future__ import annotations

# 分类定义
INQUIRY_PRODUCT = "product_inquiry"      # 产品/规格/材质
INQUIRY_PRICING = "pricing"              # 价格/报价
INQUIRY_LOGISTICS = "logistics"          # 物流/发货
INQUIRY_AFTER_SALES = "after_sales"      # 售后/退换
INQUIRY_OTHER = "other"                  # 其他

# 关键词规则（优先级从高到低）
_KEYWORD_RULES = [
    # 售后类（优先级最高，避免与产品咨询混淆）
    (INQUIRY_AFTER_SALES, [
        "退", "换", "售后", "维修", "保修", "坏了", "质量问题",
        "不满意", "退货", "换货", "退款", "补偿", "赔偿",
        "投诉", "差评", "返修", "检修",
    ]),
    # 物流类
    (INQUIRY_LOGISTICS, [
        "物流", "快递", "发货", "运输", "配送", "到货",
        "签收", "揽收", "派送", "网点", "站点", "驿站",
        "什么时候发货", "多久到", "几天到", "运费", "邮费",
        "单号", "追踪", "查询物流", "查快递",
    ]),
    # 价格类
    (INQUIRY_PRICING, [
        "价格", "多少钱", "报价", "优惠", "折扣", "便宜",
        "贵", "涨价", "降价", "活动价", "秒杀", "满减",
        "团购", "批发价", "零售价", "成本", "预算", "费用",
        "怎么卖", "什么价", "怎么收费", "怎么算钱",
    ]),
    # 产品咨询类
    (INQUIRY_PRODUCT, [
        "产品", "规格", "型号", "尺寸", "大小", "材质",
        "材料", "质量", "性能", "功能", "参数", "配置",
        "颜色", "款式", "类型", "品牌", "产地", "库存",
        "有没有货", "现货", "定做", "定制", "加工",
        "怎么样", "好用吗", "耐用吗", "防水", "防火",
        "承重", "功率", "电压", "电流", "精度",
    ]),
]


def classify(message: str) -> str:
    """
    基于关键词规则对咨询消息进行分类

    Args:
        message: 买家消息文本

    Returns:
        分类标签: product_inquiry / pricing / logistics / after_sales / other
    """
    if not message:
        return INQUIRY_OTHER

    text = message.lower()

    # 按优先级匹配关键词
    for category, keywords in _KEYWORD_RULES:
        for kw in keywords:
            if kw in text:
                return category

    return INQUIRY_OTHER


def classify_with_confidence(message: str) -> tuple[str, float]:
    """
    分类并返回置信度（简单实现：匹配到关键词返回 0.8，否则 0.3）

    Returns:
        (category, confidence)
    """
    category = classify(message)
    confidence = 0.8 if category != INQUIRY_OTHER else 0.3
    return category, confidence
