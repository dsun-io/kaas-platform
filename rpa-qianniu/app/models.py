"""
统一消息模型定义。

借鉴 ChatGPT-On-CS 的 Platform Adapter 模式，所有平台输出统一 Message 格式，
AI 层完全不感知平台差异。
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal


@dataclass
class Message:
    """统一消息格式，所有平台适配器输出此格式。"""

    # 消息唯一标识（由适配器生成）
    message_id: str

    # 平台类型
    platform: Literal["qianniu", "pdd", "douyin", "weixin", "xiaohongshu"]

    # 买家/用户 ID（规范化后）
    buyer_id: str

    # 买家昵称（原始）
    buyer_nick: str | None = None

    # 消息内容
    content: str = ""

    # 消息时间戳（ISO 格式）
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())

    # 店铺/商家 ID
    shop_id: str | None = None

    # 会话 ID（跨平台唯一，带前缀如 qn_xxx / pdd_xxx）
    session_id: str | None = None

    # 是否为买家消息（False 表示客服/系统消息）
    is_buyer: bool = True

    # 消息类型：text, image, order, system
    message_type: Literal["text", "image", "order", "system", "other"] = "text"

    # 附加元数据（平台特有字段）
    extra: dict[str, Any] = field(default_factory=dict)

    # 原始平台数据（调试/审计用）
    raw_data: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        """转换为字典格式。"""
        return {
            "message_id": self.message_id,
            "platform": self.platform,
            "buyer_id": self.buyer_id,
            "buyer_nick": self.buyer_nick,
            "content": self.content,
            "timestamp": self.timestamp,
            "shop_id": self.shop_id,
            "session_id": self.session_id,
            "is_buyer": self.is_buyer,
            "message_type": self.message_type,
            "extra": self.extra,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Message":
        """从字典创建 Message。"""
        return cls(
            message_id=data["message_id"],
            platform=data["platform"],
            buyer_id=data["buyer_id"],
            buyer_nick=data.get("buyer_nick"),
            content=data.get("content", ""),
            timestamp=data.get("timestamp", datetime.now().isoformat()),
            shop_id=data.get("shop_id"),
            session_id=data.get("session_id"),
            is_buyer=data.get("is_buyer", True),
            message_type=data.get("message_type", "text"),
            extra=data.get("extra", {}),
            raw_data=data.get("raw_data"),
        )


@dataclass
class Reply:
    """统一回复格式。"""

    # 回复内容
    content: str

    # 回复类型：text, image, template
    reply_type: Literal["text", "image", "template"] = "text"

    # 模板 ID（如使用话术库）
    template_id: str | None = None

    # 附加数据
    extra: dict[str, Any] = field(default_factory=dict)

    # 是否转人工
    should_transfer: bool = False

    # 转人工原因
    transfer_reason: str | None = None


@dataclass
class Session:
    """统一会话信息。"""

    # 会话 ID（跨平台唯一，带前缀如 qn_xxx / pdd_xxx）
    session_id: str

    # 平台类型
    platform: Literal["qianniu", "pdd", "douyin", "weixin", "xiaohongshu"]

    # 买家 ID
    buyer_id: str

    # 买家昵称
    buyer_nick: str | None = None

    # 店铺 ID
    shop_id: str | None = None

    # 未读消息数
    unread_count: int = 0

    # 最后消息时间
    last_message_at: str | None = None

    # 最后消息内容预览
    last_message_preview: str | None = None

    # 会话状态：active, closed, pending
    status: Literal["active", "closed", "pending"] = "active"

    # 额外元数据
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class AdapterConfig:
    """适配器配置。"""

    # 平台类型
    platform: str

    # 店铺 ID
    shop_id: str | None = None

    # 轮询间隔（秒）
    poll_interval_sec: float = 3.0

    # 无未读时的轮询间隔
    wait_no_unread_poll_sec: float = 5.0

    # 会话冷却时间（秒）
    session_cooldown_sec: float = 3.0

    # 消息去重窗口（秒）
    dedup_window_sec: float = 90.0

    # 额外配置
    extra: dict[str, Any] = field(default_factory=dict)
