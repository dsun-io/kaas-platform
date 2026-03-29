"""
千牛 RPA 主程序。

支持两种运行模式：
1. 传统模式（默认）：直接使用 driver 函数
2. Adapter + Orchestrator 模式（新架构）：通过 adapter_base.py 实现

切换方式：在 .env 中设置 USE_ADAPTER_MODE=true
"""

from __future__ import annotations

import json
import logging
import signal
import sys
import threading
import time
import uuid
from time import perf_counter
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
    locate_window_title_hint,
    read_latest_buyer_message_hybrid,
    select_session,
    session_display_name,
    window_alive,
)
from app.vision_markers import vision_available
from app.reply_sender import send_reply
from app.debug_cleanup import maybe_cleanup
from app.debug_unread_probe import run_unread_probe
from app.chat_logger import log_conversation
from app.rpa_lock import acquire_lock

# 新架构导入（可选）
try:
    from app.adapter import QianniuAdapter
    from app.models import AdapterConfig, Reply
    from app.orchestrator import Orchestrator
    _ADAPTER_AVAILABLE = True
except ImportError:
    _ADAPTER_AVAILABLE = False

log = get_logger("main")

_MAX_DEDUP = 5000

# 浸泡测试配置
_SOAK_ERROR_THRESHOLD = 10  # 连续异常阈值
_SOAK_ERROR_RESET_SEC = 30.0  # 触发熔断后的长等待
_SOAK_STATS_INTERVAL_SEC = 300.0  # 5分钟统计间隔


def _fuzzy_text_match(a: str, b: str, threshold: int = 3) -> bool:
    """两段文本前 N 字符相同，或编辑距离 <= threshold 时视为匹配。"""
    a, b = (a or "").strip(), (b or "").strip()
    if not a or not b:
        return False
    # 快速路径：前 20 字符相同
    if a[:20] == b[:20]:
        return True
    # 编辑距离（仅在文本较短时计算，避免性能问题）
    if max(len(a), len(b)) > 200:
        return a[:50] == b[:50]
    if abs(len(a) - len(b)) > threshold:
        return False
    # 简化 Levenshtein
    if len(a) > len(b):
        a, b = b, a
    prev = list(range(len(a) + 1))
    for j in range(1, len(b) + 1):
        curr = [j] + [0] * len(a)
        for i in range(1, len(a) + 1):
            cost = 0 if a[i-1] == b[j-1] else 1
            curr[i] = min(curr[i-1]+1, prev[i]+1, prev[i-1]+cost)
        prev = curr
    return prev[-1] <= threshold


import re as _re

_TS_PREFIX_RE = _re.compile(
    r"^.*?\d{4}-\d{1,2}-\d{1,2}\s*\d{1,2}:\d{2}(?::\d{2})?\s*"
)


def _normalize_msg_for_dedup(msg: str, buyer_id: str) -> str:
    """去除消息开头的昵称+时间戳前缀，留下纯正文。"""
    t = (msg or "").strip()
    # 去除开头的 buyer_id 昵称
    bid = (buyer_id or "").strip()
    if bid and t.startswith(bid):
        t = t[len(bid):].strip()
    # 去除开头的时间戳模式
    t = _TS_PREFIX_RE.sub("", t).strip()
    # 去除开头的换行符
    t = t.lstrip("\n").strip()
    return t if t else (msg or "").strip()


def perf_log(msg: str, *args: object) -> None:
    """[PERF] 专用：仅刷新控制台 handler，避免高频文件 I/O。"""
    log.info(msg, *args)
    for h in logging.root.handlers:
        if not isinstance(h, logging.StreamHandler):
            continue
        stream = getattr(h, "stream", None)
        if stream not in (sys.stdout, sys.stderr):
            continue
        try:
            h.flush()
        except Exception:
            pass


_shutdown_requested = threading.Event()
_WIN_CONSOLE_HANDLER: object | None = None


