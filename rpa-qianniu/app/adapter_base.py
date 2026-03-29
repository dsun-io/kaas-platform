"""
平台适配器基类定义。

借鉴 ChatGPT-On-CS 的 Platform Adapter 模式，每个平台实现此 ABC，
输出统一 Message 格式，AI 层完全不感知平台差异。
"""

from abc import ABC, abstractmethod
from typing import Any, Iterator

from app.models import AdapterConfig, Message, Reply, Session


class PlatformAdapter(ABC):
    """
    平台适配器抽象基类。

    所有 IM 平台（千牛、拼多多、抖音、微信等）需实现此接口。
    统一输出 Message 格式，上层 Orchestrator 无需关心平台差异。

    Example:
        ```python
        adapter = QianniuAdapter(config)
        await adapter.initialize()

        for session in adapter.list_sessions():
            if session.unread_count > 0:
                for message in adapter.fetch_messages(session.session_id):
                    reply = ai_process(message)  # AI 层无平台感知
                    adapter.send_reply(session.session_id, reply)
        ```
    """

    def __init__(self, config: AdapterConfig) -> None:
        """
        初始化适配器。

        Args:
            config: 适配器配置
        """
        self.config = config
        self._initialized = False

    @property
    def platform(self) -> str:
        """返回平台标识（如 qianniu, pdd）。"""
        return self.config.platform

    @property
    def is_initialized(self) -> bool:
        """检查是否已初始化。"""
        return self._initialized

    @abstractmethod
    async def initialize(self) -> None:
        """
        初始化平台连接/资源。

        Raises:
            AdapterInitError: 初始化失败
        """
        pass

    @abstractmethod
    async def shutdown(self) -> None:
        """关闭平台连接/资源。"""
        pass

    @abstractmethod
    def health_check(self) -> dict[str, Any]:
        """
        健康检查。

        Returns:
            {"status": "ok" | "error", "details": {...}}
        """
        pass

    # ==================== 会话管理 ====================

    @abstractmethod
    def list_sessions(self) -> list[Session]:
        """
        列出所有活跃会话。

        Returns:
            Session 列表
        """
        pass

    @abstractmethod
    def get_session(self, session_id: str) -> Session | None:
        """
        获取指定会话信息。

        Args:
            session_id: 会话 ID（跨平台唯一）

        Returns:
            Session 或 None
        """
        pass

    @abstractmethod
    def select_session(self, session_id: str) -> bool:
        """
        选择/激活指定会话。

        Args:
            session_id: 会话 ID

        Returns:
            是否成功
        """
        pass

    # ==================== 消息操作 ====================

    @abstractmethod
    def fetch_messages(
        self,
        session_id: str,
        since: str | None = None,
        limit: int = 10,
    ) -> list[Message]:
        """
        获取会话消息。

        Args:
            session_id: 会话 ID
            since: 时间戳，只获取此时间之后的消息
            limit: 最大返回条数

        Returns:
            Message 列表（按时间正序）
        """
        pass

    @abstractmethod
    def fetch_latest_message(self, session_id: str) -> Message | None:
        """
        获取最新一条买家消息。

        Args:
            session_id: 会话 ID

        Returns:
            Message 或 None
        """
        pass

    @abstractmethod
    def send_reply(self, session_id: str, reply: Reply) -> bool:
        """
        发送回复。

        Args:
            session_id: 会话 ID
            reply: 回复内容

        Returns:
            是否成功
        """
        pass

    # ==================== 轮询/监听 ====================

    @abstractmethod
    def poll_unread_sessions(self) -> Iterator[Session]:
        """
        轮询未读会话。

        Yields:
            有未读消息的 Session
        """
        pass

    @abstractmethod
    def poll_messages(self, session_id: str) -> Iterator[Message]:
        """
        轮询指定会话的新消息。

        Args:
            session_id: 会话 ID

        Yields:
            新 Message
        """
        pass

    # ==================== 实用方法 ====================

    def make_session_id(self, buyer_id: str) -> str:
        """
        生成跨平台唯一的 session_id。

        格式: {platform}_{buyer_id}

        Args:
            buyer_id: 买家 ID

        Returns:
            带前缀的 session_id
        """
        return f"{self.platform}_{buyer_id}"

    def parse_session_id(self, session_id: str) -> tuple[str, str]:
        """
        解析 session_id。

        Args:
            session_id: 会话 ID

        Returns:
            (platform, buyer_id)

        Raises:
            ValueError: 格式不正确
        """
        parts = session_id.split("_", 1)
        if len(parts) != 2:
            raise ValueError(f"Invalid session_id format: {session_id}")
        return parts[0], parts[1]

    def normalize_buyer_id(self, raw: str) -> str:
        """
        规范化买家 ID。

        Args:
            raw: 原始买家 ID

        Returns:
            规范化后的 ID
        """
        # 基础实现：去除空白，转小写
        return raw.strip().lower().replace(" ", "_")


class AdapterInitError(Exception):
    """适配器初始化错误。"""

    pass


class AdapterRuntimeError(Exception):
    """适配器运行时错误。"""

    pass


class SessionNotFoundError(AdapterRuntimeError):
    """会话未找到。"""

    pass
