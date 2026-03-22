import time
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
import pyautogui
import pyperclip
import uiautomation as auto

from app.chat_bounds import ChatPanelScreen
from app.config import settings
from app.logger import get_logger
from app.ocr_paddle import ocr_bgr_to_boxes, paddle_available
from app.qianniu_driver import (
    capture_window_frame_bgr,
    find_input_control,
    find_input_control_relaxed,
    find_input_left_of_send,
    find_send_button,
    human_delay,
    is_blocked_non_chat_edit,
    read_edit_value,
    window_alive,
)

log = get_logger("reply_sender")

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.05

_READ_AFTER_FILL_SEC = 0.12
_POST_SEND_WAIT_SEC = 0.45

# 连续输入验证失败（读回 + 底部条 OCR 均未命中）
_verify_fail_streak = 0

# 某千牛窗口上次成功的输入框策略（"A" 严格几何 / "A2" 宽松 / "B" 发送钮左侧）
_compose_strategy_cache: dict[int, str] = {}

_INPUT_PROBE_CHAR = "."


def input_verify_failure_streak() -> int:
    return _verify_fail_streak


def _reset_verify_streak() -> None:
    global _verify_fail_streak
    _verify_fail_streak = 0


def _bump_verify_streak() -> None:
    global _verify_fail_streak
    _verify_fail_streak += 1
    if _verify_fail_streak >= 2:
        log.critical(
            "输入区验证已连续失败 2 次：请关闭「商品搜索」浮层、保持接待中心在前台，"
            "或按 F12 暂停；可开启 CHAT_DEBUG_SCREENSHOTS=true 查看 %s",
            settings.chat_debug_dir,
        )
        _verify_fail_streak = 0


def _composer_shows_body(read_val: str, body: str) -> bool:
    """判断输入框读回文本是否已包含待发送正文（允许首尾空白差异）。"""
    r = (read_val or "").strip()
    b = (body or "").strip()
    if not b:
        return False
    if b in r:
        return True
    n = min(len(b), 32)
    if n >= 4 and b[:n] in r:
        return True
    return False


def _window_stable_id(win: auto.Control) -> int:
    try:
        h = getattr(win, "NativeWindowHandle", None) or 0
        return int(h) if h else id(win)
    except Exception:
        return id(win)


def _save_reply_debug_screenshot(win: auto.Control, tag: str) -> None:
    if not settings.reply_debug_screenshots:
        return
    bgr = capture_window_frame_bgr(win)
    if bgr is None or bgr.size == 0:
        return
    root = Path(settings.reply_debug_dir)
    root.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    path = root / f"reply_{tag}_{ts}.png"
    try:
        cv2.imwrite(str(path), bgr)
        log.warning("已保存调试截图 %s", path)
    except Exception as exc:
        log.debug("调试截图失败: %s", exc)


def _verify_edit_accepts_probe(edit: auto.Control) -> bool:
    """点聚焦后写入探测字符并读回，避免选错只读/搜索框。"""
    probe = _INPUT_PROBE_CHAR
    _focus_edit(edit)
    _try_clear_edit(edit)
    time.sleep(0.07)
    try:
        vp = edit.GetValuePattern()
        if vp is not None and not vp.IsReadOnly and vp.SetValue(probe):
            time.sleep(0.11)
            v = read_edit_value(edit)
            if probe in v:
                vp.SetValue("")
                time.sleep(0.05)
                return True
    except Exception:
        pass
    try:
        la = edit.GetLegacyIAccessiblePattern()
        if la is not None and la.SetValue(probe):
            time.sleep(0.11)
            if probe in read_edit_value(edit):
                la.SetValue("")
                time.sleep(0.05)
                return True
    except Exception:
        pass
    return False


