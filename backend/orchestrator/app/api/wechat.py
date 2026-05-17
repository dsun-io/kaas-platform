"""
Kaas v2 · AUTH-WX-R1: 微信 ClawBot API
──────────────────────────────────────
POST /api/v1/wechat/bots — 创建 bot 账号
GET  /api/v1/wechat/bots — 列出 bot 账号
POST /api/v1/wechat/webhook — 接收微信消息（模拟 ClawBot getupdates）
GET  /api/v1/wechat/conversations — 列出微信会话
GET  /api/v1/wechat/conversations/{id} — 查看会话详情

规则:
- customer 账号只能管理自己的 bot
- internal 账号可管理所有 bot
- webhook 根据 bot_id 自动找到绑定的 customer
"""
import os
import uuid
import structlog
from fastapi import APIRouter, Request, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db_session
from app.db.models import User, Customer
from app.core.auth import get_auth_context, AuthContext, require_customer_access
from app.repositories.wechat_repo import (
    create_bot_account,
    get_active_bots,
    get_bots_by_customer,
    get_bot_by_id,
    update_bot_status,
    create_channel_link,
    get_channel_link_by_token,
    list_conversations,
    get_conversation,
    get_messages_by_conversation,
    get_or_create_wechat_conversation,
    update_context_token,
    insert_wechat_message_event,
)
from app.services.wechat_adapter import process_wechat_message

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1/wechat", tags=["wechat"])


# ── 简单的 token 加密（生产环境应使用 proper encryption） ──
def _mask_token(token: str) -> str:
    """对 token 进行简单混淆存储（生产需用 AES/fernet）。"""
    import base64
    return base64.b64encode(token.encode()).decode()


def _unmask_token(masked: str) -> str:
    import base64
    return base64.b64decode(masked.encode()).decode()


# ── Bot 管理 ──

@router.post("/bots")
async def create_bot(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """创建微信 bot 账号。

    权限:
    - internal: 可选任意 customer
    - customer: 自动绑定自己的 customer_id
    """
    auth: AuthContext = request.state.auth

    body = await request.json()

    # customer 账号只能创建自己的 bot，拒绝不匹配的覆盖参数
    if auth.is_customer():
        if auth.customer_id is None:
            return JSONResponse(
                status_code=403,
                content={"error": "forbidden", "message": "Customer account not bound to any customer"},
            )
        from app.core.auth_utils import require_tenant_match, require_customer_match
        require_tenant_match(auth, body.get("tenant_id"))
        require_customer_match(auth, body.get("customer_id"))
        customer_id = auth.customer_id
        tenant_id = auth.tenant_id or ""
    else:
        customer_id = body.get("customer_id")
        tenant_id = body.get("tenant_id", "") or auth.tenant_id or ""

    bot_name = body.get("bot_name", "")
    bot_token = body.get("bot_token", "")
    bot_type = body.get("bot_type", "clawbot")

    if not bot_name or not bot_token:
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": "bot_name and bot_token are required"},
        )

    if not customer_id:
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": "customer_id is required"},
        )

    if not tenant_id:
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": "tenant_id is required"},
        )

    # internal 账号可创建任意 customer 的 bot
    if auth.is_internal() and not require_customer_access(auth, customer_id):
        return JSONResponse(
            status_code=403,
            content={"error": "forbidden", "message": "Access denied"},
        )

    bot = await create_bot_account(
        session=db,
        customer_id=customer_id,
        tenant_id=tenant_id,
        bot_name=bot_name,
        bot_type=bot_type,
        bot_token_encrypted=_mask_token(bot_token),
        created_by=str(auth.user_id),
    )

    logger.info("wechat_bot_created", bot_id=bot.id, customer_id=customer_id)

    return JSONResponse(
        status_code=201,
        content={
            "id": bot.id,
            "customer_id": bot.customer_id,
            "tenant_id": bot.tenant_id,
            "bot_name": bot.bot_name,
            "bot_type": bot.bot_type,
            "status": bot.status,
            "created_by": bot.created_by,
            "created_at": bot.created_at.isoformat(),
            "updated_at": bot.updated_at.isoformat(),
        },
    )


