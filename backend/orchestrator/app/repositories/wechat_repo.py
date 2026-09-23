"""
Kaas v2 · AUTH-WX-R1: 微信 ClawBot 仓库
"""
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update, func
from app.db.models import (
    WechatBotAccount,
    WechatConversation,
    ChannelLink,
    UsageEvent,
    WechatMessageEvent,
)


# ── WechatBotAccount ──

async def create_bot_account(
    session: AsyncSession,
    customer_id: int,
    tenant_id: str,
    bot_name: str,
    bot_type: str,
    bot_token_encrypted: str,
    created_by: str | None = None,
) -> WechatBotAccount:
    bot = WechatBotAccount(
        customer_id=customer_id,
        tenant_id=tenant_id,
        bot_name=bot_name,
        bot_type=bot_type,
        bot_token_encrypted=bot_token_encrypted,
        status="active",
        created_by=created_by,
    )
    session.add(bot)
    await session.flush()
    return bot


async def get_active_bots(session: AsyncSession) -> list[WechatBotAccount]:
    stmt = select(WechatBotAccount).where(WechatBotAccount.status == "active")
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def get_bots_by_customer(session: AsyncSession, customer_id: int) -> list[WechatBotAccount]:
    stmt = select(WechatBotAccount).where(
        WechatBotAccount.customer_id == customer_id,
        WechatBotAccount.status == "active",
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def get_bot_by_id(session: AsyncSession, bot_id: int) -> WechatBotAccount | None:
    stmt = select(WechatBotAccount).where(WechatBotAccount.id == bot_id)
    result = await session.execute(stmt)
    return result.scalar_one_or_none()


async def update_bot_status(session: AsyncSession, bot_id: int, status: str) -> None:
    stmt = update(WechatBotAccount).where(WechatBotAccount.id == bot_id).values(status=status)
    await session.execute(stmt)


# ── WechatConversation ──

async def get_or_create_wechat_conversation(
    session: AsyncSession,
    customer_id: int,
    tenant_id: str,
    bot_account_id: int,
    wechat_session_id: str,
    from_user_id: str,
) -> WechatConversation:
    stmt = select(WechatConversation).where(
        WechatConversation.bot_account_id == bot_account_id,
        WechatConversation.from_user_id == from_user_id,
    )
    result = await session.execute(stmt)
    conv = result.scalar_one_or_none()

    if conv is None:
        conv = WechatConversation(
            customer_id=customer_id,
            tenant_id=tenant_id,
            bot_account_id=bot_account_id,
            wechat_session_id=wechat_session_id,
            from_user_id=from_user_id,
            status="active",
        )
        session.add(conv)
        await session.flush()
    else:
        conv.wechat_session_id = wechat_session_id
        conv.status = "active"

    return conv


async def update_context_token(
    session: AsyncSession,
    conv_id: int,
    context_token_encrypted: str | None,
) -> None:
    stmt = (
        update(WechatConversation)
        .where(WechatConversation.id == conv_id)
        .values(last_context_token_encrypted=context_token_encrypted)
    )
    await session.execute(stmt)


# ── ChannelLink ──

async def create_channel_link(
    session: AsyncSession,
    customer_id: int,
    tenant_id: str,
    channel: str,
    name: str | None = None,
    scenario: str | None = None,
    link_token: str | None = None,
    created_by: str | None = None,
) -> ChannelLink:
    link = ChannelLink(
        customer_id=customer_id,
        tenant_id=tenant_id,
        channel=channel,
        name=name,
        scenario=scenario,
        link_token=link_token,
        created_by=created_by,
    )
    session.add(link)
    await session.flush()
    return link


async def get_channel_link_by_token(session: AsyncSession, token: str) -> ChannelLink | None:
    stmt = select(ChannelLink).where(
        ChannelLink.link_token == token,
        ChannelLink.enabled == True,
    )
    result = await session.execute(stmt)
    return result.scalar_one_or_none()


# ── UsageEvent ──

async def insert_usage_event(
    session: AsyncSession,
    tenant_id: str,
    channel: str,
    event_type: str,
    customer_id: int | None = None,
    success: bool = True,
    error_code: str | None = None,
    metadata_json: dict | None = None,
) -> UsageEvent:
    evt = UsageEvent(
        customer_id=customer_id,
        tenant_id=tenant_id,
        channel=channel,
        event_type=event_type,
        success=success,
        error_code=error_code,
        metadata_json=metadata_json,
    )
    session.add(evt)
    await session.flush()
    return evt


# ── WechatMessageEvent ──

async def insert_wechat_message_event(
    session: AsyncSession,
    bot_account_id: int,
    direction: str,
    wechat_session_id: str | None = None,
    from_user_id: str | None = None,
    message_id: str | None = None,
    message_type: str = "text",
    status: str = "received",
    error_code: str | None = None,
) -> WechatMessageEvent:
    evt = WechatMessageEvent(
        bot_account_id=bot_account_id,
        wechat_session_id=wechat_session_id,
        from_user_id=from_user_id,
        message_id=message_id,
        direction=direction,
        message_type=message_type,
        status=status,
        error_code=error_code,
    )
    session.add(evt)
    await session.flush()
    return evt