def _find_composer_edit_strategies(
    win: auto.Control,
    panel: ChatPanelScreen | None,
) -> tuple[auto.Control | None, str]:
    """
    按 A（几何）→ B（发送左侧）→ C（坐标点击后再试 A/B）查找并通过点探测的输入框。
    返回 (edit, strategy_label)；失败 (None, "").
    """
    wid = _window_stable_id(win)
    pref = _compose_strategy_cache.get(wid)
    order = ["A", "B", "C"]
    if pref in order:
        order = [pref] + [x for x in order if x != pref]

    for _wave in range(2):
        for strat in order:
            if strat == "C":
                if panel is not None:
                    log.info("输入框策略 C：点击聊天栏左侧区域以激活输入条")
                    _visual_click_composer(panel)
                    human_delay()
                continue
            cand: auto.Control | None = None
            label = strat
            if strat == "A":
                cand = find_input_control(win, panel)
                if cand is None:
                    cand = find_input_control_relaxed(win, panel)
                    if cand is not None:
                        label = "A2"
            elif strat == "B":
                send = find_send_button(win, None, panel)
                if send is not None:
                    cand = find_input_left_of_send(win, send, panel)
            if cand is None:
                continue
            if is_blocked_non_chat_edit(cand):
                log.debug("策略 %s 命中禁区 Edit，跳过", label)
                continue
            if not _verify_edit_accepts_probe(cand):
                log.info("输入框策略 %s：探测字符未写入，换下一策略", label)
                continue
            _compose_strategy_cache[wid] = "A" if label.startswith("A") else label
            return cand, label
    return None, ""


def _focus_edit(edit: auto.Control) -> None:
    """点击编辑区几何中心，比部分控件的 Click 更稳。"""
    try:
        rect = edit.BoundingRectangle
        x = int((rect.left + rect.right) / 2)
        y = int((rect.top + rect.bottom) / 2)
        auto.Click(x, y)
    except Exception:
        try:
            edit.Click(simulateMove=False)
        except Exception:
            try:
                edit.SetFocus()
            except Exception:
                pass
    human_delay()


def _try_clear_edit(edit: auto.Control) -> None:
    try:
        vp = edit.GetValuePattern()
        if vp is not None and not vp.IsReadOnly:
            vp.SetValue("")
            return
    except Exception:
        pass
    try:
        la = edit.GetLegacyIAccessiblePattern()
        if la is not None:
            la.SetValue("")
    except Exception:
        pass


def _fill_composer(edit: auto.Control, body: str) -> bool:
    """写入正文并校验读回；失败时重试一次剪贴板路径。"""
    for attempt in range(2):
        _focus_edit(edit)
        _try_clear_edit(edit)
        time.sleep(0.06)

        uia_ok = False
        try:
            vp = edit.GetValuePattern()
            if vp is not None and not vp.IsReadOnly:
                uia_ok = bool(vp.SetValue(body))
        except Exception:
            pass
        if uia_ok:
            time.sleep(_READ_AFTER_FILL_SEC)
            if _composer_shows_body(read_edit_value(edit), body):
                return True

        try:
            la = edit.GetLegacyIAccessiblePattern()
            if la is not None and la.SetValue(body):
                time.sleep(_READ_AFTER_FILL_SEC)
                if _composer_shows_body(read_edit_value(edit), body):
                    return True
        except Exception:
            pass

        try:
            pyperclip.copy(body)
        except Exception as exc:
            log.exception("剪贴板写入失败: %s", exc)
            return False

        pyautogui.hotkey("ctrl", "a")
        time.sleep(0.06)
        pyautogui.press("delete")
        human_delay()
        pyautogui.hotkey("ctrl", "v")
        time.sleep(max(_READ_AFTER_FILL_SEC, 0.18))
        if _composer_shows_body(read_edit_value(edit), body):
            return True

        log.warning(
            "第 %s 次写入后仍无法在输入框读回正文（宿主可能不暴露 Value），将重试",
            attempt + 1,
        )

    return False


def _composer_cleared_after_send(edit: auto.Control, body: str) -> bool:
    b = (body or "").strip()
    if not b:
        return True
    for _ in range(2):
        time.sleep(_POST_SEND_WAIT_SEC / 2)
        v = read_edit_value(edit).strip()
        if not v:
            return True
        if b in v and len(v) >= len(b) * 0.85:
            continue
        return True
    return False


