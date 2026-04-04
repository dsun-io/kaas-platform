from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException

from app.fastgpt_client import close_client
from app.config import settings
from app.logger_db import init_db
from app.router import handle_chat
from app.schemas import ChatRequest, ChatResponse, QuoteRequest, QuoteResponse, QuoteItemResponse, QuoteSummaryResponse
from app.transfer import check_transfer_intent
from app.quotation_engine import QuotationEngine

# 支持的平台列表（可配置扩展）
SUPPORTED_PLATFORMS = frozenset({
    "qianniu",      # 千牛（淘宝/天猫）
    "pdd",          # 拼多多
    "douyin",       # 抖音（规划中）
    "weixin",       # 微信（规划中）
    "xiaohongshu",  # 小红书（规划中）
    "other",        # 其他/测试平台
})


def is_supported_platform(platform: str) -> bool:
    """检查平台是否受支持。"""
    return platform.lower() in SUPPORTED_PLATFORMS


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not settings.fastgpt_api_key.strip():
        # 允许启动便于 /health；真正调用前在 .env 配置密钥
        pass
    init_db()
    yield
    await close_client()


app = FastAPI(
    title="msg-router",
    version="0.2.0",  # 版本升级：Adapter 模式重构
    lifespan=lifespan,
    description="多平台统一消息路由服务（Adapter 模式）",
)


@app.get("/health")
def health() -> dict[str, str]:
    """健康检查端点。"""
    return {"status": "ok"}


@app.get("/v1/platforms")
def list_platforms() -> dict[str, list[str]]:
    """列出支持的平台。"""
    return {
        "platforms": sorted(SUPPORTED_PLATFORMS),
    }


@app.post("/v1/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    # 平台校验（可配置）
    if not is_supported_platform(req.platform):
        supported = ", ".join(sorted(SUPPORTED_PLATFORMS))
        raise HTTPException(
            status_code=400,
            detail=f'不支持的 platform: "{req.platform}"。支持的平台: {supported}',
        )

    # 消息非空校验
    if not req.message or not req.message.strip():
        raise HTTPException(
            status_code=400,
            detail="message 不能为空",
        )

    # FastGPT 配置检查
    need_fastgpt = (
        not check_transfer_intent(req.message).should_transfer
        and not settings.chat_stub_mode
    )
    if need_fastgpt and not settings.fastgpt_api_key.strip():
        raise HTTPException(
            status_code=503,
            detail="FASTGPT_API_KEY 未配置，请在 .env 中设置",
        )

    return await handle_chat(req)


# ============================================================
# 报价引擎端点（纯计算器模式）
# ============================================================

# 初始化报价引擎（延迟加载）
_quotation_engine: QuotationEngine | None = None


def get_quotation_engine() -> QuotationEngine:
    """获取报价引擎实例（单例）"""
    global _quotation_engine
    if _quotation_engine is None:
        _quotation_engine = QuotationEngine()
    return _quotation_engine


@app.post("/api/v1/quote", response_model=QuoteResponse)
def calculate_quote(req: QuoteRequest) -> QuoteResponse:
    """
    报价计算端点（纯计算器模式）
    
    FastGPT 调用此端点进行报价计算：
    1. FastGPT 从知识库查询单价/重量等参数
    2. FastGPT 组装完整请求 JSON
    3. 调用此端点执行纯数学计算
    4. 返回结构化报价结果
    
    请求格式示例：
    {
        "items": [
            {
                "name": "牛栏网 2.0×1.8 105cm 15cm 50m",
                "pricing_method": "per_kg",
                "unit_price": 8.5,
                "billing_qty": 45.2,
                "weight_kg": 45.2,
                "count": 10
            }
        ],
        "shipping": {
            "carrier": "sf_ltl",
            "province": "广东"
        },
        "need_invoice": true
    }
    """
    engine = get_quotation_engine()
    
    # 转换为字典格式
    request_dict = {
        "items": [item.model_dump() for item in req.items],
        "shipping": req.shipping.model_dump(),
        "need_invoice": req.need_invoice
    }
    
    # 执行计算
    result = engine.calculate(request_dict)
    
    # 转换为响应格式
    from dataclasses import asdict
    
    return QuoteResponse(
        status=result.status,
        items=[
            QuoteItemResponse(**item) for item in result.items
        ] if result.items else [],
        summary=QuoteSummaryResponse(**asdict(result.summary)) if result.summary else None,
        error_message=result.error_message
    )
