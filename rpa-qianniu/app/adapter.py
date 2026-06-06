"""
千牛平台适配器实现。

包装现有的 qianniu_driver 函数为统一的 PlatformAdapter 接口。
"""

from __future__ import annotations

import time
import uuid
from typing import TYPE_CHECKING, Any, Iterator

if TYPE_CHECKING:
    import numpy as np
    import uiautomation as auto

from app.models import AdapterConfig, Message, Reply, Session
from app.adapter_base import (
    AdapterInitError,
    AdapterRuntimeError,
    PlatformAdapter,
    SessionNotFoundError,
)

# 导入现有的千牛驱动函数
from app.ai_client import chat as ai_chat
from app.config import settings
from app.hotkeys import start_f12_pause_toggle
from app.logger import get_logger
from app.message_parser import (
    fingerprint_key,
    has_substantive_buyer_text,
    is_non_message_ui_text,
    is_system_message,
    normalize_buyer_id as _normalize_buyer_id,
)
from app.qianniu_driver import (
    capture_window_frame_bgr,
    guess_active_buyer_title,
    human_delay,
    item_has_unread,
    list_session_list_items,
    locate_main_window_with_retry,
    locate_window_title_hint,
    read_latest_buyer_message_hybrid,
    select_session,
    session_display_name,
    window_alive,
)
from app.reply_sender import send_reply
from app.ui_selectors import get_selectors
from app.vision_markers import vision_available

log = get_logger("adapter")


