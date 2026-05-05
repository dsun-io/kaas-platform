"""
Kaas v2 · AUTH-WX-R1: 对话编排器
───────────────────────────────
处理入站消息 → 意图识别 → 参数提取 → 选型 → 报价 → 话术输出。

规则:
- 不负责鉴权（由 AuthContext 提供）
- 不负责报价计算（由 Quote Engine 提供）
- 不编造价格
- 不决定客户身份
"""
import time
import structlog
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.llm_client import llm_with_fallback
from app.services.quote_engine import create_quote
from app.repositories.wechat_repo import (
    create_conversation,
    insert_message,
    insert_usage_event,
)
from app.repositories import capabilities_repo

logger = structlog.get_logger(__name__)

# ── 意图识别 Prompt ──
INTENT_SYSTEM_PROMPT = """你是 Kaas AI 的丝网行业报价助手中的"意图识别与参数提取器"。

你的任务：
只负责把用户自然语言转成结构化 JSON。
你不负责报价。
你不允许编造价格。
你不允许判断客户身份。
你不允许输出自然语言解释。
你只能输出合法 JSON。

支持的 intent：
- quote_request：用户想询价、报价、问多少钱
- product_selection：用户描述使用场景，想知道该选什么规格或产品
- spec_explanation：用户问规格、材质、工艺、产品区别
- missing_param_reply：用户在补充上一轮缺失参数
- delivery_question：用户问交期、物流、运输、包装
- human_handoff：用户明确要求找人工、找老板、找业务员
- unknown：无法判断

需要抽取的字段：
- product_category
- usage_scenario
- height_m
- width_m
- length_m
- wire_diameter_mm
- mesh_size
- material
- surface_treatment
- quantity
- unit
- delivery_location
- special_requirements

输出 JSON 格式：

{
  "intent": "quote_request | product_selection | spec_explanation | missing_param_reply | delivery_question | human_handoff | unknown",
  "product_category": null,
  "params": {
    "usage_scenario": null,
    "height_m": null,
    "width_m": null,
    "length_m": null,
    "wire_diameter_mm": null,
    "mesh_size": null,
    "material": null,
    "surface_treatment": null,
    "quantity": null,
    "unit": null,
    "delivery_location": null,
    "special_requirements": null
  },
  "missing_params": [],
  "ambiguous_params": [],
  "raw_user_text": "",
  "confidence": 0.0
}

规则：
1. 用户没有明确说的字段填 null。
2. 不要猜价格。
3. 不要猜客户身份。
4. 不要输出 markdown。
5. 不要输出解释。
6. 只能输出 JSON。
7. 如果用户说"丝""线径""铁丝粗细"，优先映射为 wire_diameter_mm。
8. 如果用户说"米""卷""片"，保留 quantity 和 unit。
9. 如果用户只说用途，例如"养羊用"，intent 可判断为 product_selection 或 quote_request，缺失报价参数时必须放入 missing_params。
10. confidence 取 0 到 1。"""


# ── 意图识别 Function Schema ──
_INTENT_FUNCTION_SCHEMA = {
    "name": "recognize_intent_and_extract_params",
    "description": "识别用户报价咨询意图并提取规格参数",
    "parameters": {
        "type": "object",
        "properties": {
            "intent": {
                "type": "string",
                "enum": ["quote_request", "product_selection", "spec_explanation",
                         "missing_param_reply", "delivery_question", "human_handoff", "unknown"],
                "description": "用户意图分类",
            },
            "product_category": {
                "type": "string",
                "description": "产品品类，如 牛栏网、石笼网",
            },
            "usage_scenario": {"type": "string"},
            "height_m": {"type": "number", "description": "高度(米)"},
            "width_m": {"type": "number", "description": "宽度(米)"},
            "length_m": {"type": "number", "description": "长度(米)"},
            "wire_diameter_mm": {"type": "number", "description": "丝径(mm)"},
            "mesh_size": {"type": "string", "description": "网孔规格"},
            "material": {"type": "string", "description": "材质"},
            "surface_treatment": {"type": "string", "description": "表面处理如热镀锌"},
            "quantity": {"type": "number", "description": "数量"},
            "unit": {"type": "string", "description": "单位如米/卷/片"},
            "delivery_location": {"type": "string", "description": "收货地"},
            "special_requirements": {"type": "string"},
        },
    },
}


