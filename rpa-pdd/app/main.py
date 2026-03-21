from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from app.ai_client import chat as ai_chat
from app.browser_manager import BrowserManager, screenshot_on_error
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

log = get_logger("main")

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


def main() -> None:
    setup_logging()
    get_selectors()

    if settings.headless:
        log.warning("当前为 headless=True；本地调试建议 PLAYWRIGHT_HEADLESS=false")

    bm = BrowserManager()
    listener = MessageListener()
    state = _load_state()
    skip_until: dict[str, float] = {}

    try:
        page = bm.start()
        listener.attach(page)
        ensure_logged_in(bm, page)

        if not selectors_configured_for_automation():
            log.warning(
                "config/selectors.json 未配全，自动点会话/读消息/发送可能失败；"
                "请用开发者工具补齐选择器（优先 data-testid）。"
            )

        print("拼多多客服 RPA 已启动（headed 调试可直接看浏览器）。Ctrl+C 退出。")

        while True:
            try:
                if not bm.is_page_alive():
                    log.error("页面已关闭，尝试重启浏览器")
                    _recover_browser(bm, listener)
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

                conv = state.conversations.get(buyer)
                reply, new_conv, elapsed_ms = ai_chat(
                    buyer_id=buyer,
                    message=msg,
                    conversation_id=conv,
                )
                if new_conv:
                    state.conversations[buyer] = new_conv

                print(f"[AI回复] {reply} | 耗时: {elapsed_ms}ms")

                ok = send_reply(page, reply)
                if ok:
                    state.remember_dedup(fp)
                    _save_state(state)
                    print(f"[已发送] 买家: {buyer}")
                    log.info("已发送 buyer=%s", buyer)
                else:
                    screenshot_on_error(page, "send_failed")

                time.sleep(settings.dom_poll_interval_sec)

            except KeyboardInterrupt:
                print("已停止")
                _save_state(state)
                return
            except Exception as exc:
                log.exception("主循环异常: %s", exc)
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
        bm.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        get_logger("main").exception("致命错误: %s", exc)
        sys.exit(1)