def request_shutdown(signum: int | None = None, frame: object | None = None) -> None:
    if _shutdown_requested.is_set():
        return
    _shutdown_requested.set()
    print("\n[INFO] 收到停止信号，正在退出…", flush=True)


def _sleep_until_shutdown(max_sec: float, *, step: float = 0.25) -> bool:
    """分片睡眠以便尽快响应退出；若期间请求退出则返回 True。"""
    deadline = time.monotonic() + max_sec
    while time.monotonic() < deadline:
        if _shutdown_requested.is_set():
            return True
        rem = deadline - time.monotonic()
        if rem <= 0:
            break
        time.sleep(min(step, rem))
    return _shutdown_requested.is_set()


def _install_shutdown_handlers() -> None:
    global _WIN_CONSOLE_HANDLER

    signal.signal(signal.SIGINT, request_shutdown)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, request_shutdown)  # type: ignore[arg-type]
    if sys.platform == "win32" and hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, request_shutdown)  # type: ignore[arg-type]

    if sys.platform == "win32":
        try:
            import ctypes

            @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_uint)
            def _on_console(ctrl: int) -> bool:
                if ctrl in (0, 1, 2):
                    request_shutdown()
                    return True
                return False

            _WIN_CONSOLE_HANDLER = _on_console
            ctypes.windll.kernel32.SetConsoleCtrlHandler(_WIN_CONSOLE_HANDLER, True)
        except Exception:
            pass


