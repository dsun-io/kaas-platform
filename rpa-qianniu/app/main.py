from __future__ import annotations

import json
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from app.ai_client import chat as ai_chat
from app.config import settings
from app.logger import get_logger, setup_logging
from app.hotkeys import start_f12_pause_toggle
from app.message_parser import (
    fingerprint_key,
    has_substantive_buyer_text,
    is_non_message_ui_text,
    is_system_message,
    normalize_buyer_id,
)
from app.chat_ocr_flow import get_chat_ocr_context, invalidate_chat_ocr_context
from app.ui_selectors import get_selectors
from app.qianniu_driver import (
    capture_window_frame_bgr,
    guess_active_buyer_title,
    human_delay,
    item_has_unread,
    list_session_list_items,
    locate_main_window_with_retry,
    read_latest_buyer_message_hybrid,
    select_session,
    session_display_name,
    window_alive,
)
from app.vision_markers import vision_available
from app.reply_sender import send_reply
from app.debug_unread_probe import run_unread_probe

log = get_logger("main")

_MAX_DEDUP = 5000


@dataclass
class AppState:
    conversations: dict[str, str] = field(default_factory=dict)
    dedup_keys: list[str] = field(default_factory=list)
    # 已成功处理过的「买家回合」指纹（正文+时间+气泡Y）；同句新发时间与/或 Y 会变，可与仅打开会话区分
    last_replied_fingerprint: dict[str, str] = field(default_factory=dict)

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
        lrf = raw.get("last_replied_fingerprint") or {}
        if not isinstance(conv, dict):
            conv = {}
        if not isinstance(keys, list):
            keys = []
        if not isinstance(lrf, dict):
            lrf = {}
        return AppState(
            conversations={str(k): str(v) for k, v in conv.items()},
            dedup_keys=[str(x) for x in keys][-_MAX_DEDUP:],
            last_replied_fingerprint={str(k): str(v) for k, v in lrf.items()},
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
        "last_replied_fingerprint": st.last_replied_fingerprint,
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
    if settings.debug_unread_probe:
        run_unread_probe(win)
    if settings.ai_stub_mode:
        print(f"[桩模式] 已关闭对 FastGPT 的调用，回复固定为：{settings.ai_stub_reply!r}（.env 设 AI_STUB_MODE=false 可恢复）")
        log.info("AI 桩模式开启 stub_reply=%s", settings.ai_stub_reply)

    paused = threading.Event()
    if start_f12_pause_toggle(paused):
        print("快捷键：按 F12 暂停/继续自动回复（全局有效）")
    else:
        print("提示：执行 pip install pynput 后可使用 F12 暂停/继续")

    busy = False
    skip_until: dict[str, float] = {}
    wait_hint_ts = 0.0
    _WAIT_HINT_INTERVAL_SEC = 25.0
    # 兜底读当前会话时：同一买家指纹首次出现时间（monotonic），用于「非新消息」超时丢弃
    fallback_fp_first_mono: dict[str, tuple[str, float]] = {}

    while True:
        try:
            if paused.is_set():
                time.sleep(0.2)
                continue

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
                time.sleep(max(3.0, float(settings.poll_interval_sec)))
                continue

            items = list_session_list_items(win)
            vision_frame = None
            if settings.vision_unread_enabled and vision_available():
                vision_frame = capture_window_frame_bgr(win)
            unread = [it for it in items if item_has_unread(win, it, vision_frame)]

            now = time.time()
            target = None
            buyer_id = None
            active_fallback_msg: tuple[str | None, str | None, float | None] | None = None

            for it in unread:
                bid = normalize_buyer_id(session_display_name(it))
                if now < skip_until.get(bid, 0.0):
                    continue
                target = it
                buyer_id = bid
                break

            if target is None:
                if not settings.fallback_open_chat_without_unread:
                    if now - wait_hint_ts >= _WAIT_HINT_INTERVAL_SEC:
                        print(
                            "[监听] 左侧列表无未读；仅等待红点/角标（未开启「无未读仍读当前会话」）。"
                            "若你依赖打开会话即回复，可在 .env 设 FALLBACK_OPEN_CHAT_WITHOUT_UNREAD=true。"
                        )
                        wait_hint_ts = now
                    time.sleep(
                        max(3.0, float(settings.wait_no_unread_poll_sec))
                    )
                    continue

                buyer_guess0 = normalize_buyer_id(guess_active_buyer_title(win))
                ctx0 = get_chat_ocr_context(win, buyer_guess0, force_new=False)
                msg_fb, ts_fb, y_fb = read_latest_buyer_message_hybrid(win, ctx0)
                msg_fb = (msg_fb or "").strip()
                if (
                    msg_fb
                    and has_substantive_buyer_text(msg_fb)
                    and not is_non_message_ui_text(msg_fb)
                    and not is_system_message(msg_fb)
                ):
                    buyer_guess = normalize_buyer_id(guess_active_buyer_title(win))
                    fp_fb = fingerprint_key(buyer_guess, msg_fb, ts_fb, y_fb)
                    if (
                        state.last_replied_fingerprint.get(buyer_guess) == fp_fb
                        or fp_fb in state.dedup_set()
                    ):
                        pass
                    elif now >= skip_until.get(buyer_guess, 0.0):
                        mono = time.monotonic()
                        st = fallback_fp_first_mono.get(buyer_guess)
                        if st is None or st[0] != fp_fb:
                            fallback_fp_first_mono[buyer_guess] = (fp_fb, mono)
                            active_fallback_msg = (msg_fb, ts_fb, y_fb)
                            buyer_id = buyer_guess
                        else:
                            _fp0, t0 = st
                            age = mono - t0
                            if age <= float(settings.fallback_stale_fingerprint_sec):
                                active_fallback_msg = (msg_fb, ts_fb, y_fb)
                                buyer_id = buyer_guess
                            else:
                                log.debug(
                                    "兜底：指纹过久未变，视为历史气泡跳过 buyer=%s age=%.1fs",
                                    buyer_guess,
                                    age,
                                )
                if active_fallback_msg is None:
                    if now - wait_hint_ts >= _WAIT_HINT_INTERVAL_SEC:
                        try:
                            g = guess_active_buyer_title(win)
                        except Exception:
                            g = ""
                        g = (g or "").strip()
                        if g and g != "active_chat":
                            print(f"[监听] 当前：{g}；等待未读或新消息。")
                        else:
                            print("[监听] 等待左侧未读或新消息。")
                        wait_hint_ts = now
                    time.sleep(
                        max(3.0, float(settings.wait_no_unread_poll_sec))
                    )
                    continue

            busy = True
            try:
                if target is not None:
                    name = session_display_name(target)
                    buyer_id = normalize_buyer_id(name)
                    select_session(target)
                    invalidate_chat_ocr_context()

                if not window_alive(win):
                    continue

                ocr_ctx = get_chat_ocr_context(win, buyer_id or "", force_new=False)

                if active_fallback_msg is not None:
                    msg, ts_token, anchor_y = active_fallback_msg
                    log.info("左侧列表未识别未读，改用当前已打开会话兜底 buyer=%s", buyer_id)
                else:
                    msg, ts_token, anchor_y = read_latest_buyer_message_hybrid(win, ocr_ctx)
                msg = (msg or "").strip()
                if not msg or is_non_message_ui_text(msg):
                    log.debug("无有效买家正文，跳过: buyer=%s", buyer_id)
                    skip_until[buyer_id] = time.time() + 3.0
                    continue
                if is_system_message(msg):
                    log.info("系统消息，跳过 AI: %s", msg[:80])
                    skip_until[buyer_id] = time.time() + 4.0
                    continue
                if not has_substantive_buyer_text(msg):
                    log.debug("无实质正文，跳过 AI: buyer=%s raw=%r", buyer_id, msg[:80])
                    skip_until[buyer_id] = time.time() + 3.0
                    continue

                fp = fingerprint_key(buyer_id, msg, ts_token, anchor_y)
                if state.last_replied_fingerprint.get(buyer_id) == fp:
                    log.debug(
                        "当前气泡与已处理回合指纹相同（时间/位置未变），跳过 buyer=%s",
                        buyer_id,
                    )
                    continue
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
                panel = ocr_ctx.panel if ocr_ctx is not None else None
                ok = send_reply(win, reply, chat_panel=panel)
                if ok:
                    state.remember_dedup(fp)
                    state.last_replied_fingerprint[buyer_id] = fp
                    _save_state(state)
                    print(f"[已发送] 买家ID: {buyer_id}（已通过输入框读回校验）")
                    log.info("已发送 buyer=%s", buyer_id)
                else:
                    print(
                        "[发送失败] 未写入或未清空输入框，未记入去重，将自动重试；"
                        "请保持「接待中心」在前台并避免遮挡输入区。"
                    )
                    log.warning("发送失败，不入去重集，下次可重试")
                    if settings.chat_ocr_enabled:
                        print(
                            "提示：若反复失败可设 CHAT_OCR_ENABLED=false 回退纯 UIA；"
                            "排查时可设 CHAT_DEBUG_SCREENSHOTS=true 查看 data/debug_chat。"
                        )
            finally:
                busy = False

            time.sleep(max(3.0, float(settings.poll_interval_sec)))
        except KeyboardInterrupt:
            print("已停止")
            log.info("用户中断")
            _save_state(state)
            return
        except Exception as exc:
            log.exception("主循环异常: %s", exc)
            time.sleep(max(3.0, float(settings.poll_interval_sec)))


if __name__ == "__main__":
    run()
