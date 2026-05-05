"""
Kaas v2 · AUTH-WX-R1: 微信 ClawBot Adapter
──────────────────────────────────────────
ClawBot getupdates/sendmessage 协议适配。

架构定位: Channel Adapter，不负责业务鉴权。

ClawBot 负责:
- 接收微信消息
- 发送微信回复
- 维护微信会话 context_token

Kaas 负责:
- 账号身份 / customer 绑定 / 报价数据隔离
- 意图识别 / 参数提取 / 选型 / 报价 / 话术输出

第一版只支持:
- 文本消息
- 单聊
- 单 bot 绑定单 customer

预留但不强制:
- 语音 / 图片 / 群聊 / 多 bot 多客户自动分流 / 主动消息 / 人工接管
"""
import time
import structlog
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from app.core.auth import AuthContext

from app.repositories.wechat_repo import (
    get_bot_by_id,
    get_or_create_wechat_conversation,
    update_context_token,
    insert_wechat_message_event,
)
from app.services.conversation_orchestrator import handle_inbound_message

logger = structlog.get_logger(__name__)


async def process_wechat_message(
    db: AsyncSession,
    bot_account_id: int,
    wechat_session_id: str,
    from_user_id: str,
    message_id: str,
    text: str,
    message_type: str = "text",
    context_token: Optional[str] = None,
    img_url: Optional[str] = None,
) -> dict:
    """
    处理从 ClawBot 收到的微信消息。

    处理流程:
    1. 根据 bot_account_id 找到 customer_id
    2. 创建或获取 wechat_conversation
    3. 保存 context_token
    4. 调用 Conversation Orchestrator
    5. 记录日志
    6. 返回回复文本 + context_token

    返回:
    {
        "reply_text": str,
        "context_token": str | None,
        "conversation_id": int,
        "intent": str,
        "quote_status": str,
    }
    """
    start = time.perf_counter()

    # 1. 获取 bot 配置，找到绑定的 customer
    bot = await get_bot_by_id(db, bot_account_id)
    if bot is None:
        return {
            "reply_text": "系统错误：未找到机器人配置",
            "context_token": None,
            "conversation_id": None,
            "intent": "unknown",
            "quote_status": "error",
        }

    customer_id = bot.customer_id
    tenant_id = bot.tenant_id

    # 查询 customer code（用于旧 Text customer_id 兼容）
    from app.db.models import Customer
    from sqlalchemy import select as sa_select
    cust_stmt = sa_select(Customer).where(Customer.id == customer_id)
    cust_result = await db.execute(cust_stmt)
    customer_row = cust_result.scalar_one_or_none()
    customer_code = customer_row.code if customer_row else None

    # 2. 创建或获取微信会话
    wx_conv = await get_or_create_wechat_conversation(
        db,
        customer_id=customer_id,
        tenant_id=tenant_id,
        bot_account_id=bot_account_id,
        wechat_session_id=wechat_session_id,
        from_user_id=from_user_id,
    )

    # 3. 保存 context_token（加密存储）
    if context_token:
        await update_context_token(db, wx_conv.id, context_token)

    # 4. 记录入站微信消息事件
    await insert_wechat_message_event(
        db,
        bot_account_id=bot_account_id,
        direction="inbound",
        wechat_session_id=wechat_session_id,
        from_user_id=from_user_id,
        message_id=message_id,
        message_type=message_type,
        status="received",
    )

    # 5. 调用 Conversation Orchestrator
    result = None
    try:
        result = await handle_inbound_message(
            db=db,
            customer_id=customer_id,
            customer_code=customer_code,
            tenant_id=tenant_id,
            channel="wechat_clawbot",
            text=text,
            sender_id=from_user_id,
        )

        reply_text = result["reply_text"]
        intent = result["intent"]
        quote_status = result["quote_status"]

    except Exception as e:
        logger.error("wechat_orchestrator_failed", error=str(e))
        reply_text = '抱歉，系统处理您的消息时遇到问题。请稍后重试，或输入"转人工"联系业务员。'
        intent = "unknown"
        quote_status = "error"

    # 6. 记录出站微信消息事件
    elapsed = int((time.perf_counter() - start) * 1000)
    try:
        await insert_wechat_message_event(
            db,
            bot_account_id=bot_account_id,
            direction="outbound",
            wechat_session_id=wechat_session_id,
            from_user_id=from_user_id,
            message_id=None,  # sendmessage 返回的 message_id
            message_type="text",
            status="sent" if quote_status != "error" else "error",
        )
    except Exception as e:
        logger.warning("wechat_outbound_event_failed", error=str(e))

    return {
        "reply_text": reply_text,
        "context_token": context_token,
        "conversation_id": result.get("conversation_id") if result else None,
        "intent": intent,
        "quote_status": quote_status,
    }