async def _recognize_intent(user_text: str) -> dict:
    """调用 LLM 进行意图识别和参数提取（使用 function_call 接口）。"""
    try:
        result = await llm_with_fallback(
            prompt=f"用户输入：\n{user_text}",
            function_name=_INTENT_FUNCTION_SCHEMA["name"],
            function_schema=_INTENT_FUNCTION_SCHEMA,
            context={},
        )
        if result:
            # 标准化为内部格式
            params = {
                "usage_scenario": result.get("usage_scenario"),
                "height_m": result.get("height_m"),
                "width_m": result.get("width_m"),
                "length_m": result.get("length_m"),
                "wire_diameter_mm": result.get("wire_diameter_mm"),
                "mesh_size": result.get("mesh_size"),
                "material": result.get("material"),
                "surface_treatment": result.get("surface_treatment"),
                "quantity": result.get("quantity"),
                "unit": result.get("unit"),
                "delivery_location": result.get("delivery_location"),
                "special_requirements": result.get("special_requirements"),
            }
            return {
                "intent": result.get("intent", "unknown"),
                "product_category": result.get("product_category"),
                "params": params,
                "missing_params": [],
                "ambiguous_params": [],
                "raw_user_text": user_text,
                "confidence": 0.8,
            }
    except Exception as e:
        logger.warning("intent_llm_failed", error=str(e))

    return _local_intent_fallback(user_text)


def _local_intent_fallback(user_text: str) -> dict:
    """本地意图识别（无 LLM 时的兜底）。"""
    text = user_text.strip()
    params = {
        "usage_scenario": None, "height_m": None, "width_m": None,
        "length_m": None, "wire_diameter_mm": None, "mesh_size": None,
        "material": None, "surface_treatment": None, "quantity": None,
        "unit": None, "delivery_location": None, "special_requirements": None,
    }

    # 简单关键词匹配
    if any(kw in text for kw in ["多少钱", "报价", "什么价", "价格", "询价"]):
        intent = "quote_request"
    elif any(kw in text for kw in ["选", "推荐", "用什么", "哪种", "养羊", "养牛", "用途"]):
        intent = "product_selection"
    elif any(kw in text for kw in ["规格", "材质", "区别", "工艺", "热镀锌", "冷镀锌"]):
        intent = "spec_explanation"
    elif any(kw in text for kw in ["交期", "物流", "运输", "送货", "发货", "包装"]):
        intent = "delivery_question"
    elif any(kw in text for kw in ["转人工", "人工", "找人", "老板", "业务员"]):
        intent = "human_handoff"
    else:
        intent = "unknown"

    # 简单参数提取
    import re
    m = re.search(r'(\d+\.?\d*)\s*米.*?高', text)
    if m:
        params["height_m"] = float(m.group(1))
    m = re.search(r'(\d+\.?\d*)\s*丝', text)
    if m:
        params["wire_diameter_mm"] = float(m.group(1))
    m = re.search(r'(\d+)\s*米', text)
    if m:
        params["quantity"] = int(m.group(1))
        params["unit"] = "米"
    if "热镀锌" in text:
        params["surface_treatment"] = "热镀锌"
        params["material"] = "热镀锌"
    if "冷镀锌" in text:
        params["surface_treatment"] = "冷镀锌"
    if "牛栏网" in text:
        params["product_category"] = "牛栏网"
    if "养羊" in text:
        params["usage_scenario"] = "养羊"
    if "养牛" in text:
        params["usage_scenario"] = "养牛"

    return {
        "intent": intent,
        "product_category": params.get("product_category"),
        "params": params,
        "missing_params": [],
        "ambiguous_params": [],
        "raw_user_text": text,
        "confidence": 0.5,
    }


# ── 选型推荐 ──

def _recommend_default_specs(params: dict) -> dict:
    """根据场景推荐默认规格（不依赖 LLM）。"""
    scenario = params.get("usage_scenario", "")
    category = params.get("product_category", "")

    defaults = {}

    if "牛栏网" in (category or ""):
        defaults.setdefault("product_category", "牛栏网")
        if "养羊" in (scenario or ""):
            defaults.setdefault("height_m", 1.2)
            defaults.setdefault("wire_diameter_mm", 2.5)
            defaults.setdefault("surface_treatment", "热镀锌")
            defaults.setdefault("material", "热镀锌")
        elif "养牛" in (scenario or ""):
            defaults.setdefault("height_m", 1.5)
            defaults.setdefault("wire_diameter_mm", 2.8)
            defaults.setdefault("surface_treatment", "热镀锌")
            defaults.setdefault("material", "热镀锌")
        else:
            defaults.setdefault("height_m", 1.2)
            defaults.setdefault("wire_diameter_mm", 2.5)
            defaults.setdefault("surface_treatment", "热镀锌")
            defaults.setdefault("material", "热镀锌")

    return defaults


