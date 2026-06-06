"""追加写入 JSON Lines 对话留档（无数据库）。- 拼多多版本"""

from __future__ import annotations

import json
import time
from pathlib import Path

from app.config import settings
from app.logger import get_logger

log = get_logger("chat_logger")


def _log_path() -> Path:
    return Path(settings.state_dir) / "chat_logs.jsonl"


def log_conversation(
    *,
    buyer_nick: str,
    buyer_msg: str,
    ai_reply: str,
    ai_source: str = "fastgpt",
    latency_ocr_ms: int = 0,
    latency_ai_ms: int = 0,
    latency_send_ms: int = 0,
    latency_total_ms: int = 0,
    tokens_in: int | None = None,
    tokens_out: int | None = None,
    status: str = "sent",
    error: str | None = None,
    platform: str = "pdd",
    conversation_id: str | None = None,
    round_index: int | None = None,
    buyer_id_source: str | None = None,
    session_id: str | None = None,
) -> None:
    """记录对话日志，支持浸泡测试 session_id 标记"""
    record = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "platform": platform,
        "buyer_nick": buyer_nick,
        "buyer_msg": buyer_msg,
        "ai_reply": ai_reply,
        "ai_source": ai_source,
        "latency_ocr_ms": latency_ocr_ms,
        "latency_ai_ms": latency_ai_ms,
        "latency_send_ms": latency_send_ms,
        "latency_total_ms": latency_total_ms,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "status": status,
        "error": error,
        "conversation_id": conversation_id,
        "round_index": round_index,
        "buyer_id_source": buyer_id_source,
        "session_id": session_id,
    }
    path = _log_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as exc:
        log.error("[chat_logger] 写入失败: %s", exc)
