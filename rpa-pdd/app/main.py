"""
拼多多客服工作台 RPA（Playwright headed）。

支持两种运行模式：
1. 传统模式（默认）：直接使用 driver 函数
2. Adapter + Orchestrator 模式（新架构）：通过 adapter.py 实现

切换方式：在 .env 中设置 USE_ADAPTER_MODE=true
"""

from __future__ import annotations

import json
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from time import perf_counter

from app.ai_client import chat as ai_chat
from app.browser_manager import BrowserManager, screenshot_on_error
from app.chat_logger import log_conversation
from app.config import settings
from app.login_handler import ensure_logged_in, needs_relogin
from app.logger import get_logger, setup_logging
from app.message_filter import fingerprint, is_system_message, normalize_buyer_id
from app.message_listener import MessageListener
from app.page_selectors import get_selectors
from app.pdd_driver import (
    human_delay,
    read_latest_buyer_message_from_dom,
    select_first_unread_session,
    selectors_configured_for_automation,
    send_reply,
)

# 新架构导入（可选）
try:
    from app.adapter import PddAdapter
    from app.models import AdapterConfig, Reply
    from app.orchestrator import Orchestrator
    _ADAPTER_AVAILABLE = True
except ImportError:
    _ADAPTER_AVAILABLE = False

log = get_logger("main")

# 浸泡测试配置
_SOAK_ERROR_THRESHOLD = 10  # 连续异常阈值
_SOAK_ERROR_RESET_SEC = 30.0  # 触发熔断后的长等待
_SOAK_STATS_INTERVAL_SEC = 300.0  # 5分钟统计间隔

_MAX_DEDUP = 5000


@dataclass
class AppState:
    conversations: dict[str, str] = field(default_factory=dict)
    dedup_keys: list[str] = field(default_factory=list)

    def dedup_set(self) -> set[str]:
        return set(self.dedup_keys)

    def remember_dedup(self, key: str) -> None:
        if key in self.dedup_keys:
            return
        self.dedup_keys.append(key)
        overflow = len(self.dedup_keys) - _MAX_DEDUP
        if overflow > 0:
            del self.dedup_keys[:overflow]


def _load_state() -> AppState:
    path = settings.state_path
    if not path.exists():
        return AppState()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        conv = raw.get("conversations") or {}
        keys = raw.get("dedup_keys") or []
        if not isinstance(conv, dict):
            conv = {}
        if not isinstance(keys, list):
            keys = []
        return AppState(
            conversations={str(k): str(v) for k, v in conv.items()},
            dedup_keys=[str(x) for x in keys][-_MAX_DEDUP:],
        )
    except Exception as exc:
        log.warning("状态文件读取失败，使用空状态: %s", exc)
        return AppState()


def _save_state(st: AppState) -> None:
    path = settings.state_path
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    payload = {
        "conversations": st.conversations,
        "dedup_keys": st.dedup_keys[-_MAX_DEDUP:],
    }
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _recover_browser(bm: BrowserManager, listener: MessageListener) -> None:
    screenshot_on_error(bm.page, "browser_recover")
    page = bm.restart()
    ensure_logged_in(bm, page)
    listener.attach(page)


def perf_log(fmt: str, *args) -> None:
    """性能日志，格式与 rpa-qianniu 对齐"""
    log.info("[PERF] " + fmt, *args)


