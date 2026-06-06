"""把买家原话包装成带意图与行为约束的 user 内容，减少机械客服腔。"""

from __future__ import annotations

from app.intent import BuyerIntent


def build_augmented_user_message(
    *,
    raw_buyer_message: str,
    platform: str,
    intent: BuyerIntent,
) -> str:
    raw = (raw_buyer_message or "").strip()
    plat = (platform or "").strip() or "unknown"
    intent_line = intent.summary_zh or "一般咨询"

    # 单条 user 消息：FastGPT 工作流仍按「用户说话」处理，但内嵌对模型的执行说明
    return f"""【买家原话】
{raw}

【你对对方意图的内部判断（不要复述给用户、不要输出本段标题）】
渠道：{plat}
意图归类（可多选）：{intent_line}

【回复执行要求】
1. 像真实店主/客服在千牛里打字：自然、直接，不要公文腔和客服套话。
2. 先接对方话茬：点名 TA 问的产品或具体问题再答；禁止每次开场「我是您的专属xx客服」「有什么可以帮您」这类模板。
3. 话长跟着对方走：对方一句你也可简短；需要澄清时最多追问 1～2 句，别审讯式列清单。
4. 意图对齐：询价就说清价格口径（规格/起订/是否含税运视你知识库而定）；问发货就说时效/地区；别答非所问。
5. 知识边界：具体库存、精确运费、合同条款等不确定时，用「我帮您确认一下」「稍等我看下」类表述，勿编造数字和政策。
6. 只输出最终要发给买家的消息正文，不要输出分析过程、小标题、Markdown 结构（除非对方明确要求列表）。"""
