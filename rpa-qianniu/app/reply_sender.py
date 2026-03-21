import time

import pyautogui
import pyperclip
import uiautomation as auto

from app.logger import get_logger
from app.qianniu_driver import find_input_control, find_send_button, human_delay, window_alive

log = get_logger("reply_sender")

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.05


def send_reply(window: auto.Control, text: str) -> bool:
    if not window_alive(window):
        log.warning("发送失败：窗口无效")
        return False
    body = (text or "").strip()
    if not body:
        return False

    try:
        win = window
        try:
            win.SetActive()
        except Exception:
            pass
        human_delay()

        edit = find_input_control(win)
        btn = find_send_button(win)
        if edit is None:
            log.warning("未找到输入框（EditControl），请用「检查」工具核对千牛 UI")
            return False

        try:
            edit.Click(simulateMove=False)
        except Exception:
            try:
                edit.SetFocus()
            except Exception:
                pass
        human_delay()

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
        human_delay()

        if btn is not None:
            try:
                btn.Click(simulateMove=False)
            except Exception:
                pyautogui.press("enter")
        else:
            pyautogui.press("enter")
        human_delay()
        return True
    except Exception as exc:
        log.exception("发送异常: %s", exc)
        return False