def _verify_bottom_strip_ocr(bgr: np.ndarray, wr: auto.Rect, panel: ChatPanelScreen, body: str) -> bool:
    """裁剪聊天面板底部条带做 OCR，确认正文片段出现在输入区（防打进搜索框）。"""
    if bgr is None or bgr.size == 0 or not paddle_available():
        return False
    wl, wt = int(wr.left), int(wr.top)
    sh = min(120, max(48, bgr.shape[0] // 5))
    y1 = bgr.shape[0]
    y0 = max(0, y1 - sh)
    x0 = max(0, int(panel.left - wl))
    x1 = min(bgr.shape[1], int(panel.right - wl + 8))
    strip = bgr[y0:y1, x0:x1]
    if strip.size == 0:
        return False
    head = (body or "").strip()[:36]
    if len(head) < 2:
        return False
    boxes = ocr_bgr_to_boxes(
        strip,
        win_left=int(wl + x0),
        win_top=int(wt + y0),
        cache_ttl_sec=0.0,
    )
    for b in boxes:
        if head in (b.text or ""):
            return True
    return False


def _visual_click_composer(panel: ChatPanelScreen) -> None:
    """发送钮左侧点击，尝试激活聊天输入条（坐标限制在 panel 内）。"""
    if panel.send_left is None or panel.send_cy is None:
        cx = int((panel.left + panel.right) / 2)
        cy = int(panel.bottom - 28)
    else:
        cx = max(panel.left + 40, min(panel.send_left - 100, panel.right - 80))
        cy = int(panel.send_cy)
    pyautogui.click(cx, cy)
    human_delay()


def send_reply(
    window: auto.Control,
    text: str,
    *,
    chat_panel: ChatPanelScreen | None = None,
) -> bool:
    """
    发送回复。chat_panel 由 OCR 锚定得到时：选输入框/发送键/验证均限制在面板内，并可用底部条 OCR 二次确认。
    """
    if not window_alive(window):
        log.warning("发送失败：窗口无效")
        return False
    body = (text or "").strip()
    if not body:
        return False

    panel = chat_panel

    try:
        win = window
        try:
            win.SetActive()
        except Exception:
            pass
        human_delay()

        wr = win.BoundingRectangle
        edit, strat_used = _find_composer_edit_strategies(win, panel)
        if edit is None:
            log.warning(
                "未找到可通过点探测校验的聊天主输入框（策略 A 几何 / A2 宽松 / B 发送左侧 / C 坐标激活 均失败）；"
                "请关闭「商品搜索」浮层并保持接待中心窗口在前台"
            )
            _save_reply_debug_screenshot(win, "no_input")
            return False
        if strat_used:
            log.info("输入框定位成功 strategy=%s", strat_used)

        if is_blocked_non_chat_edit(edit):
            log.warning("选中的输入框落在商品搜索等禁区，已放弃发送；请关闭「商品搜索」弹窗")
            _save_reply_debug_screenshot(win, "blocked_edit")
            return False

        for attempt in range(2):
            if not _fill_composer(edit, body):
                log.warning("发送中止：无法确认正文已写入输入框")
                pyautogui.hotkey("ctrl", "a")
                time.sleep(0.05)
                pyautogui.press("delete")
                if attempt == 0 and panel is not None:
                    _visual_click_composer(panel)
                    human_delay()
                    continue
                _bump_verify_streak()
                _save_reply_debug_screenshot(win, "fill_fail")
                return False

            ok_ui = _composer_shows_body(read_edit_value(edit), body)
            ok_strip = False
            if (
                panel is not None
                and settings.chat_ocr_enabled
                and paddle_available()
            ):
                bgr_after = capture_window_frame_bgr(win)
                if bgr_after is not None:
                    ok_strip = _verify_bottom_strip_ocr(bgr_after, wr, panel, body)

            if ok_ui or ok_strip:
                _reset_verify_streak()
                break

            log.warning("输入验证未通过（读回与底部 OCR 均未命中），将清除并重试定位")
            pyautogui.hotkey("ctrl", "a")
            time.sleep(0.05)
            pyautogui.press("delete")
            human_delay()
            if attempt == 1:
                _bump_verify_streak()
                _save_reply_debug_screenshot(win, "verify_fail")
                return False
            if panel is not None:
                _visual_click_composer(panel)

        btn = find_send_button(win, edit, panel)

        if btn is not None:
            try:
                btn.Click(simulateMove=False)
            except Exception:
                pyautogui.press("enter")
        else:
            log.warning("未找到「发送」按钮，改用 Enter")
            pyautogui.press("enter")
        human_delay()

        if not _composer_cleared_after_send(edit, body):
            log.warning("发送后输入框仍含全文，判定未成功发出（焦点或发送按钮可能不对）")
            return False

        return True
    except Exception as exc:
        log.exception("发送异常: %s", exc)
        return False
