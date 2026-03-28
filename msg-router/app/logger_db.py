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


def _add_column_if_not_exists(conn: sqlite3.Connection, column: str, col_type: str) -> None:
    """安全地添加列（如果尚不存在）"""
    try:
        conn.execute(f"ALTER TABLE chat_logs ADD COLUMN {column} {col_type}")
    except sqlite3.OperationalError:
        # 列已存在，忽略错误
        pass


def init_db() -> None:
    conn = _connect()
    try:
        # 创建基础表（如果不存在）
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
        # 平滑迁移：添加新列（兼容已有数据）
        _add_column_if_not_exists(conn, "ai_source", "TEXT DEFAULT 'unknown'")
        _add_column_if_not_exists(conn, "ai_latency_ms", "INTEGER DEFAULT NULL")
        _add_column_if_not_exists(conn, "tokens_in", "INTEGER DEFAULT NULL")
        _add_column_if_not_exists(conn, "tokens_out", "INTEGER DEFAULT NULL")
        _add_column_if_not_exists(conn, "status", "TEXT DEFAULT 'sent'")
        _add_column_if_not_exists(conn, "error_type", "TEXT DEFAULT NULL")
        _add_column_if_not_exists(conn, "error_detail", "TEXT DEFAULT NULL")
        _add_column_if_not_exists(conn, "inquiry_type", "TEXT DEFAULT NULL")
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
    ai_source: str = "unknown",
    ai_latency_ms: int | None = None,
    tokens_in: int | None = None,
    tokens_out: int | None = None,
    status: str = "sent",
    error_type: str | None = None,
    error_detail: str | None = None,
    inquiry_type: str | None = None,
) -> int:
    conn = _connect()
    try:
        cur = conn.execute(
            """
            INSERT INTO chat_logs (
                platform, buyer_id, message, reply, conversation_id,
                should_transfer, response_time_ms, created_at,
                ai_source, ai_latency_ms, tokens_in, tokens_out,
                status, error_type, error_detail, inquiry_type
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                ai_source,
                ai_latency_ms,
                tokens_in,
                tokens_out,
                status,
                error_type,
                error_detail,
                inquiry_type,
            ),
        )
        conn.commit()
        return int(cur.lastrowid or 0)
    finally:
        conn.close()
