from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from app.ai_client import chat as ai_chat
from app.config import settings
from app.logger import get_logger, setup_logging
from app.message_parser import (
    fingerprint_key,
    is_system_message,
    normalize_buyer_id,
)
from app.ui_selectors import get_selectors
from app.qianniu_driver import (
    human_delay,
    item_has_unread,
    list_session_list_items,
    locate_main_window_with_retry,
    read_latest_buyer_message,
    select_session,
    session_display_name,
    window_alive,
)
from app.reply_sender import send_reply

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


def _log_attempt(attempt: int, w) -> None:
    if w is None:
        subs = get_selectors().window_title_substrings
        hint = "、".join(subs) if subs else settings.qianniu_window_substring
        print(f"[定位] 第 {attempt} 次：未找到标题匹配任一子串的窗口：{hint}")
        log.info("定位尝试 %s：未找到窗口 subs=%s", attempt, subs)
    else:
        try:
            title = w.Name or ""
        except Exception:
            title = ""
        print(f"[定位] 第 {attempt} 次：已匹配窗口「{title}」")
        log.info("定位尝试 %s：匹配窗口 %s", attempt, title)


def run() -> None:
    setup_logging()
    state = _load_state()
    get_selectors()

    print("正在定位千牛主窗口（带重试）…")
    win = locate_main_window_with_retry(on_attempt=_log_attempt)
    if win is None:
        print(
            "无法定位千牛窗口。请确认已登录千牛，并检查 config/selectors.json 中 "
            "window_title_substrings（或 .env 的 QIANNIU_WINDOW_SUBSTRING）与窗口标题一致。"
        )
        log.error("千牛窗口定位失败")
        sys.exit(1)

    try:
        title = win.Name or ""
    except Exception:
        title = ""
    print(f"千牛窗口已定位，开始监听 | 标题: {title}")
    log.info("千牛窗口已定位: %s", title)

    busy = False
    skip_until: dict[str, float] = {}

    while True:
        try:
            if not window_alive(win):
                print("[窗口丢失] 尝试重新定位…")
                log.warning("窗口丢失，重新定位")
                win = locate_main_window_with_retry(on_attempt=_log_attempt)
                if win is None:
                    print("重新定位失败，5s 后再试")
                    time.sleep(5.0)
                    continue
                try:
                    title = win.Name or ""
                except Exception:
                    title = ""
                print(f"千牛窗口已恢复 | 标题: {title}")
                log.info("窗口已恢复: %s", title)

            if busy:
                time.sleep(settings.poll_interval_sec)
                continue

            items = list_session_list_items(win)
            unread = [it for it in items if item_has_unread(it)]

            if not unread:
                time.sleep(settings.poll_interval_sec)
                continue

            now = time.time()
            target = None
            for it in unread:
                bid = normalize_buyer_id(session_display_name(it))
                if now < skip_until.get(bid, 0.0):
                    continue
                target = it
                break
            if target is None:
                time.sleep(settings.poll_interval_sec)
                continue

            busy = True
            try:
                name = session_display_name(target)
                buyer_id = normalize_buyer_id(name)
                select_session(target)

                if not window_alive(win):
                    continue

                msg, ts_token = read_latest_buyer_message(win)
                if not msg:
                    log.debug("未解析到买家消息，跳过: buyer=%s", buyer_id)
                    skip_until[buyer_id] = time.time() + 12.0
                    continue
                if is_system_message(msg):
                    log.info("系统消息，跳过 AI: %s", msg[:80])
                    skip_until[buyer_id] = time.time() + 4.0
                    continue

                fp = fingerprint_key(buyer_id, msg, ts_token)
                if fp in state.dedup_set():
                    log.debug("去重命中，跳过: %s", fp[:120])
                    continue

                print(f"[收到] 买家ID: {buyer_id} | 消息: {msg}")
                log.info("收到消息 buyer=%s text=%s", buyer_id, msg)

                conv_id = state.conversations.get(buyer_id)
                reply, new_conv, elapsed_ms = ai_chat(
                    buyer_id=buyer_id,
                    message=msg,
                    conversation_id=conv_id,
                )
                if new_conv:
                    state.conversations[buyer_id] = new_conv

                print(f"[AI回复] {reply} | 耗时: {elapsed_ms}ms")
                log.info("AI 回复 buyer=%s ms=%s", buyer_id, elapsed_ms)

                human_delay()
                ok = send_reply(win, reply)
                if ok:
                    state.remember_dedup(fp)
                    _save_state(state)
                    print(f"[已发送] 买家ID: {buyer_id}")
                    log.info("已发送 buyer=%s", buyer_id)
                else:
                    log.warning("发送失败，不入去重集，下次可重试")
            finally:
                busy = False

            time.sleep(settings.poll_interval_sec)
        except KeyboardInterrupt:
            print("已停止")
            log.info("用户中断")
            _save_state(state)
            return
        except Exception as exc:
            log.exception("主循环异常: %s", exc)
            time.sleep(max(1.0, settings.poll_interval_sec))


if __name__ == "__main__":
    run()