@router.get("/bots")
async def list_bots(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """列出 bot 账号。

    - internal: 所有 active bots
    - customer: 只自己的 bots
    """
    auth: AuthContext = request.state.auth

    if auth.is_internal():
        bots = await get_active_bots(db)
    else:
        if auth.customer_id is None:
            return JSONResponse(status_code=200, content={"bots": []})
        bots = await get_bots_by_customer(db, auth.customer_id)

    return JSONResponse(
        status_code=200,
        content={
            "bots": [
                {
                    "id": b.id,
                    "customer_id": b.customer_id,
                    "tenant_id": b.tenant_id,
                    "bot_name": b.bot_name,
                    "bot_type": b.bot_type,
                    "status": b.status,
                    "created_at": b.created_at.isoformat(),
                    "updated_at": b.updated_at.isoformat(),
                }
                for b in bots
            ]
        },
    )


@router.post("/bots/{bot_id}/pause")
async def pause_bot(
    bot_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """暂停 bot。"""
    auth: AuthContext = request.state.auth
    bot = await get_bot_by_id(db, bot_id)

    if bot is None:
        return JSONResponse(status_code=404, content={"error": "not_found", "message": "Bot not found"})

    if not require_customer_access(auth, bot.customer_id):
        return JSONResponse(status_code=403, content={"error": "forbidden", "message": "Access denied"})

    await update_bot_status(db, bot_id, "paused")
    return JSONResponse(status_code=200, content={"message": "Bot paused"})


@router.post("/bots/{bot_id}/resume")
async def resume_bot(
    bot_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """恢复 bot。"""
    auth: AuthContext = request.state.auth
    bot = await get_bot_by_id(db, bot_id)

    if bot is None:
        return JSONResponse(status_code=404, content={"error": "not_found", "message": "Bot not found"})

    if not require_customer_access(auth, bot.customer_id):
        return JSONResponse(status_code=403, content={"error": "forbidden", "message": "Access denied"})

    await update_bot_status(db, bot_id, "active")
    return JSONResponse(status_code=200, content={"message": "Bot resumed"})


# ── 渠道链接 ──

@router.post("/channel-links")
async def create_link(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """创建渠道链接（如微信二维码绑定）。"""
    auth: AuthContext = request.state.auth
    body = await request.json()

    channel = body.get("channel", "wechat_clawbot")
    name = body.get("name")
    scenario = body.get("scenario")

    if auth.is_customer():
        from app.core.auth_utils import require_tenant_match, require_customer_match
        require_tenant_match(auth, body.get("tenant_id"))
        require_customer_match(auth, body.get("customer_id"))
        customer_id = auth.customer_id
        tenant_id = auth.tenant_id or ""
    else:
        customer_id = body.get("customer_id")
        tenant_id = body.get("tenant_id", "") or auth.tenant_id or ""

    if not customer_id or not tenant_id:
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": "customer_id and tenant_id are required"},
        )

    link_token = uuid.uuid4().hex[:16]
    link = await create_channel_link(
        session=db,
        customer_id=customer_id,
        tenant_id=tenant_id,
        channel=channel,
        name=name,
        scenario=scenario,
        link_token=link_token,
        created_by=str(auth.user_id),
    )

    return JSONResponse(
        status_code=201,
        content={
            "id": link.id,
            "customer_id": link.customer_id,
            "tenant_id": link.tenant_id,
            "channel": link.channel,
            "name": link.name,
            "scenario": link.scenario,
            "link_token": link.link_token,
            "enabled": link.enabled,
            "created_at": link.created_at.isoformat(),
        },
    )


# ── Webhook: 接收微信消息 ──

@router.post("/webhook")
async def wechat_webhook(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """
    微信消息接收端点（模拟 ClawBot getupdates / webhook）。

    第一版通过 API 直接传入消息，模拟微信消息到达。
    后续接真实 ClawBot 时改为 getupdates loop。

    Body:
    - bot_id: int
    - wechat_session_id: str
    - from_user_id: str
    - message_id: str
    - text: str
    - message_type: str (text | voice | image)
    - context_token: str (optional)
    """
    body = await request.json()

    bot_id = body.get("bot_id")
    wechat_session_id = body.get("wechat_session_id", "")
    from_user_id = body.get("from_user_id", "")
    message_id = body.get("message_id", "")
    text = body.get("text", "")
    message_type = body.get("message_type", "text")
    context_token = body.get("context_token")

    if not bot_id or not text:
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": "bot_id and text are required"},
        )

    if not wechat_session_id:
        wechat_session_id = f"wx_{from_user_id}_{bot_id}"

    if not message_id:
        message_id = f"msg_{uuid.uuid4().hex[:12]}"

    result = await process_wechat_message(
        db=db,
        bot_account_id=bot_id,
        wechat_session_id=wechat_session_id,
        from_user_id=from_user_id,
        message_id=message_id,
        text=text,
        message_type=message_type,
        context_token=context_token,
    )

    return JSONResponse(
        status_code=200,
        content={
            "reply_text": result["reply_text"],
            "context_token": result.get("context_token"),
            "conversation_id": result.get("conversation_id"),
            "intent": result.get("intent"),
            "quote_status": result.get("quote_status"),
        },
    )


# ── 会话查询 ──

@router.get("/conversations")
async def list_wx_conversations(
    request: Request,
    customer_id: int | None = None,
    db: AsyncSession = Depends(get_db_session),
):
    """列出会话。

    - internal: 可选 customer_id 过滤
    - customer: 只看自己的
    """
    auth: AuthContext = request.state.auth

    if auth.is_customer():
        customer_id = auth.customer_id
        if customer_id is None:
            return JSONResponse(status_code=200, content={"conversations": []})

    convs = await list_conversations(db, customer_id=customer_id)

    return JSONResponse(
        status_code=200,
        content={
            "conversations": [
                {
                    "id": c.id,
                    "customer_id": c.customer_id,
                    "tenant_id": c.tenant_id,
                    "channel": c.channel,
                    "status": c.status,
                    "created_at": c.created_at.isoformat(),
                    "updated_at": c.updated_at.isoformat(),
                }
                for c in convs
            ]
        },
    )


@router.get("/conversations/{conv_id}")
async def get_wx_conversation_detail(
    conv_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """获取会话详情（含消息列表）。"""
    auth: AuthContext = request.state.auth
    conv = await get_conversation(db, conv_id)

    if conv is None:
        return JSONResponse(status_code=404, content={"error": "not_found", "message": "Conversation not found"})

    if not require_customer_access(auth, conv.customer_id):
        return JSONResponse(status_code=403, content={"error": "forbidden", "message": "Access denied"})

    messages = await get_messages_by_conversation(db, conv_id)

    return JSONResponse(
        status_code=200,
        content={
            "conversation": {
                "id": conv.id,
                "customer_id": conv.customer_id,
                "tenant_id": conv.tenant_id,
                "channel": conv.channel,
                "status": conv.status,
                "created_at": conv.created_at.isoformat(),
                "updated_at": conv.updated_at.isoformat() if conv.updated_at else None,
            },
            "messages": [
                {
                    "id": m.id,
                    "conversation_id": m.conversation_id,
                    "role": m.role,
                    "raw_content": m.raw_content,
                    "intent": m.intent,
                    "product_category": m.product_category,
                    "quote_status": m.quote_status,
                    "latency_ms": m.latency_ms,
                    "error_code": m.error_code,
                    "created_at": m.created_at.isoformat(),
                }
                for m in messages
            ],
        },
    )
