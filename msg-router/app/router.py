import time

from app import fastgpt_client
from app.conversation import ensure_conversation_id
from app.logger_db import insert_log
from app.schemas import ChatRequest, ChatResponse
from app.transfer import check_transfer_intent


async def handle_chat(req: ChatRequest) -> ChatResponse:
    started = time.perf_counter()
    conv_id = ensure_conversation_id(req.conversation_id)

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
        )
        return ChatResponse(
            reply=reply,
            conversation_id=conv_id,
            should_transfer=True,
            response_time_ms=elapsed_ms,
        )

    reply, _api_err = await fastgpt_client.chat_completion(
        user_message=req.message,
        chat_id=conv_id,
    )
    elapsed_ms = int((time.perf_counter() - started) * 1000)

    insert_log(
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