@dataclass
class AppState:
    conversations: dict[str, str] = field(default_factory=dict)
    dedup_keys: list[str] = field(default_factory=list)
    # 已成功处理过的「买家回合」指纹（正文+时间+气泡Y）；同句新发时间与/或 Y 会变，可与仅打开会话区分
    last_replied_fingerprint: dict[str, str] = field(default_factory=dict)
    # 纯视觉：各买家上次成功回复的 monotonic 时间戳（会话冷却）
    vision_last_reply_mono: dict[str, float] = field(default_factory=dict)
    # 各买家的对话轮次计数器（用于多轮对话日志记录）
    round_counters: dict[str, int] = field(default_factory=dict)
    # 各买家上次回复的消息原文（用于模糊去重，应对OCR漂移）
    last_replied_text: dict[str, str] = field(default_factory=dict)

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
        vlr = raw.get("vision_last_reply_mono") or {}
        rc = raw.get("round_counters") or {}  # 兼容旧状态文件
        lrt = raw.get("last_replied_text") or {}  # 新增：上次回复的消息原文
        if not isinstance(conv, dict):
            conv = {}
        if not isinstance(keys, list):
            keys = []
        if not isinstance(lrf, dict):
            lrf = {}
        if not isinstance(vlr, dict):
            vlr = {}
        if not isinstance(rc, dict):
            rc = {}
        if not isinstance(lrt, dict):
            lrt = {}
        return AppState(
            conversations={str(k): str(v) for k, v in conv.items()},
            dedup_keys=[str(x) for x in keys][-_MAX_DEDUP:],
            last_replied_fingerprint={str(k): str(v) for k, v in lrf.items()},
            vision_last_reply_mono={
                str(k): float(v) for k, v in vlr.items() if isinstance(v, (int, float))
            },
            round_counters={str(k): int(v) for k, v in rc.items() if isinstance(v, (int, float))},
            last_replied_text={str(k): str(v) for k, v in lrt.items()},
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
        "vision_last_reply_mono": st.vision_last_reply_mono,
        "round_counters": st.round_counters,
        "last_replied_text": st.last_replied_text,  # 新增：上次回复的消息原文
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


def _run_vision_pipeline(state: AppState) -> None:
    """CEF 场景：仅用 uiautomation 取窗口矩形，其余截图 + OCR + pyautogui。"""
    import pyautogui
    from app.ocr_paddle import invalidate_ocr_cache, paddle_available
    from app.qianniu_driver import (
        capture_window_frame_bgr,
        human_delay,
        locate_main_window_with_retry,
        window_alive,
    )
    from app.vision_debug import save_debug_bgr, sleep_after_capture
    from app.vision_layout import build_vision_layout, rect_from_window
    from app.vision_message import (
        extract_buyer_nick_from_right_panel,
        extract_latest_buyer_message,
    )
    from app.vision_reply import send_reply_vision
    from app.vision_unread import (
        align_win_rect_to_screenshot_origin,
        find_pending_session,
        get_screenshot_origin,
    )

    if not paddle_available():
        print(
            "纯视觉模式需要 PaddleOCR。请安装: pip install paddleocr paddlepaddle\n"
            "或改用旧版：在 .env 设 LEGACY_UIA_PIPELINE=true"
        )
        log.error("PaddleOCR 不可用，无法启动纯视觉流水线")
        sys.exit(1)

    print("正在定位千牛主窗口（仅用语义矩形）…")
    win = locate_main_window_with_retry(on_attempt=_log_attempt)
    if win is None:
        print("无法定位千牛窗口。")
        print(locate_window_title_hint())
        sys.exit(1)
    try:
        title = win.Name or ""
    except Exception:
        title = ""
    print(f"[纯视觉] 窗口: {title}")
    log.info("纯视觉流水线启动: %s", title)

    if settings.ai_stub_mode:
        print(f"[桩模式] 回复固定为：{settings.ai_stub_reply!r}")

    paused = threading.Event()
    if start_f12_pause_toggle(paused):
        print("快捷键：F12 暂停/继续")
    wait_hint_ts = 0.0
    _WAIT_HINT_INTERVAL_SEC = 25.0
    _vision_skip_log_ts: dict[str, float] = {}
    _active_sleep = max(0.05, float(settings.vision_poll_active_sec))

    # 浸泡测试统计
    session_id = str(uuid.uuid4())[:8]
    start_mono = time.monotonic()
    consecutive_errors = 0
    processed_count = 0
    last_stats_time = start_mono
    log.info("[SOAK] 纯视觉流水线启动 session_id=%s", session_id)

    def _vision_skip(reason: str, *, interval_sec: float = 14.0) -> None:
        """节流 INFO，避免刷屏；便于排查「只截图不回复」。"""
        now = time.monotonic()
        if now - _vision_skip_log_ts.get(reason, 0.0) < interval_sec:
            return
        _vision_skip_log_ts[reason] = now
        log.info("[vision跳过] %s", reason)

    try:
        while not _shutdown_requested.is_set():
            try:
                maybe_cleanup()
                if paused.is_set():
                    if _sleep_until_shutdown(0.2):
                        break
                    continue
                if not window_alive(win):
                    log.warning("窗口丢失，重新定位")
                    consecutive_errors += 1
                    win = locate_main_window_with_retry(on_attempt=_log_attempt)
                    if win is None:
                        if _sleep_until_shutdown(5.0):
                            break
                        continue
                    consecutive_errors = 0  # 成功恢复，重置异常计数

                t_round = perf_counter()
                t_cap = perf_counter()
                bgr = capture_window_frame_bgr(win)
                if bgr is None or bgr.size == 0:
                    if _sleep_until_shutdown(1.0):
                        break
                    continue

                perf_log("[PERF] 截图: %.3fs", perf_counter() - t_cap)

                t_lay = perf_counter()
                wr_uia = rect_from_window(win)
                hwnd = int(getattr(win, "NativeWindowHandle", None) or 0)
                win_rect = align_win_rect_to_screenshot_origin(wr_uia, hwnd)
                if hwnd:
                    try:
                        ox, oy = get_screenshot_origin(hwnd)
                        log.info(
                            "[COORD] GetWindowRect=(%s,%s) screenshot_origin=(%s,%s) offset=(%s,%s)",
                            wr_uia.left,
                            wr_uia.top,
                            ox,
                            oy,
                            ox - wr_uia.left,
                            oy - wr_uia.top,
                        )
                    except Exception as exc:
                        log.debug("[COORD] 跳过: %s", exc)
                lay = build_vision_layout(win_rect, bgr)
                save_debug_bgr(
                    bgr,
                    "vision_full_window",
                    min_interval_sec=float(settings.vision_debug_full_window_interval_sec),
                )
                perf_log("[PERF] 布局/校准: %.3fs", perf_counter() - t_lay)

                t1 = perf_counter()
                pending = find_pending_session(bgr, win_rect, lay.left_panel, hwnd)
                dt_red = perf_counter() - t1
                print(
                    f"[纯视觉] 会话检测: {'待回复' if pending else '无'}（{dt_red:.2f}s）",
                    flush=True,
                )
                msg: str | None = None
                buyer_id: str | None = None
                _ts = ""
                ocr_ms_for_log = 0

                if pending:
                    perf_log("[PERF] 会话检测: %.3fs", dt_red)
                    click_sx, click_sy = pending
                    log.info("[点击] 待回复会话 屏幕=(%s,%s)", click_sx, click_sy)
                    pyautogui.click(click_sx, click_sy)
                    sleep_after_capture()
                    # 使用配置的会话切换等待时间（默认 1.5s，可配置以适配不同机器渲染速度）
                    if _sleep_until_shutdown(float(settings.vision_session_switch_wait_sec)):
                        break
                    invalidate_ocr_cache()
                    bgr = capture_window_frame_bgr(win)
                    if bgr is None or bgr.size == 0:
                        if _sleep_until_shutdown(_active_sleep):
                            break
                        continue
                    wr2 = rect_from_window(win)
                    win_rect = align_win_rect_to_screenshot_origin(wr2, hwnd)
                    lay = build_vision_layout(win_rect, bgr)
                    save_debug_bgr(bgr, "vision_after_click_session")
                    buyer_id = normalize_buyer_id("unknown_buyer")
                    t_ocr = perf_counter()
                    _raw = extract_latest_buyer_message(bgr, win_rect, lay.message_area)
                    ocr_sec = perf_counter() - t_ocr
                    ocr_ms_for_log = int(ocr_sec * 1000)
                    perf_log("[PERF] OCR提取: %.3fs", ocr_sec)
                    msg = (_raw.get("text") or "").strip() if _raw else ""
                    _ts = (_raw.get("timestamp") or "").strip() if _raw else ""
                elif settings.fallback_open_chat_without_unread:
                    perf_log("[PERF] 会话检测: %.3fs (无待回复,兜底读会话)", dt_red)
                    buyer_id = normalize_buyer_id("vision_active")
                    t_ocr = perf_counter()
                    _raw = extract_latest_buyer_message(bgr, win_rect, lay.message_area)
                    ocr_sec = perf_counter() - t_ocr
                    ocr_ms_for_log = int(ocr_sec * 1000)
                    perf_log("[PERF] OCR提取: %.3fs", ocr_sec)
                    msg = (_raw.get("text") or "").strip() if _raw else ""
                    _ts = (_raw.get("timestamp") or "").strip() if _raw else ""
                else:
                    perf_log("[PERF] 会话检测: %.3fs (无待回复)", dt_red)
                    perf_log("[PERF] 本轮总耗时: %.3fs", perf_counter() - t_round)
                    now = time.time()
                    if now - wait_hint_ts >= _WAIT_HINT_INTERVAL_SEC:
                        print("[纯视觉] 无待回复会话；未开启兜底则仅等待。可设 FALLBACK_OPEN_CHAT_WITHOUT_UNREAD=true")
                        wait_hint_ts = now
                    if _sleep_until_shutdown(max(3.0, float(settings.wait_no_unread_poll_sec))):
                        break
                    continue

                nick_hdr = extract_buyer_nick_from_right_panel(
                    bgr, win_rect, lay.right_panel
                )
                buyer_id_source = "right_panel"  # 默认来源
                if (nick_hdr or "").strip():
                    buyer_id = normalize_buyer_id(nick_hdr.strip())
                else:
                    # 右侧面板昵称提取失败，基于时间戳生成唯一临时 ID
                    # 避免多个不同买家共享 "unknown_buyer" 导致上下文串台
                    buyer_id = normalize_buyer_id(f"anonymous_{int(time.time())}")
                    buyer_id_source = "anonymous_fallback"

                msg = (msg or "").strip()
                if not msg:
                    _vision_skip(
                        "message_area 未解析到买家正文（OCR 空或左右判定全为客服侧）；"
                        "请 smoke_vision_regions.py --mode message 看绿框是否盖住买家气泡",
                    )
                    if _sleep_until_shutdown(_active_sleep):
                        break
                    continue
                if is_non_message_ui_text(msg) or is_system_message(msg):
                    _vision_skip(f"系统/占位/订单噪声，跳过: {msg[:100]!r}")
                    if _sleep_until_shutdown(_active_sleep):
                        break
                    continue
                if not has_substantive_buyer_text(msg):
                    _vision_skip(f"正文过短或无中英数字，跳过: {msg[:100]!r}")
                    if _sleep_until_shutdown(_active_sleep):
                        break
                    continue

                # 兜底 buyer=vision_active 时冷却会挡住「同窗口」连续新消息；仅对 OCR 到昵称的会话做冷却
                _fallback_buyer = normalize_buyer_id("vision_active")
                if buyer_id and buyer_id != _fallback_buyer:
                    lm = state.vision_last_reply_mono.get(buyer_id, 0.0)
                    cd = float(settings.vision_session_cooldown_sec)
                    if lm > 0 and (time.monotonic() - lm) < cd:
                        _vision_skip(
                            f"会话冷却中 buyer={buyer_id!r}（{cd:.0f}s 内不重复处理）",
                            interval_sec=20.0,
                        )
                        if _sleep_until_shutdown(_active_sleep):
                            break
                        continue

                fp = fingerprint_key(buyer_id or "unknown", msg, _ts or None, None)
                # 当 buyer_id 为 unknown_buyer 时，跳过 last_replied_fingerprint 检查
                # 避免多个不同买家都被当作 "unknown_buyer" 而误判为已回复
                _unknown_buyer_id = normalize_buyer_id("unknown_buyer")
                is_unknown_buyer = buyer_id == _unknown_buyer_id
                fingerprint_matched = (
                    not is_unknown_buyer and state.last_replied_fingerprint.get(buyer_id or "") == fp
                )
                if fingerprint_matched or fp in state.dedup_set():
                    _vision_skip(
                        f"去重：本条与已回复指纹相同 buyer={buyer_id!r} msg[:40]={msg[:40]!r}…",
                        interval_sec=18.0,
                    )
                    if _sleep_until_shutdown(_active_sleep):
                        break
                    continue

                # 文本模糊去重：OCR 每帧微小差异不应触发重新回复
                last_text = state.last_replied_text.get(buyer_id or "")
                if last_text and _fuzzy_text_match(
                    _normalize_msg_for_dedup(last_text, buyer_id or ""),
                    _normalize_msg_for_dedup(msg, buyer_id or ""),
                ):
                    _vision_skip(
                        f"模糊去重：消息与上次回复内容高度相似 buyer={buyer_id!r}",
                        interval_sec=18.0,
                    )
                    if _sleep_until_shutdown(_active_sleep):
                        break
                    continue

                print(f"[收到] 买家ID: {buyer_id} | 消息: {msg}")
                log.info("收到 vision buyer=%s text=%s", buyer_id, msg)

                conv_id = state.conversations.get(buyer_id or "")
                t_ai = perf_counter()
                reply, new_conv, elapsed_ms, ai_err = ai_chat(
                    buyer_id=buyer_id or "unknown",
                    message=msg,
                    conversation_id=conv_id,
                )
                perf_log(
                    "[PERF] FastGPT调用: %.3fs（接口报告=%sms）",
                    perf_counter() - t_ai,
                    elapsed_ms,
                )
                if new_conv and buyer_id:
                    state.conversations[buyer_id] = new_conv
                print(f"[AI回复] {reply} | 耗时: {elapsed_ms}ms")

                t_send = perf_counter()
                human_delay()
                bgr_send = capture_window_frame_bgr(win)
                win_rect = align_win_rect_to_screenshot_origin(
                    rect_from_window(win), hwnd
                )
                lay = build_vision_layout(win_rect, bgr_send)
                save_debug_bgr(bgr_send, "vision_before_send")
                ok = False
                if bgr_send is not None and bgr_send.size > 0:
                    ok = send_reply_vision(
                        bgr_send,
                        win_rect,
                        lay.input_area,
                        reply,
                        send_button_screen=lay.send_button_center_screen,
                    )
                t_after_send = perf_counter()
                perf_log("[PERF] 输入发送: %.3fs", t_after_send - t_send)
                send_ms = int((t_after_send - t_send) * 1000)
                t_total_end = perf_counter()
                perf_log("[PERF] 本轮总耗时: %.3fs", t_total_end - t_round)
                total_ms = int((t_total_end - t_round) * 1000)

                if not ok:
                    send_status = "send_failed"
                    send_error = "send_reply_vision_failed"
                elif ai_err:
                    send_status = "ai_failed"
                    send_error = ai_err
                else:
                    send_status = "sent"
                    send_error = None
                # 获取或创建 conversation_id
                conv_id = state.conversations.get(buyer_id or "")
                # 获取并递增 round_index
                current_round = state.round_counters.get(buyer_id, 0) + 1
                log_conversation(
                    buyer_nick=buyer_id or "",
                    buyer_msg=msg,
                    ai_reply=reply,
                    ai_source="stub" if settings.ai_stub_mode else "fastgpt",
                    latency_ocr_ms=ocr_ms_for_log,
                    latency_ai_ms=int(elapsed_ms),
                    latency_send_ms=send_ms,
                    latency_total_ms=total_ms,
                    tokens_in=None,
                    tokens_out=None,
                    status=send_status,
                    error=send_error,
                    conversation_id=conv_id,
                    round_index=current_round,
                    buyer_id_source=buyer_id_source,
                    session_id=session_id,
                )

                if ok:
                    state.remember_dedup(fp)
                    processed_count += 1
                    consecutive_errors = 0  # 成功处理，重置异常计数
                    if buyer_id:
                        # 仅当 buyer_id 不是 unknown_buyer 时才保存 fingerprint
                        # 避免多个不同买家都被当作 unknown_buyer 处理
                        if buyer_id != normalize_buyer_id("unknown_buyer"):
                            state.last_replied_fingerprint[buyer_id] = fp
                        if buyer_id != normalize_buyer_id("vision_active"):
                            state.vision_last_reply_mono[buyer_id] = time.monotonic()
                        # 更新 round_counters（多轮对话计数）
                        state.round_counters[buyer_id] = current_round
                        # 记录上次回复的消息原文（用于模糊去重）
                        state.last_replied_text[buyer_id] = msg
                    _save_state(state)
                    print(f"[已发送] 买家ID: {buyer_id}")
                    try:
                        bgr_ok = capture_window_frame_bgr(win)
                        save_debug_bgr(bgr_ok, "vision_after_send", event_type="send_success")
                    except Exception:
                        pass
                    # 回复后等待千牛 UI 刷新，让会话从「待回复」移走
                    if _sleep_until_shutdown(2.0):
                        break
                else:
                    print("[发送失败] 请保持接待中心在前台；可查看 debug/ 下截图")
                    save_debug_bgr(bgr_send, "vision_send_fail", event_type="error")

                if _sleep_until_shutdown(_active_sleep):
                    break
            except KeyboardInterrupt:
                request_shutdown()
                print("已停止", flush=True)
                break
            except Exception as exc:
                log.exception("纯视觉主循环异常: %s", exc)
                consecutive_errors += 1
                try:
                    bgr_err = capture_window_frame_bgr(win)
                    save_debug_bgr(bgr_err, "vision_loop_error", event_type="error")
                except Exception:
                    pass
                if _sleep_until_shutdown(max(3.0, float(settings.poll_interval_sec))):
                    break
    finally:
        elapsed_total = (time.monotonic() - start_mono) / 60
        log.info("[SOAK] 纯视觉流水线结束 session_id=%s，总运行 %.1f 分钟，处理 %d 条消息", session_id, elapsed_total, processed_count)
        print("[INFO] 正在保存状态…", flush=True)
        try:
            _save_state(state)
        except Exception as save_exc:
            log.warning("退出时保存状态失败: %s", save_exc)
        print("[INFO] 已安全退出。", flush=True)


def _run_legacy_uia(state: AppState) -> None:
    print("正在定位千牛主窗口（带重试）…")
    win = locate_main_window_with_retry(on_attempt=_log_attempt)
    if win is None:
        print("无法定位千牛窗口。")
        print(locate_window_title_hint())
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

    # 浸泡测试统计
    session_id = str(uuid.uuid4())[:8]
    start_mono = time.monotonic()
    consecutive_errors = 0
    processed_count = 0
    last_stats_time = start_mono
    log.info("[SOAK] Legacy UIA 流水线启动 session_id=%s", session_id)

    try:
        while not _shutdown_requested.is_set():
            try:
                # 运行时长统计（每5分钟）
                now_mono = time.monotonic()
                elapsed_total = now_mono - start_mono
                if now_mono - last_stats_time >= _SOAK_STATS_INTERVAL_SEC:
                    log.info("[SOAK] 已运行 %.1f 分钟，已处理 %d 条消息", elapsed_total / 60, processed_count)
                    last_stats_time = now_mono

                # 连续异常熔断检查
                if consecutive_errors >= _SOAK_ERROR_THRESHOLD:
                    log.error("[SOAK] 连续异常 ≥ %d，建议检查窗口状态，休眠 %.0f 秒", _SOAK_ERROR_THRESHOLD, _SOAK_ERROR_RESET_SEC)
                    time.sleep(_SOAK_ERROR_RESET_SEC)
                    consecutive_errors = 0  # 重置计数器，尝试恢复

                maybe_cleanup()
                if paused.is_set():
                    if _sleep_until_shutdown(0.2):
                        break
                    continue

                if not window_alive(win):
                    print("[窗口丢失] 尝试重新定位…")
                    log.warning("窗口丢失，重新定位")
                    consecutive_errors += 1
                    win = locate_main_window_with_retry(on_attempt=_log_attempt)
                    if win is None:
                        print("重新定位失败，5s 后再试")
                        if _sleep_until_shutdown(5.0):
                            break
                        continue
                    consecutive_errors = 0  # 成功恢复，重置异常计数
                    try:
                        title = win.Name or ""
                    except Exception:
                        title = ""
                    print(f"千牛窗口已恢复 | 标题: {title}")
                    log.info("窗口已恢复: %s", title)

                if busy:
                    if _sleep_until_shutdown(max(3.0, float(settings.poll_interval_sec))):
                        break
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
                        if _sleep_until_shutdown(
                            max(3.0, float(settings.wait_no_unread_poll_sec))
                        ):
                            break
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
                        if _sleep_until_shutdown(
                            max(3.0, float(settings.wait_no_unread_poll_sec))
                        ):
                            break
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
                    t_legacy_ai = perf_counter()
                    reply, new_conv, elapsed_ms, ai_err = ai_chat(
                        buyer_id=buyer_id,
                        message=msg,
                        conversation_id=conv_id,
                    )
                    if new_conv:
                        state.conversations[buyer_id] = new_conv

                    print(f"[AI回复] {reply} | 耗时: {elapsed_ms}ms")
                    log.info("AI 回复 buyer=%s ms=%s", buyer_id, elapsed_ms)

                    human_delay()
                    t_legacy_send = perf_counter()
                    panel = ocr_ctx.panel if ocr_ctx is not None else None
                    ok = send_reply(win, reply, chat_panel=panel)
                    t_legacy_done = perf_counter()
                    send_ms = int((t_legacy_done - t_legacy_send) * 1000)
                    total_ms = int((t_legacy_done - t_legacy_ai) * 1000)
                    if not ok:
                        send_status = "send_failed"
                        send_error = "send_reply_failed"
                    elif ai_err:
                        send_status = "ai_failed"
                        send_error = ai_err
                    else:
                        send_status = "sent"
                        send_error = None
                    # 获取或创建 conversation_id
                    conv_id_legacy = state.conversations.get(buyer_id or "")
                    # 获取并递增 round_index
                    current_round_legacy = state.round_counters.get(buyer_id, 0) + 1
                    log_conversation(
                        buyer_nick=buyer_id or "",
                        buyer_msg=msg,
                        ai_reply=reply,
                        ai_source="stub" if settings.ai_stub_mode else "fastgpt",
                        latency_ocr_ms=0,
                        latency_ai_ms=int(elapsed_ms),
                        latency_send_ms=send_ms,
                        latency_total_ms=total_ms,
                        tokens_in=None,
                        tokens_out=None,
                        status=send_status,
                        error=send_error,
                        conversation_id=conv_id_legacy,
                        round_index=current_round_legacy,
                        buyer_id_source="legacy_uia",
                        session_id=session_id,
                    )
                    if ok:
                        state.remember_dedup(fp)
                        processed_count += 1
                        consecutive_errors = 0  # 成功处理，重置异常计数
                        state.last_replied_fingerprint[buyer_id] = fp
                        # 更新 round_counters（多轮对话计数）
                        state.round_counters[buyer_id] = current_round_legacy
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

                if _sleep_until_shutdown(max(3.0, float(settings.poll_interval_sec))):
                    break
            except KeyboardInterrupt:
                request_shutdown()
                print("已停止", flush=True)
                log.info("用户中断")
                break
            except Exception as exc:
                log.exception("主循环异常: %s", exc)
                consecutive_errors += 1
                if _sleep_until_shutdown(max(3.0, float(settings.poll_interval_sec))):
                    break
    finally:
        elapsed_total = (time.monotonic() - start_mono) / 60
        log.info("[SOAK] Legacy UIA 流水线结束 session_id=%s，总运行 %.1f 分钟，处理 %d 条消息", session_id, elapsed_total, processed_count)
        print("[INFO] 正在保存状态…", flush=True)
        try:
            _save_state(state)
        except Exception as save_exc:
            log.warning("退出时保存状态失败: %s", save_exc)
        print("[INFO] 已安全退出。", flush=True)


def run() -> None:
    setup_logging()
    acquire_lock()
    _install_shutdown_handlers()
    state = _load_state()
    get_selectors()

    if settings.use_vision_pipeline and not settings.legacy_uia_pipeline:
        _run_vision_pipeline(state)
        return

    _run_legacy_uia(state)


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
    acquire_lock()

    # 创建适配器
    config = AdapterConfig(
        platform="qianniu",
        poll_interval_sec=settings.poll_interval_sec,
        wait_no_unread_poll_sec=settings.wait_no_unread_poll_sec,
        session_cooldown_sec=3.0,
    )
    adapter = QianniuAdapter(config)

    # 创建编排器
    orchestrator = Orchestrator(
        adapter=adapter,
        ai_client=None,  # 使用默认 AI 客户端
        state_path=settings.state_path,
        session_cooldown_sec=3.0,
    )

    # 运行
    await orchestrator.run()


def main() -> None:
    """主入口：根据配置选择运行模式。"""
    import asyncio

    # 检查是否使用新架构
    use_adapter = getattr(settings, "use_adapter_mode", False)
    if use_adapter and _ADAPTER_AVAILABLE:
        asyncio.run(run_with_adapter())
    else:
        run()


if __name__ == "__main__":
    main()
