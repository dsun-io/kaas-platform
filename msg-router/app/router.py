import asyncio
import json
import time

from app import fastgpt_client
from app.config import settings
from app.conversation import ensure_conversation_id
from app.intent import infer_buyer_intent
from app.logger_db import insert_log
from app.prompting import build_augmented_user_message
from app.safety_filter import run_safety_pipeline
from app.schemas import ChatRequest, ChatResponse
from app.stub_replies import get_stub_reply
from app.transfer import check_transfer_intent

# 报价引擎集成
from app.quotation_engine import QuotationEngine, QuoteRequest, extract_params_from_text, apply_defaults
from app.quote_templates import QuoteResponseGenerator

# 初始化报价引擎（全局单例）
_pricing_engine = None

def get_pricing_engine() -> QuotationEngine:
    """获取报价引擎单例"""
    global _pricing_engine
    if _pricing_engine is None:
        _pricing_engine = QuotationEngine()
    return _pricing_engine


async def _handle_quote_request(message: str) -> tuple[str, dict]:
    """
    处理报价请求（代码引擎，不调用FastGPT）
    
    Args:
        message: 用户消息
        
    Returns:
        (回复话术, 报价数据)
    """
    try:
        engine = get_pricing_engine()
        
        # 1. 从文本提取参数
        params = extract_params_from_text(message)
        
        # 2. 应用默认值
        params = apply_defaults(params)
        
        # 3. 构造报价请求
        request = QuoteRequest(
            wire_diameter=params.get('wire_diameter', '2.0×1.8'),
            height=params.get('height', 0),
            mesh_width=params.get('mesh_width', '15cm'),
            roll_length=params.get('roll_length', 50),
            quantity=params.get('quantity', 1),
            mesh_type=params.get('mesh_type', '上疏下密'),
            surface_treatment=params.get('surface_treatment', '热镀锌'),
            packaging=params.get('packaging', '标准简包'),
            trade_type=params.get('trade_type', '内贸'),
            exchange_rate=params.get('exchange_rate', 7.25),
            profit_margin=params.get('profit_margin', 0.18)
        )
        
        # 4. 计算报价
        result = engine.calculate(request)
        
        # 5. 生成话术
        reply = QuoteResponseGenerator.generate(result)
        
        return reply, result.to_dict()
        
    except Exception as e:
        # 降级到FastGPT（如果引擎失败）
        error_reply = f"抱歉，报价系统暂时不可用：{str(e)}\n请稍后重试或联系人工客服。"
        return error_reply, {"status": "error", "message": str(e)}


async def handle_chat(req: ChatRequest) -> ChatResponse:
    started = time.perf_counter()
    conv_id = ensure_conversation_id(req.conversation_id)

    # 1. 转人工检测
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

    # 2. 桩模式（测试用）
    if settings.chat_stub_mode:
        if settings.chat_stub_reply and settings.chat_stub_reply.strip():
            reply = settings.chat_stub_reply.strip()
        else:
            reply = get_stub_reply(
                req.message,
                config_path=settings.stub_replies_absolute_path,
            )
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

    # 3. 意图识别
    intent = infer_buyer_intent(req.message)
    
    # 4. 报价查询路由（新增：优先走代码引擎）
    if "询价议价" in intent.labels:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        reply, quote_data = await _handle_quote_request(req.message)
        
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

    # 5. 其他意图走FastGPT
    if settings.chat_augment_enabled:
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

    # 构建过滤日志
    filter_action = None
    if filter_result:
        filter_action = json.dumps({
            "is_filtered": filter_result.is_filtered,
            "should_transfer": filter_result.should_transfer,
            "filter_log": filter_result.filter_log,
            "elapsed_ms": filter_result.elapsed_ms,
        }, ensure_ascii=False)

    await asyncio.to_thread(
        insert_log,
        platform=req.platform,
        buyer_id=req.buyer_id,
        message=req.message,
        reply=reply,
        conversation_id=conv_id,
        should_transfer=should_transfer,
        response_time_ms=elapsed_ms,
        original_reply=original_reply if (filter_result and filter_result.is_filtered) else None,
        filter_action=filter_action,
    )

    return ChatResponse(
        reply=reply,
        conversation_id=conv_id,
        should_transfer=should_transfer,
        response_time_ms=elapsed_ms,
        filtered=filter_result.is_filtered if filter_result else False,
        filter_log=filter_result.filter_log if filter_result else None,
        transfer_reason=transfer_reason,
    )