def _check_required_params(params: dict) -> list[str]:
    """检查报价所需的缺失参数。"""
    missing = []
    if not params.get("product_category"):
        missing.append("product_category")
    if not params.get("height_m"):
        missing.append("height_m")
    if not params.get("wire_diameter_mm") and not params.get("mesh_spec"):
        missing.append("wire_diameter_mm_or_mesh_spec")
    if not params.get("quantity"):
        missing.append("quantity")
    return missing


# ── 话术模板 ──

def _render_matched_script(quote_result: dict, params: dict) -> str:
    """报价命中话术。"""
    main = quote_result.get("main_line", {})
    totals = quote_result.get("totals", {})
    cat = quote_result.get("product_category", params.get("product_category", ""))
    spec = main.get("spec_summary", "")
    qty = params.get("quantity", "")
    unit = params.get("unit", "米")
    unit_price = main.get("unit_price", "")
    currency = main.get("currency", "CNY")
    price_unit = main.get("unit", "")
    total_price = totals.get("total_price", "")

    return (
        f"这个规格我们可以做。\n\n"
        f"按你说的：\n"
        f"- 产品：{cat}\n"
        f"- 规格：{spec}\n"
        f"- 数量：{qty}{unit}\n"
        f"- 单价：{unit_price}{currency}/{price_unit}\n"
        f"- 预估总价：{total_price}{currency}\n\n"
        f"这个价格暂不含运费，最终还要看收货地、包装和实际生产要求。"
        f"你可以把收货地址发我，我继续帮你核完整到货价。"
    )


def _render_missing_params_script(params: dict, missing: list[str]) -> str:
    """缺参数追问话术。"""
    known = {k: v for k, v in params.items() if v is not None}
    known_str = "\n".join(f"- {k}: {v}" for k, v in known.items())
    missing_str = "\n".join(f"- {m}" for m in missing)

    return (
        f"可以报，但还差几个关键参数。\n\n"
        f"你现在提供的是：\n{known_str}\n\n"
        f"还需要确认：\n{missing_str}\n\n"
        f"如果是常规用途，我可以先按常见规格帮你推荐一版，但正式报价要等参数确认后再算。"
    )


def _render_not_supported_script(params: dict) -> str:
    known = {k: v for k, v in params.items() if v is not None}
    known_str = "\n".join(f"- {k}: {v}" for k, v in known.items())
    return (
        f"这个规格需要人工确认，当前系统里没有命中可支持的生产范围。\n\n"
        f"为了避免直接给错价，我建议先转人工确认能不能做。"
        f"你也可以补充一下用途、数量和收货地，我帮你整理给业务员。\n\n"
        f"已知参数：\n{known_str}"
    )


def _render_no_price_script(params: dict) -> str:
    return (
        f"这个规格看起来可以做，但当前客户报价表里还没有维护对应价格。\n\n"
        f"我先把这个询价记录下来，建议转人工确认价格后再回复，避免系统编价。"
    )


def _render_estimated_script(quote_result: dict) -> str:
    return f"这个规格可以先给参考估算，但不是最终报价。\n\n参考结果：\n{quote_result.get('summary', '')}\n\n最终价格还需要结合实际规格、数量、包装和运费确认。"


def _render_human_handoff_script(params: dict) -> str:
    known = {k: v for k, v in params.items() if v is not None}
    known_str = "\n".join(f"- {k}: {v}" for k, v in known.items())
    return (
        f"这个问题建议人工确认后再回复。\n\n"
        f"我已经整理出客户的问题和已知参数：\n{known_str}\n\n"
        f"建议业务员确认后再给最终答复，避免系统直接误报。"
    )


# ── 主编排入口 ──

