import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

from app.config import settings


_DB_WRITE_LOCK = threading.Lock()


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
                created_at TEXT NOT NULL,
                original_reply TEXT,
                filter_action TEXT
            )
            """
        )
        conn.commit()

        # 迁移：为旧表添加新列（如果不存在）
        _migrate_add_columns(conn)
    finally:
        conn.close()


def _migrate_add_columns(conn: sqlite3.Connection) -> None:
    """数据库迁移：添加新列（向后兼容）."""
    cursor = conn.execute("PRAGMA table_info(chat_logs)")
    existing_columns = {row[1] for row in cursor.fetchall()}

    # 添加 original_reply 列
    if "original_reply" not in existing_columns:
        conn.execute("ALTER TABLE chat_logs ADD COLUMN original_reply TEXT")

    # 添加 filter_action 列
    if "filter_action" not in existing_columns:
        conn.execute("ALTER TABLE chat_logs ADD COLUMN filter_action TEXT")

    conn.commit()


def insert_log(
    *,
    platform: str,
    buyer_id: str,
    message: str,
    reply: str,
    conversation_id: str,
    should_transfer: bool,
    response_time_ms: int,
    original_reply: str | None = None,
    filter_action: str | None = None,
) -> int:
    with _DB_WRITE_LOCK:
        conn = _connect()
        try:
            cur = conn.execute(
                """
                INSERT INTO chat_logs (
                    platform, buyer_id, message, reply, conversation_id,
                    should_transfer, response_time_ms, created_at,
                    original_reply, filter_action
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    original_reply,
                    filter_action,
                ),
            )
            conn.commit()
            return int(cur.lastrowid or 0)
        finally:
            conn.close()