def main() -> None:
    setup_logging()
    get_selectors()

    if settings.headless:
        log.warning("当前为 headless=True；本地调试建议 PLAYWRIGHT_HEADLESS=false")

    bm = BrowserManager()
    listener = MessageListener()
    state = _load_state()
    skip_until: dict[str, float] = {}

    # 浸泡测试统计
    session_id = str(uuid.uuid4())[:8]
    start_mono = time.monotonic()
    consecutive_errors = 0
    processed_count = 0
    last_stats_time = start_mono

    try:
        page = bm.start()
        listener.attach(page)
        ensure_logged_in(bm, page)

        if not selectors_configured_for_automation():
            log.warning(
                "config/selectors.json 未配全，自动点会话/读消息/发送可能失败；"
                "请用开发者工具补齐选择器（优先 data-testid）。"
            )

        print(f"拼多多客服 RPA 已启动（headed 调试可直接看浏览器）。Ctrl+C 退出。session_id={session_id}")
        log.info("[SOAK] 启动 session_id=%s", session_id)

        while True:
            try:
                # 运行时长统计（每5分钟）
                now_mono = time.monotonic()
                elapsed_total = now_mono - start_mono
                if now_mono - last_stats_time >= _SOAK_STATS_INTERVAL_SEC:
                    log.info("[SOAK] 已运行 %.1f 分钟，已处理 %d 条消息", elapsed_total / 60, processed_count)
                    last_stats_time = now_mono

                # 连续异常熔断检查
                if consecutive_errors >= _SOAK_ERROR_THRESHOLD:
                    log.error("[SOAK] 连续异常 ≥ %d，建议检查浏览器状态，休眠 %.0f 秒", _SOAK_ERROR_THRESHOLD, _SOAK_ERROR_RESET_SEC)
                    time.sleep(_SOAK_ERROR_RESET_SEC)
                    consecutive_errors = 0  # 重置计数器，尝试恢复

                if not bm.is_page_alive():
                    log.error("页面已关闭，尝试重启浏览器")
                    _recover_browser(bm, listener)
                    consecutive_errors += 1
                    continue

                page = bm.page
                if page is None:
                    time.sleep(1.0)
                    continue

                if needs_relogin(page):
                    log.warning("检测到登录态失效或回到登录页")
                    screenshot_on_error(page, "relogin_required")
                    ensure_logged_in(bm, page)
                    listener.attach(page)
                    continue

                for hint in listener.drain():
                    t = (hint.get("text") or "").strip()
                    if t:
                        log.info("[WS 片段] %s", t[:240])

                now = time.time()
                raw_buyer = select_first_unread_session(page)
                if not raw_buyer:
                    time.sleep(settings.dom_poll_interval_sec)
                    continue

                buyer = normalize_buyer_id(raw_buyer)
                if now < skip_until.get(buyer, 0.0):
                    time.sleep(settings.dom_poll_interval_sec)
                    continue

                human_delay()

                t_round = perf_counter()

                msg, ts = read_latest_buyer_message_from_dom(page)
                if not msg:
                    log.debug("未读取到消息文本，稍后重试: buyer=%s", buyer)
                    skip_until[buyer] = time.time() + 12.0
                    time.sleep(settings.dom_poll_interval_sec)
                    continue
                if is_system_message(msg):
                    log.info("系统消息，跳过: %s", msg[:120])
                    skip_until[buyer] = time.time() + 4.0
                    time.sleep(0.5)
                    continue

                fp = fingerprint(buyer, msg, ts)
                if fp in state.dedup_set():
                    time.sleep(settings.dom_poll_interval_sec)
                    continue

                print(f"[收到] 买家: {buyer} | 消息: {msg}")
                log.info("收到 buyer=%s msg=%s", buyer, msg)

                # AI 调用（带计时）
                t_ai = perf_counter()
                conv = state.conversations.get(buyer)
                reply, new_conv, elapsed_ms, err = ai_chat(
                    buyer_id=buyer,
                    message=msg,
                    conversation_id=conv,
                )
                ai_latency_ms = int((perf_counter() - t_ai) * 1000)
                if err:
                    log.warning("AI 调用失败: %s", err)
                if new_conv:
                    state.conversations[buyer] = new_conv

                perf_log("AI调用: %d ms", ai_latency_ms)
                print(f"[AI回复] {reply} | 耗时: {elapsed_ms}ms")

                # 发送回复（带计时）
                t_send = perf_counter()
                ok = send_reply(page, reply)
                send_latency_ms = int((perf_counter() - t_send) * 1000)
                perf_log("发送回复: %d ms", send_latency_ms)

                # 总耗时
                total_latency_ms = int((perf_counter() - t_round) * 1000)
                perf_log("本轮总耗时: %d ms", total_latency_ms)

                # 确定状态并记录日志
                if ok:
                    send_status = "sent"
                    send_error = None
                    state.remember_dedup(fp)
                    _save_state(state)
                    processed_count += 1
                    consecutive_errors = 0  # 成功处理，重置异常计数
                    print(f"[已发送] 买家: {buyer}")
                    log.info("已发送 buyer=%s", buyer)
                else:
                    send_status = "send_failed"
                    send_error = "send_reply_failed"
                    screenshot_on_error(page, "send_failed")

                # 记录对话日志
                log_conversation(
                    buyer_nick=buyer or "",
                    buyer_msg=msg,
                    ai_reply=reply,
                    ai_source="stub" if settings.ai_stub_mode else "fastgpt",
                    latency_ocr_ms=0,  # pdd 不使用 OCR
                    latency_ai_ms=ai_latency_ms,
                    latency_send_ms=send_latency_ms,
                    latency_total_ms=total_latency_ms,
                    status=send_status,
                    error=send_error,
                    platform="pdd",
                    conversation_id=conv,
                    session_id=session_id,
                )

                time.sleep(settings.dom_poll_interval_sec)

            except KeyboardInterrupt:
                print("已停止")
                elapsed_total = (time.monotonic() - start_mono) / 60
                log.info("[SOAK] 退出 session_id=%s，总运行 %.1f 分钟，处理 %d 条消息", session_id, elapsed_total, processed_count)
                _save_state(state)
                return
            except Exception as exc:
                log.exception("主循环异常: %s", exc)
                consecutive_errors += 1
                try:
                    _recover_browser(bm, listener)
                except Exception as exc2:
                    log.exception("恢复浏览器失败: %s", exc2)
                    time.sleep(3.0)
    finally:
        try:
            _save_state(state)
        except Exception:
            pass
        try:
            elapsed_total = (time.monotonic() - start_mono) / 60
            log.info("[SOAK] 结束 session_id=%s，总运行 %.1f 分钟，处理 %d 条消息", session_id, elapsed_total, processed_count)
        except Exception:
            pass
        bm.close()


