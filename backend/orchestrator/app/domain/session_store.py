"""Kaas v2 · 会话状态存储 (§5 T11)

内存字典 + TTL 实现多轮报价会话上下文保持。
"""
import time
from typing import Any, Optional


class SessionStore:
    """简单的内存会话存储，带 TTL 过期清理。"""

    def __init__(self, default_ttl: int = 600):
        self._store: dict[str, dict[str, Any]] = {}
        self._expires: dict[str, float] = {}
        self._default_ttl = default_ttl

    def get(self, session_id: str) -> Optional[dict[str, Any]]:
        self._cleanup()
        if session_id not in self._store:
            return None
        if time.monotonic() > self._expires.get(session_id, 0):
            self.delete(session_id)
            return None
        return self._store[session_id]

    def set(self, session_id: str, data: dict[str, Any], ttl: int | None = None):
        self._store[session_id] = data
        self._expires[session_id] = time.monotonic() + (ttl or self._default_ttl)
        self._update_gauge()

    def update(self, session_id: str, data: dict[str, Any]):
        if session_id in self._store:
            self._store[session_id].update(data)
            self._expires[session_id] = time.monotonic() + self._default_ttl
        else:
            self.set(session_id, data)
        self._update_gauge()

    def delete(self, session_id: str):
        self._store.pop(session_id, None)
        self._expires.pop(session_id, None)
        self._update_gauge()

    def clear(self):
        """清空所有会话。"""
        count = len(self._store)
        self._store.clear()
        self._expires.clear()
        self._update_gauge()
        return count

    def __len__(self):
        return len(self._store)

    def _cleanup(self):
        now = time.monotonic()
        expired = [sid for sid, exp in self._expires.items() if now > exp]
        for sid in expired:
            self.delete(sid)

    def _update_gauge(self):
        try:
            from app.core.metrics import ACTIVE_SESSIONS
            ACTIVE_SESSIONS.set(len(self._store))
        except Exception:
            pass


# 全局单例
session_store = SessionStore(default_ttl=600)
