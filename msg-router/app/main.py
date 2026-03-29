from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException

from app.fastgpt_client import close_client
from app.config import settings
from app.logger_db import init_db
from app.router import handle_chat
from app.schemas import ChatRequest, ChatResponse
from app.transfer import check_transfer_intent

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
    return {
        "status": "ok",
        "version": "0.2.0",
        "supported_platforms": ",".join(sorted(SUPPORTED_PLATFORMS)),
    }


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
