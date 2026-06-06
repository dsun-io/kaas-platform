import asyncio
import json
import time

from app import fastgpt_client
from app.config import settings
from app.conversation import ensure_conversation_id
from app.inquiry_classifier import classify
from app.logger_db import insert_log
from app.prompting import build_augmented_user_message
from app.safety_filter import run_safety_pipeline
from app.schemas import ChatRequest, ChatResponse
from app.stub_replies import get_stub_reply
from app.transfer import check_transfer_intent

# 报价引擎已重构为纯计算器模式
# FastGPT 负责参数提取和知识库查询，通过 /api/v1/quote 端点调用计算
# 此处不再需要本地报价逻辑


async def handle_chat(req: ChatRequest) -> ChatResponse:
    started = time.perf_counter()
    conv_id = ensure_conversation_id(req.conversation_id)

    # 咨询类型分类
    inquiry_type = classify(req.message)

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
        variables=fgt_variables if fgt_variables else None,
    )

    # 安全过滤管道（AI回复后、记录日志前）
    original_reply = reply
    filter_result = None
    should_transfer = api_err
    transfer_reason = None

    if settings.safety_filter_enabled and reply and not api_err:
        filter_result = run_safety_pipeline(reply)
        # 修复：显式判断 None 而非 falsy，避免空字符串（拦截时）回退到原始回复
        if filter_result.should_transfer:
            # 被安全过滤拦截，使用空回复（由 should_transfer 标记转人工）
            reply = ""
        elif filter_result.filtered_reply is not None:
            reply = filter_result.filtered_reply
        # else: 保持原始 reply（理论上不会发生）
        should_transfer = filter_result.should_transfer or api_err
        transfer_reason = filter_result.transfer_reason if filter_result.should_transfer else None

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
        should_transfer=should_transfer,
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
        should_transfer=should_transfer,
        response_time_ms=elapsed_ms,
        ai_source=result.ai_source,
        status=status,
    )
