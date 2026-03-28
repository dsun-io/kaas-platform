import time

from app import fastgpt_client
from app.conversation import ensure_conversation_id
from app.inquiry_classifier import classify
from app.logger_db import insert_log
from app.schemas import ChatRequest, ChatResponse
from app.transfer import check_transfer_intent


async def handle_chat(req: ChatRequest) -> ChatResponse:
    started = time.perf_counter()
    conv_id = ensure_conversation_id(req.conversation_id)

    # 咨询类型分类
    inquiry_type = classify(req.message)

    transfer = check_transfer_intent(req.message)
    if transfer.should_transfer:
        reply = transfer.standard_reply or ""
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        insert_log(
            platform=req.platform,
            buyer_id=req.buyer_id,
            message=req.message,
            reply=reply,
            conversation_id=conv_id,
            should_transfer=True,
            response_time_ms=elapsed_ms,
            ai_source="transfer",
            status="transfer",
            inquiry_type=inquiry_type,
        )
        return ChatResponse(
            reply=reply,
            conversation_id=conv_id,
            should_transfer=True,
            response_time_ms=elapsed_ms,
            ai_source="transfer",
            status="transfer",
        )

    # 调用 AI（现在返回 AIResult）
    result = await fastgpt_client.chat_completion(
        user_message=req.message,
        chat_id=conv_id,
    )
    elapsed_ms = int((time.perf_counter() - started) * 1000)

    # 确定状态
    if result.api_error:
        status = "ai_failed"
    else:
        status = "sent"

    insert_log(
        platform=req.platform,
        buyer_id=req.buyer_id,
        message=req.message,
        reply=result.reply,
        conversation_id=conv_id,
        should_transfer=False,
        response_time_ms=elapsed_ms,
        ai_source=result.ai_source,
        ai_latency_ms=result.ai_latency_ms,
        tokens_in=result.tokens_in,
        tokens_out=result.tokens_out,
        status=status,
        error_type=result.error_type,
        error_detail=result.error_detail,
        inquiry_type=inquiry_type,
    )

    return ChatResponse(
        reply=result.reply,
        conversation_id=conv_id,
        should_transfer=False,
        response_time_ms=elapsed_ms,
        ai_source=result.ai_source,
        status=status,
    )