class QianniuAdapter(PlatformAdapter):
    """
    千牛客服平台适配器。

    包装现有的 UIA + OCR 驱动，实现统一的 PlatformAdapter 接口。
    """

    def __init__(self, config: AdapterConfig | None = None) -> None:
        """初始化千牛适配器。"""
        if config is None:
            config = AdapterConfig(
                platform="qianniu",
                poll_interval_sec=settings.poll_interval_sec,
                wait_no_unread_poll_sec=settings.wait_no_unread_poll_sec,
                session_cooldown_sec=3.0,
            )
        super().__init__(config)
        self._win: "auto.Control | None" = None
        self._paused = False
        self._shutdown = False
        self._vision_available = vision_available()

    async def initialize(self) -> None:
        """初始化：定位千牛窗口。"""
        log.info("初始化千牛适配器...")

        def _log_attempt(attempt: int, w) -> None:
            if w is None:
                subs = get_selectors().window_title_substrings
                hint = "、".join(subs) if subs else settings.qianniu_window_substring
                print(f"[定位] 第 {attempt} 次：未找到窗口：{hint}")
            else:
                try:
                    title = w.Name or ""
                except Exception:
                    title = ""
                print(f"[定位] 第 {attempt} 次：已匹配窗口「{title}」")

        self._win = locate_main_window_with_retry(on_attempt=_log_attempt)
        if self._win is None:
            hint = locate_window_title_hint()
            raise AdapterInitError(f"无法定位千牛窗口。{hint}")

        try:
            title = self._win.Name or ""
        except Exception:
            title = ""
        log.info("千牛窗口已定位: %s", title)
        print(f"千牛窗口已定位: {title}")

        # 启动 F12 暂停快捷键
        import threading
        self._pause_event = threading.Event()
        if start_f12_pause_toggle(self._pause_event):
            print("快捷键：F12 暂停/继续")

        self._initialized = True
        log.info("千牛适配器初始化完成")

    async def shutdown(self) -> None:
        """关闭适配器。"""
        log.info("关闭千牛适配器...")
        self._shutdown = True
        self._win = None
        self._initialized = False

    def health_check(self) -> dict[str, Any]:
        """健康检查。"""
        if not self._initialized:
            return {"status": "error", "details": {"reason": "not_initialized"}}

        alive = window_alive(self._win) if self._win else False
        if not alive:
            return {"status": "error", "details": {"reason": "window_not_alive"}}

        return {
            "status": "ok",
            "details": {
                "window_alive": True,
                "vision_available": self._vision_available,
                "platform": "qianniu",
            },
        }

    # ==================== 会话管理 ====================

    def list_sessions(self) -> list[Session]:
        """列出所有会话（左侧列表）。"""
        if not self._win:
            return []

        items = list_session_list_items(self._win)
        sessions = []

        # 捕获帧用于视觉未读检测
        vision_frame = None
        if self._vision_available and settings.vision_unread_enabled:
            vision_frame = capture_window_frame_bgr(self._win)

        for item in items:
            try:
                name = session_display_name(item)
                buyer_id = self.normalize_buyer_id(name)
                has_unread = item_has_unread(self._win, item, vision_frame)

                sessions.append(
                    Session(
                        session_id=self.make_session_id(buyer_id),
                        platform="qianniu",
                        buyer_id=buyer_id,
                        buyer_nick=name,
                        unread_count=1 if has_unread else 0,
                        status="active",
                    )
                )
            except Exception as exc:
                log.debug("获取会话信息失败: %s", exc)
                continue

        return sessions

    def get_session(self, session_id: str) -> Session | None:
        """获取指定会话。"""
        platform, buyer_id = self.parse_session_id(session_id)
        if platform != "qianniu":
            return None

        sessions = self.list_sessions()
        for s in sessions:
            if s.session_id == session_id:
                return s
        return None

    def select_session(self, session_id: str) -> bool:
        """选择指定会话。"""
        if not self._win:
            return False

        platform, buyer_id = self.parse_session_id(session_id)
        if platform != "qianniu":
            return False

        items = list_session_list_items(self._win)
        for item in items:
            try:
                name = session_display_name(item)
                if self.normalize_buyer_id(name) == buyer_id:
                    select_session(item)
                    human_delay()
                    return True
            except Exception:
                continue
        return False

    # ==================== 消息操作 ====================

    def fetch_messages(
        self,
        session_id: str,
        since: str | None = None,
        limit: int = 10,
    ) -> list[Message]:
        """获取会话消息（千牛只返回最新消息）。"""
        msg = self.fetch_latest_message(session_id)
        if msg:
            return [msg]
        return []

    def fetch_latest_message(self, session_id: str) -> Message | None:
        """获取最新买家消息。"""
        if not self._win:
            return None

        platform, buyer_id = self.parse_session_id(session_id)
        if platform != "qianniu":
            return None

        # 使用混合方式读取消息
        msg_text, ts_token, _ = read_latest_buyer_message_hybrid(
            self._win, recent_sec=90.0
        )

        if not msg_text:
            return None

        msg_text = msg_text.strip()

        # 过滤无效消息
        if is_non_message_ui_text(msg_text) or is_system_message(msg_text):
            log.debug("系统/占位消息，跳过: %s", msg_text[:80])
            return None

        if not has_substantive_buyer_text(msg_text):
            log.debug("无实质内容，跳过: %s", msg_text[:80])
            return None

        # 获取买家昵称
        buyer_nick = guess_active_buyer_title(self._win) or buyer_id

        return Message(
            message_id=f"qn_{uuid.uuid4().hex[:16]}",
            platform="qianniu",
            buyer_id=buyer_id,
            buyer_nick=buyer_nick,
            content=msg_text,
            timestamp=ts_token or time.strftime("%Y-%m-%d %H:%M:%S"),
            session_id=session_id,
            is_buyer=True,
            message_type="text",
            extra={"source": "qianniu_hybrid"},
        )

    def send_reply(self, session_id: str, reply: Reply) -> bool:
        """发送回复。"""
        if not self._win:
            return False

        platform, buyer_id = self.parse_session_id(session_id)
        if platform != "qianniu":
            return False

        # 先选择会话
        if not self.select_session(session_id):
            log.warning("选择会话失败: %s", session_id)
            return False

        human_delay()

        # 发送回复
        ok = send_reply(self._win, reply.content)
        return ok

    # ==================== 轮询/监听 ====================

    def poll_unread_sessions(self) -> Iterator[Session]:
        """轮询未读会话。"""
        while not self._shutdown:
            # 检查暂停
            if self._pause_event.is_set():
                time.sleep(0.2)
                continue

            # 检查窗口存活
            if not window_alive(self._win):
                log.warning("窗口丢失，尝试恢复...")
                try:
                    self._win = locate_main_window_with_retry()
                    if self._win is None:
                        time.sleep(5.0)
                        continue
                except Exception as exc:
                    log.error("恢复窗口失败: %s", exc)
                    time.sleep(5.0)
                    continue

            sessions = self.list_sessions()
            for s in sessions:
                if s.unread_count > 0:
                    yield s

            time.sleep(self.config.poll_interval_sec)

    def poll_messages(self, session_id: str) -> Iterator[Message]:
        """轮询指定会话的新消息。"""
        last_fingerprint: dict[str, str] = {}

        while not self._shutdown:
            msg = self.fetch_latest_message(session_id)
            if msg:
                # 生成指纹去重
                fp = fingerprint_key(msg.buyer_id, msg.content)
                if last_fingerprint.get(session_id) != fp:
                    last_fingerprint[session_id] = fp
                    yield msg

            time.sleep(self.config.poll_interval_sec)

    # ==================== 实用方法 ====================

    def normalize_buyer_id(self, raw: str) -> str:
        """规范化买家 ID。"""
        return _normalize_buyer_id(raw)

    def check_window_alive(self) -> bool:
        """检查窗口是否存活（供 Orchestrator 使用）。"""
        return window_alive(self._win) if self._win else False

    def recover_window(self) -> bool:
        """恢复窗口（供 Orchestrator 使用）。"""
        try:
            self._win = locate_main_window_with_retry()
            return self._win is not None
        except Exception as exc:
            log.error("恢复窗口失败: %s", exc)
            return False
