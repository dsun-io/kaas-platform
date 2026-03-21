import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from app.config import settings


def _connect() -> sqlite3.Connection:
    path = settings.sqlite_absolute_path
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = _connect()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT NOT NULL,
                buyer_id TEXT NOT NULL,
                message TEXT NOT NULL,
                reply TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                should_transfer INTEGER NOT NULL,
                response_time_ms INTEGER NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def insert_log(
    *,
    platform: str,
    buyer_id: str,
    message: str,
    reply: str,
    conversation_id: str,
    should_transfer: bool,
    response_time_ms: int,
) -> int:
    conn = _connect()
    try:
        cur = conn.execute(
            """
            INSERT INTO chat_logs (
                platform, buyer_id, message, reply, conversation_id,
                should_transfer, response_time_ms, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                platform,
                buyer_id,
                message,
                reply,
                conversation_id,
                int(should_transfer),
                response_time_ms,
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        conn.commit()
        return int(cur.lastrowid or 0)
    finally:
        conn.close()