async def handle_inbound_message(
    db: AsyncSession,
    customer_id: int,
    tenant_id: str,
    channel: str,
    text: str,
    sender_id: str = "unknown",
    conversation_id: Optional[int] = None,
    customer_code: Optional[str] = None,
) -> dict:
    """
    处理入站消息的主入口。

    参数:
        customer_id: int — customers.id 主键 (用于 FK 引用)
        customer_code: str — 旧 Text customer_id (用于定价表等旧表查询)

    返回:
    {
        "conversation_id": int,
        "message_id": int,
        "reply_text": str,
        "intent": str,
        "quote_status": str,
        "product_category": str | None,
        "extracted_params": dict,
        "latency_ms": int,
    }
    """
    start = time.perf_counter()

    # 1. 获取或创建对话
    if conversation_id is None:
        conv = await create_conversation(db, customer_id, tenant_id, channel)
        conversation_id = conv.id

    # 2. 保存用户消息
    user_msg = await insert_message(
        db,
        conversation_id=conversation_id,
        role="user",
        raw_content=text,
    )

    # 3. 意图识别 + 参数提取
    intent_result = await _recognize_intent(text)
    intent = intent_result.get("intent", "unknown")
    product_category = intent_result.get("product_category")
    params = intent_result.get("params", {})
    confidence = intent_result.get("confidence", 0.0)

    if product_category and not params.get("product_category"):
        params["product_category"] = product_category

    # 4. 选型推荐（补充默认规格）
    defaults = _recommend_default_specs(params)
    for k, v in defaults.items():
        if params.get(k) is None:
            params[k] = v

    # 5. 判断报价条件
    reply_text = ""
    quote_status = ""

    if intent == "human_handoff":
        quote_status = "need_human"
        reply_text = _render_human_handoff_script(params)

    elif intent == "unknown":
        quote_status = "need_human"
        reply_text = '抱歉，我没有理解您的问题。您可以描述一下需要询价的规格参数（如高度、丝径、材质、数量），或者输入"转人工"联系业务员。'

    elif intent in ("spec_explanation", "delivery_question"):
        # 非报价类问题：返回通用说明
        quote_status = "need_human"
        reply_text = f"好的，您的问题我已经记录下来。这个问题建议转人工确认后给您更准确的答复。\n\n您也可以同时提供需要询价的规格参数，我可以先帮您查价。"

    elif intent in ("quote_request", "product_selection", "missing_param_reply"):
        # 检查缺失参数
        missing = _check_required_params(params)
        if missing:
            quote_status = "missing_params"
            reply_text = _render_missing_params_script(params, missing)
        else:
            # 执行报价
            try:
                quote_request = {
                    "product_category": params.get("product_category"),
                    "params": {
                        "height": params.get("height_m"),
                        "wire_diameter": str(params.get("wire_diameter_mm", "")),
                        "surface_treatment": params.get("surface_treatment"),
                        "material": params.get("material"),
                        "quantity": params.get("quantity"),
                        "unit": params.get("unit", "米"),
                    },
                }
                quote_result = await create_quote(
                    db=db,
                    tenant_id=tenant_id,
                    customer_id=customer_code or str(customer_id),
                    request=quote_request,
                )
                status = quote_result.get("status", "spec_not_supported")

                if status == "matched":
                    quote_status = "matched"
                    reply_text = _render_matched_script(quote_result, params)
                elif status == "no_price":
                    quote_status = "no_price"
                    reply_text = _render_no_price_script(params)
                elif status in ("estimated", "estimated_from_cost"):
                    quote_status = "estimated"
                    reply_text = _render_estimated_script(quote_result)
                else:
                    quote_status = "spec_not_supported"
                    reply_text = _render_not_supported_script(params)

            except Exception as e:
                logger.error("quote_engine_failed", error=str(e))
                quote_status = "need_human"
                reply_text = _render_human_handoff_script(params)
    else:
        quote_status = "need_human"
        reply_text = "抱歉，这个问题我暂时无法处理。建议转人工确认。"

    # 6. 保存助手消息
    elapsed = int((time.perf_counter() - start) * 1000)
    assistant_msg = await insert_message(
        db,
        conversation_id=conversation_id,
        role="assistant",
        raw_content=reply_text,
        normalized_content=text,
        intent=intent,
        product_category=params.get("product_category"),
        extracted_params_json=params,
        quote_status=quote_status,
        latency_ms=elapsed,
    )

    # 7. 用量事件
    await insert_usage_event(
        db,
        tenant_id=tenant_id,
        channel=channel,
        event_type="conversation_turn",
        customer_id=customer_id,
        success=(quote_status not in ("need_human",)),
        metadata_json={
            "intent": intent,
            "quote_status": quote_status,
            "confidence": confidence,
            "latency_ms": elapsed,
        },
    )

    return {
        "conversation_id": conversation_id,
        "message_id": assistant_msg.id,
        "reply_text": reply_text,
        "intent": intent,
        "quote_status": quote_status,
        "product_category": params.get("product_category"),
        "extracted_params": params,
        "latency_ms": elapsed,
    }
