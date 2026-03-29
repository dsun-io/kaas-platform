"""
统一编排器（Orchestrator）。

抽取 rpa-qianniu 和 rpa-pdd 中重复的 AppState、去重、会话管理、主循环逻辑，
提供统一的 RPA 执行框架。

使用方式：
    ```python
    adapter = QianniuAdapter(config)
    orchestrator = Orchestrator(adapter, ai_client)
    await orchestrator.run()
    ```
"""

from __future__ import annotations

import json
import secrets
import signal
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Protocol

from app.models import Reply

if TYPE_CHECKING:
    from app.adapter_base import PlatformAdapter
    from app.models import AdapterConfig, Message


# 简化的 AI 客户端接口
class AIClient(Protocol):
    """AI 客户端协议。"""

    def chat(
        self,
        *,
        buyer_id: str,
        message: str,
        conversation_id: str | None,
        **kwargs: Any,
    ) -> tuple[str, str | None, int, str | None]:
        """
        调用 AI 获取回复。

        Returns:
            (reply, conversation_id, elapsed_ms, error)
        """
        ...


@dataclass
class OrchestratorState:
    """编排器状态（持久化）。"""

    # buyer_id -> conversation_id
    conversations: dict[str, str] = field(default_factory=dict)

    # 去重键列表
    dedup_keys: list[str] = field(default_factory=list)

    # buyer_id -> 最后回复的消息指纹
    last_replied_fingerprint: dict[str, str] = field(default_factory=dict)

    # buyer_id -> 最后回复时间戳（monotonic）
    last_reply_mono: dict[str, float] = field(default_factory=dict)

    # buyer_id -> 对话轮次计数
    round_counters: dict[str, int] = field(default_factory=dict)

    def dedup_set(self) -> set[str]:
        """返回去重集合。"""
        return set(self.dedup_keys)

    def remember_dedup(self, key: str, max_size: int = 5000) -> None:
        """记住去重键。"""
        if key in self.dedup_keys:
            return
        self.dedup_keys.append(key)
        overflow = len(self.dedup_keys) - max_size
        if overflow > 0:
            del self.dedup_keys[:overflow]

    def to_dict(self) -> dict[str, Any]:
        """序列化为字典。"""
        return {
            "conversations": self.conversations,
            "dedup_keys": self.dedup_keys,
            "last_replied_fingerprint": self.last_replied_fingerprint,
            "last_reply_mono": {k: v for k, v in self.last_reply_mono.items()},
            "round_counters": self.round_counters,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "OrchestratorState":
        """从字典创建。"""
        conv = data.get("conversations") or {}
        keys = data.get("dedup_keys") or []
        lrf = data.get("last_replied_fingerprint") or {}
        lrm = data.get("last_reply_mono") or {}
        rc = data.get("round_counters") or {}

        return cls(
            conversations={str(k): str(v) for k, v in conv.items()},
            dedup_keys=[str(x) for x in keys][-5000:],
            last_replied_fingerprint={str(k): str(v) for k, v in lrf.items()},
            last_reply_mono={str(k): float(v) for k, v in lrm.items() if isinstance(v, (int, float))},
            round_counters={str(k): int(v) for k, v in rc.items() if isinstance(v, (int, float))},
        )


class Orchestrator:
    """
    统一编排器。

    管理适配器生命周期、状态管理、去重、AI 调用、回复发送。
    """

    def __init__(
        self,
        adapter: PlatformAdapter,
        ai_client: AIClient | None = None,
        state_path: Path | None = None,
        *,
        session_cooldown_sec: float = 3.0,
        soak_error_threshold: int = 10,
        soak_error_reset_sec: float = 30.0,
        soak_stats_interval_sec: float = 300.0,
        on_message: Callable[[Message, Reply], None] | None = None,
        on_error: Callable[[Exception], None] | None = None,
    ) -> None:
        """
        初始化编排器。

        Args:
            adapter: 平台适配器
            ai_client: AI 客户端（可选）
            state_path: 状态文件路径
            session_cooldown_sec: 会话冷却时间
            soak_error_threshold: 连续异常阈值
            soak_error_reset_sec: 异常熔断后休眠时间
            soak_stats_interval_sec: 统计信息输出间隔
            on_message: 消息处理回调
            on_error: 错误处理回调
        """
        self.adapter = adapter
        self.ai_client = ai_client
        self.state_path = state_path or Path("data/orchestrator_state.json")
        self.session_cooldown_sec = session_cooldown_sec
        self.soak_error_threshold = soak_error_threshold
        self.soak_error_reset_sec = soak_error_reset_sec
        self.soak_stats_interval_sec = soak_stats_interval_sec
        self.on_message = on_message
        self.on_error = on_error

        self._state = self._load_state()
        self._shutdown = threading.Event()
        self._paused = threading.Event()
        self._session_id = secrets.token_hex(8)
        self._start_mono = time.monotonic()
        self._consecutive_errors = 0
        self._processed_count = 0
        self._last_stats_time = self._start_mono

    def _load_state(self) -> OrchestratorState:
        """加载状态。"""
        if not self.state_path.exists():
            return OrchestratorState()
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
            return OrchestratorState.from_dict(raw)
        except Exception as exc:
            print(f"[WARN] 状态加载失败: {exc}")
            return OrchestratorState()

    def _save_state(self) -> None:
        """保存状态。"""
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.state_path.with_suffix(".tmp")
            tmp.write_text(
                json.dumps(self._state.to_dict(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            tmp.replace(self.state_path)
        except Exception as exc:
            print(f"[WARN] 状态保存失败: {exc}")

    def _ensure_conversation_id(self, buyer_id: str) -> str:
        """确保有 conversation_id。"""
        conv_id = self._state.conversations.get(buyer_id)
        if not conv_id:
            conv_id = f"conv_{secrets.token_hex(16)}"
            self._state.conversations[buyer_id] = conv_id
        return conv_id

    def _fingerprint(self, buyer_id: str, content: str) -> str:
        """生成消息指纹。"""
        from hashlib import sha256
        text = f"{buyer_id}:{content}:{int(time.time() / 90)}"
        return sha256(text.encode()).hexdigest()[:32]

    def _check_cooldown(self, buyer_id: str) -> bool:
        """检查会话是否在冷却中。"""
        last = self._state.last_reply_mono.get(buyer_id, 0.0)
        if last > 0 and (time.monotonic() - last) < self.session_cooldown_sec:
            return True
        return False

    def _sleep(self, seconds: float) -> bool:
        """可中断的睡眠。"""
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self._shutdown.is_set():
                return True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(0.25, remaining))
        return self._shutdown.is_set()

    def _print_stats(self) -> None:
        """打印统计信息。"""
        now = time.monotonic()
        elapsed_min = (now - self._start_mono) / 60
        print(
            f"[SOAK] 运行 {elapsed_min:.1f} 分钟 | "
            f"处理 {self._processed_count} 条 | "
            f"连续异常 {self._consecutive_errors}"
        )

    async def initialize(self) -> None:
        """初始化适配器。"""
        print(f"[Orchestrator] 初始化适配器: {self.adapter.platform}")
        await self.adapter.initialize()
        print(f"[Orchestrator] 初始化完成 session_id={self._session_id}")

    def shutdown(self) -> None:
        """请求关闭。"""
        print("[Orchestrator] 收到关闭请求...")
        self._shutdown.set()

    async def run_once(self) -> bool:
        """
        执行一轮主循环。

        Returns:
            是否继续运行
        """
        # 检查暂停
        if self._paused.is_set():
            return not self._sleep(0.2)

        # 健康检查
        health = self.adapter.health_check()
        if health["status"] == "error":
            print(f"[ERROR] 适配器健康检查失败: {health['details']}")
            self._consecutive_errors += 1
            if self._sleep(5.0):
                return False
            return True

        # 连续异常熔断
        if self._consecutive_errors >= self.soak_error_threshold:
            print(
                f"[SOAK] 连续异常 ≥ {self.soak_error_threshold}，"
                f"休眠 {self.soak_error_reset_sec} 秒"
            )
            if self._sleep(self.soak_error_reset_sec):
                return False
            self._consecutive_errors = 0

        # 统计输出
        now = time.monotonic()
        if now - self._last_stats_time >= self.soak_stats_interval_sec:
            self._print_stats()
            self._last_stats_time = now

        try:
            # 获取未读会话（使用 list_sessions 获取快照，过滤未读数>0的会话）
            sessions = self.adapter.list_sessions()
            unread_sessions = [s for s in sessions if s.unread_count > 0]

            for session in unread_sessions:
                if self._shutdown.is_set():
                    return False

                buyer_id = session.buyer_id
                session_id = session.session_id

                print(f"[会话] {buyer_id} (unread={session.unread_count})")

                # 冷却检查
                if self._check_cooldown(buyer_id):
                    print(f"[跳过] {buyer_id} 冷却中")
                    continue

                # 选择会话
                if not self.adapter.select_session(session_id):
                    print(f"[失败] 无法选择会话: {session_id}")
                    continue

                # 获取消息
                messages = self.adapter.fetch_messages(session_id, limit=1)
                if not messages:
                    print(f"[无消息] {session_id}")
                    continue

                msg = messages[0]
                content = msg.content.strip()
                if not content:
                    continue

                # 去重检查
                fp = self._fingerprint(buyer_id, content)
                if fp in self._state.dedup_set():
                    print(f"[去重] {buyer_id}: {content[:40]}...")
                    continue

                if self._state.last_replied_fingerprint.get(buyer_id) == fp:
                    print(f"[已回复] {buyer_id}: {content[:40]}...")
                    continue

                print(f"[收到] {buyer_id}: {content[:80]}")

                # AI 调用
                reply_content = "暂不支持 AI 回复"
                ai_elapsed_ms = 0
                ai_error = None

                if self.ai_client:
                    conv_id = self._ensure_conversation_id(buyer_id)
                    t0 = time.monotonic()
                    try:
                        reply, new_conv, elapsed_ms, err = self.ai_client.chat(
                            buyer_id=buyer_id,
                            message=content,
                            conversation_id=conv_id,
                        )
                        if new_conv:
                            self._state.conversations[buyer_id] = new_conv
                        reply_content = reply
                        ai_elapsed_ms = elapsed_ms
                        ai_error = err
                    except Exception as exc:
                        print(f"[AI错误] {exc}")
                        ai_error = str(exc)
                        if self.on_error:
                            self.on_error(exc)

                # 构造回复
                reply = Reply(
                    content=reply_content,
                    extra={
                        "ai_elapsed_ms": ai_elapsed_ms,
                        "ai_error": ai_error,
                    },
                )

                # 发送回复
                ok = self.adapter.send_reply(session_id, reply)
                if ok:
                    print(f"[已发送] {buyer_id}")
                    self._state.remember_dedup(fp)
                    self._state.last_replied_fingerprint[buyer_id] = fp
                    self._state.last_reply_mono[buyer_id] = time.monotonic()
                    self._state.round_counters[buyer_id] = (
                        self._state.round_counters.get(buyer_id, 0) + 1
                    )
                    self._processed_count += 1
                    self._consecutive_errors = 0
                    self._save_state()
                else:
                    print(f"[发送失败] {session_id}")
                    self._consecutive_errors += 1

                # 回调
                if self.on_message:
                    self.on_message(msg, reply)

                if self._shutdown.is_set():
                    return False

            return True

        except Exception as exc:
            print(f"[异常] {exc}")
            self._consecutive_errors += 1
            if self.on_error:
                self.on_error(exc)
            if self._sleep(3.0):
                return False
            return True

    async def run(self) -> None:
        """主循环。"""
        print(f"[Orchestrator] 启动主循环 platform={self.adapter.platform}")

        # 安装信号处理
        def _signal_handler(signum: int, frame: Any) -> None:
            print("\n[INFO] 收到信号，正在退出...")
            self.shutdown()

        signal.signal(signal.SIGINT, _signal_handler)
        if hasattr(signal, "SIGTERM"):
            signal.signal(signal.SIGTERM, _signal_handler)

        try:
            while not self._shutdown.is_set():
                should_continue = await self.run_once()
                if not should_continue:
                    break
        finally:
            print("[Orchestrator] 关闭中...")
            self._save_state()
            await self.adapter.shutdown()
            elapsed_min = (time.monotonic() - self._start_mono) / 60
            print(
                f"[Orchestrator] 已退出 | "
                f"运行 {elapsed_min:.1f} 分钟 | "
                f"处理 {self._processed_count} 条消息"
            )
