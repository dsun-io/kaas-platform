from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException

from app.fastgpt_client import close_client
from app.config import settings
from app.logger_db import init_db
from app.router import handle_chat
from app.schemas import ChatRequest, ChatResponse
from app.transfer import check_transfer_intent


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not settings.fastgpt_api_key.strip():
        # 允许启动便于 /health；真正调用前在 .env 配置密钥
        pass
    init_db()
    yield
    await close_client()


app = FastAPI(title="msg-router", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    if req.platform not in ("qianniu", "pdd"):
        raise HTTPException(
            status_code=400,
            detail='platform 必须是 "qianniu" 或 "pdd"',
        )
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