async def run_with_adapter() -> None:
    """
    使用 Adapter + Orchestrator 新模式运行。

    这是新架构的入口点，展示如何使用统一的 PlatformAdapter 接口。
    """
    if not _ADAPTER_AVAILABLE:
        print("[ERROR] Adapter 模式不可用，请确保已安装新架构依赖")
        sys.exit(1)

    print("[INFO] 启动 Adapter + Orchestrator 模式")
    setup_logging()

    # 创建适配器
    config = AdapterConfig(
        platform="pdd",
        poll_interval_sec=settings.dom_poll_interval_sec,
        wait_no_unread_poll_sec=5.0,
        session_cooldown_sec=12.0,
    )
    adapter = PddAdapter(config)

    # 创建编排器
    orchestrator = Orchestrator(
        adapter=adapter,
        ai_client=None,  # 使用默认 AI 客户端
        state_path=settings.state_path,
        session_cooldown_sec=12.0,
    )

    # 运行
    await orchestrator.run()


def main_entry() -> None:
    """主入口：根据配置选择运行模式。"""
    import asyncio

    # 检查是否使用新架构
    use_adapter = getattr(settings, "use_adapter_mode", False)
    if use_adapter and _ADAPTER_AVAILABLE:
        asyncio.run(run_with_adapter())
    else:
        main()


if __name__ == "__main__":
    try:
        main_entry()
    except Exception as exc:
        get_logger("main").exception("致命错误: %s", exc)
        sys.exit(1)
