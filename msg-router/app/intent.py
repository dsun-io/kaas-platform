"""根据买家原文做轻量意图归类（关键词），供路由层注入 FastGPT，非严格分类模型。"""

from __future__ import annotations

from dataclasses import dataclass

# (展示标签, 关键词) — 一条消息可命中多类
_INTENT_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("询价议价", ("多少钱", "什么价", "价格", "报价", "怎么卖", "价位", "优惠", "便宜", "折扣", "批发")),
    ("规格参数", ("规格", "型号", "尺寸", "材质", "网孔", "丝径", "高度", "宽度", "长度", "厚度", "承重")),
    ("物流发货", ("发货", "快递", "物流", "几天到", "多久到", "邮费", "运费", "包邮", "自提")),
    ("库存交期", ("有货", "库存", "现货", "定做", "定制", "工期", "几天做好", "多久能发")),
    ("安装使用", ("怎么装", "安装", "用法", "使用", "教程", "视频")),
    ("售后退换", ("退", "换货", "退款", "维权", "差评", "坏了", "质量", "不合格")),
    ("对比推荐", ("推荐", "哪个好", "区别", "对比", "选哪种")),
    ("打招呼", ("你好", "您好", "在吗", "在么", "在不在", "哈喽", "hi", "hello", "亲", "老板")),
)


@dataclass(frozen=True)
class BuyerIntent:
    """买家意图摘要（中文标签，给模型作参考）。"""

    labels: tuple[str, ...]
    summary_zh: str


def infer_buyer_intent(text: str) -> BuyerIntent:
    t = (text or "").strip()
    if not t:
        return BuyerIntent((), "空消息")
    sample = t[:800]
    hit: list[str] = []
    for label, kws in _INTENT_RULES:
        if any(kw in sample for kw in kws):
            hit.append(label)
    # 去重保序
    seen: set[str] = set()
    ordered: list[str] = []
    for x in hit:
        if x not in seen:
            seen.add(x)
            ordered.append(x)
    if not ordered:
        ordered = ["一般咨询"]
    return BuyerIntent(tuple(ordered), "、".join(ordered))
