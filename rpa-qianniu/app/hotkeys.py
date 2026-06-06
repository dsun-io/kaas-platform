"""全局快捷键：F12 暂停/继续自动回复（不退出进程）。"""

from __future__ import annotations

import logging
import threading

log = logging.getLogger("hotkeys")


def start_f12_pause_toggle(paused: threading.Event) -> bool:
    """
    后台监听 F12，切换 paused Event。
    若未安装 pynput 则返回 False。
    """
    try:
        from pynput import keyboard
    except ImportError:
        log.warning("未安装 pynput，F12 暂停不可用。请执行: pip install pynput")
        return False

    def on_press(key: keyboard.Key | keyboard.KeyCode) -> None:
        try:
            if key == keyboard.Key.f12:
                if paused.is_set():
                    paused.clear()
                    print("\n[继续] 已恢复自动回复（再按 F12 可暂停）", flush=True)
                    log.info("用户 F12 继续")
                else:
                    paused.set()
                    print("\n[暂停] 已暂停自动回复，按 F12 继续", flush=True)
                    log.info("用户 F12 暂停")
        except Exception:
            pass

    def _run() -> None:
        try:
            with keyboard.Listener(on_press=on_press) as listener:
                listener.join()
        except Exception as exc:
            log.warning("F12 热键监听异常: %s", exc)

    threading.Thread(target=_run, daemon=True, name="rpa-f12-hotkey").start()
    return True
