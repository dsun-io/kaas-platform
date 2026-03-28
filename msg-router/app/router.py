import asyncio
import time

from app import fastgpt_client
from app.config import settings
from app.conversation import ensure_conversation_id
from app.intent import infer_buyer_intent
from app.logger_db import insert_log
from app.prompting import build_augmented_user_message
from app.schemas import ChatRequest, ChatResponse
from app.transfer import check_transfer_intent


async def handle_chat(req: ChatRequest) -> ChatResponse:
    started = time.perf_counter()
    conv_id = ensure_conversation_id(req.conversation_id)

    transfer = check_transfer_intent(req.message)
    if transfer.should_transfer:
        reply = transfer.standard_reply or ""
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        await asyncio.to_thread(
            insert_log,
            platform=req.platform,
            buyer_id=req.buyer_id,
            message=req.message,
            reply=reply,
            conversation_id=conv_id,
            should_transfer=True,
            response_time_ms=elapsed_ms,
        )
        return ChatResponse(
            reply=reply,
            conversation_id=conv_id,
            should_transfer=True,
            response_time_ms=elapsed_ms,
        )

    if settings.chat_stub_mode:
        reply = (settings.chat_stub_reply or "回复测试~").strip() or "回复测试~"
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        await asyncio.to_thread(
            insert_log,
            platform=req.platform,
            buyer_id=req.buyer_id,
            message=req.message,
            reply=reply,
            conversation_id=conv_id,
            should_transfer=False,
            response_time_ms=elapsed_ms,
        )
        return ChatResponse(
            reply=reply,
            conversation_id=conv_id,
            should_transfer=False,
            response_time_ms=elapsed_ms,
        )

    if settings.chat_augment_enabled:
        intent = infer_buyer_intent(req.message)
        user_for_model = build_augmented_user_message(
            raw_buyer_message=req.message,
            platform=req.platform,
            intent=intent,
        )
        fgt_variables = {
            "platform": req.platform,
            "intent_tags": ",".join(intent.labels),
            "intent_summary": intent.summary_zh,
        }
    else:
        user_for_model = req.message
        fgt_variables = {}

    reply, api_err = await fastgpt_client.chat_completion(
        user_message=user_for_model,
        chat_id=conv_id,
        variables=fgt_variables if fgt_variables else None,
    )
    elapsed_ms = int((time.perf_counter() - started) * 1000)

    await asyncio.to_thread(
        insert_log,
        platform=req.platform,
        buyer_id=req.buyer_id,
        message=req.message,
        reply=reply,
        conversation_id=conv_id,
        should_transfer=api_err,
        response_time_ms=elapsed_ms,
    )

    return ChatResponse(
        reply=reply,
        conversation_id=conv_id,
        should_transfer=api_err,
        response_time_ms=elapsed_ms,
    )
