"""
拼多多平台适配器实现。

包装现有的 pdd_driver 函数为统一的 PlatformAdapter 接口。
"""

from __future__ import annotations

import time
import uuid
from typing import TYPE_CHECKING, Any, Iterator

if TYPE_CHECKING:
    from playwright.sync_api import Page

from app.models import AdapterConfig, Message, Reply, Session
from app.adapter_base import (
    AdapterInitError,
    AdapterRuntimeError,
    PlatformAdapter,
    SessionNotFoundError,
)

# 导入现有的拼多多驱动函数
from app.ai_client import chat as ai_chat
from app.browser_manager import BrowserManager, screenshot_on_error
from app.config import settings
from app.login_handler import ensure_logged_in, needs_relogin
from app.logger import get_logger
from app.message_filter import (
    fingerprint,
    is_system_message,
    normalize_buyer_id as _normalize_buyer_id,
)
from app.message_listener import MessageListener
from app.pdd_driver import (
    human_delay,
    read_latest_buyer_message_from_dom,
    select_first_unread_session,
    selectors_configured_for_automation,
    send_reply,
)

log = get_logger("adapter")


class PddAdapter(PlatformAdapter):
    """
    拼多多客服平台适配器。

    包装现有的 Playwright 浏览器驱动，实现统一的 PlatformAdapter 接口。
    """

    def __init__(self, config: AdapterConfig | None = None) -> None:
        """初始化拼多多适配器。"""
        if config is None:
            config = AdapterConfig(
                platform="pdd",
                poll_interval_sec=settings.dom_poll_interval_sec,
                wait_no_unread_poll_sec=5.0,
                session_cooldown_sec=12.0,
            )
        super().__init__(config)
        self._bm: BrowserManager | None = None
        self._listener: MessageListener | None = None
        self._shutdown = False

    async def initialize(self) -> None:
        """初始化：启动浏览器并登录。"""
        log.info("初始化拼多多适配器...")
        print("拼多多适配器初始化...")

        self._bm = BrowserManager()
        self._listener = MessageListener()

        try:
            page = self._bm.start()
            self._listener.attach(page)
            ensure_logged_in(self._bm, page)

            if not selectors_configured_for_automation():
                log.warning(
                    "config/selectors.json 未配全，部分自动化功能可能受限"
                )

            print("拼多多适配器初始化完成")
            log.info("拼多多适配器初始化完成")
            self._initialized = True

        except Exception as exc:
            log.exception("初始化失败: %s", exc)
            raise AdapterInitError(f"拼多多适配器初始化失败: {exc}")

    async def shutdown(self) -> None:
        """关闭适配器。"""
        log.info("关闭拼多多适配器...")
        self._shutdown = True
        if self._bm:
            self._bm.close()
            self._bm = None
        self._listener = None
        self._initialized = False

    def health_check(self) -> dict[str, Any]:
        """健康检查。"""
        if not self._initialized:
            return {"status": "error", "details": {"reason": "not_initialized"}}

        if not self._bm:
            return {"status": "error", "details": {"reason": "browser_not_ready"}}

        alive = self._bm.is_page_alive()
        if not alive:
            return {"status": "error", "details": {"reason": "page_not_alive"}}

        # 检查是否需要重新登录
        page = self._bm.page
        if page and needs_relogin(page):
            return {"status": "warning", "details": {"reason": "needs_relogin"}}

        return {
            "status": "ok",
            "details": {
                "page_alive": True,
                "selectors_configured": selectors_configured_for_automation(),
                "platform": "pdd",
            },
        }

    def _recover(self) -> bool:
        """恢复浏览器（内部方法）。"""
        if not self._bm:
            return False

        try:
            screenshot_on_error(self._bm.page, "adapter_recover")
            page = self._bm.restart()
            if self._listener:
                self._listener.attach(page)
            ensure_logged_in(self._bm, page)
            return True
        except Exception as exc:
            log.exception("恢复浏览器失败: %s", exc)
            return False

    # ==================== 会话管理 ====================

    def list_sessions(self) -> list[Session]:
        """列出所有会话。

        拼多多没有直接列出所有会话的 API，
        通过检测未读会话来反推活跃会话列表。
        """
        if not self._bm or not self._bm.page:
            return []

        # 拼多多无法像千牛那样直接列出所有会话
        # 返回空列表，依赖 poll_unread_sessions 来发现会话
        return []

    def get_session(self, session_id: str) -> Session | None:
        """获取指定会话。"""
        platform, buyer_id = self.parse_session_id(session_id)
        if platform != "pdd":
            return None

        # 拼多多无法直接获取会话信息
        # 构造一个基本会话对象
        return Session(
            session_id=session_id,
            platform="pdd",
            buyer_id=buyer_id,
            status="active",
        )

    def select_session(self, session_id: str) -> bool:
        """选择指定会话。

        拼多多通过 select_first_unread_session 自动选择，
        不支持精确选择某个会话。
        """
        if not self._bm or not self._bm.page:
            return False

        platform, buyer_id = self.parse_session_id(session_id)
        if platform != "pdd":
            return False

        # 拼多多不支持精确选择，只能点第一个未读
        # 这里简单地返回 True，实际选择由 poll_unread_sessions 处理
        return True

    # ==================== 消息操作 ====================

    def fetch_messages(
        self,
        session_id: str,
        since: str | None = None,
        limit: int = 10,
    ) -> list[Message]:
        """获取会话消息（拼多多只返回最新消息）。"""
        msg = self.fetch_latest_message(session_id)
        if msg:
            return [msg]
        return []

    def fetch_latest_message(self, session_id: str) -> Message | None:
        """获取最新买家消息。"""
        if not self._bm or not self._bm.page:
            return None

        platform, buyer_id = self.parse_session_id(session_id)
        if platform != "pdd":
            return None

        msg_text, ts = read_latest_buyer_message_from_dom(self._bm.page)
        if not msg_text:
            return None

        msg_text = msg_text.strip()

        # 过滤系统消息
        if is_system_message(msg_text):
            log.info("系统消息，跳过: %s", msg_text[:120])
            return None

        return Message(
            message_id=f"pdd_{uuid.uuid4().hex[:16]}",
            platform="pdd",
            buyer_id=buyer_id,
            content=msg_text,
            timestamp=ts or time.strftime("%Y-%m-%d %H:%M:%S"),
            session_id=session_id,
            is_buyer=True,
            message_type="text",
            extra={"source": "pdd_dom"},
        )

    def send_reply(self, session_id: str, reply: Reply) -> bool:
        """发送回复。"""
        if not self._bm or not self._bm.page:
            return False

        platform, buyer_id = self.parse_session_id(session_id)
        if platform != "pdd":
            return False

        ok = send_reply(self._bm.page, reply.content)
        return ok

    # ==================== 轮询/监听 ====================

    def poll_unread_sessions(self) -> Iterator[Session]:
        """轮询未读会话。"""
        while not self._shutdown:
            # 检查浏览器状态
            if not self._bm or not self._bm.is_page_alive():
                log.error("页面已关闭，尝试恢复...")
                if not self._recover():
                    time.sleep(3.0)
                    continue

            page = self._bm.page
            if page is None:
                time.sleep(1.0)
                continue

            # 检查登录状态
            if needs_relogin(page):
                log.warning("检测到登录态失效")
                screenshot_on_error(page, "relogin_required")
                try:
                    ensure_logged_in(self._bm, page)
                    if self._listener:
                        self._listener.attach(page)
                except Exception as exc:
                    log.exception("重新登录失败: %s", exc)
                    time.sleep(3.0)
                    continue

            # 选择第一个未读会话
            raw_buyer = select_first_unread_session(page)
            if raw_buyer:
                buyer_id = self.normalize_buyer_id(raw_buyer)
                session = Session(
                    session_id=self.make_session_id(buyer_id),
                    platform="pdd",
                    buyer_id=buyer_id,
                    buyer_nick=raw_buyer,
                    unread_count=1,
                    status="active",
                )
                yield session

            time.sleep(self.config.poll_interval_sec)

    def poll_messages(self, session_id: str) -> Iterator[Message]:
        """轮询指定会话的新消息。"""
        seen_fingerprints: set[str] = set()

        while not self._shutdown:
            msg = self.fetch_latest_message(session_id)
            if msg:
                # 使用指纹去重
                fp = fingerprint(msg.buyer_id, msg.content, msg.timestamp)
                if fp not in seen_fingerprints:
                    seen_fingerprints.add(fp)
                    # 限制去重集合大小
                    if len(seen_fingerprints) > 1000:
                        seen_fingerprints.clear()
                    yield msg

            time.sleep(self.config.poll_interval_sec)

    # ==================== 实用方法 ====================

    def normalize_buyer_id(self, raw: str) -> str:
        """规范化买家 ID。"""
        return _normalize_buyer_id(raw)

    def check_page_alive(self) -> bool:
        """检查页面是否存活（供 Orchestrator 使用）。"""
        return self._bm.is_page_alive() if self._bm else False

    def recover_browser(self) -> bool:
        """恢复浏览器（供 Orchestrator 使用）。"""
        return self._recover()

    @property
    def browser_manager(self) -> BrowserManager | None:
        """获取 BrowserManager（供 Orchestrator 使用）。"""
        return self._bm

    @property
    def message_listener(self) -> MessageListener | None:
        """获取 MessageListener（供 Orchestrator 使用）。"""
        return self._listener
