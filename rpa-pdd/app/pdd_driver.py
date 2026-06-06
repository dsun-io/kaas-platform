from __future__ import annotations

import random
import re
import time
from typing import Callable, TypeVar

from playwright.sync_api import Locator, Page

from app.config import settings
from app.logger import get_logger
from app.message_listener import extract_time_token
from app.page_selectors import get_selectors

log = get_logger("pdd_driver")

T = TypeVar("T")


def human_delay() -> None:
    lo = max(0, settings.action_delay_ms_min)
    hi = max(lo, settings.action_delay_ms_max)
    time.sleep(random.uniform(lo, hi) / 1000.0)


def _retry(op_name: str, fn: Callable[[], T]) -> T:
    last: Exception | None = None
    attempts = max(1, settings.action_max_retries)
    for i in range(attempts):
        try:
            human_delay()
            return fn()
        except Exception as exc:
            last = exc
            log.warning("%s 第 %s 次失败: %s", op_name, i + 1, exc)
            human_delay()
    if last:
        raise last
    raise RuntimeError(op_name)


def _safe_inner_text(loc: Locator, timeout_ms: int = 3000) -> str:
    try:
        t = loc.inner_text(timeout=timeout_ms)
        return re.sub(r"\s+", " ", (t or "").strip())
    except Exception:
        return ""


def select_first_unread_session(page: Page) -> str | None:
    """
    点击第一个未读会话，返回用于 buyer_id 的展示名（尽力从内文截取）。
    需在 config/selectors.json 配置 session_item_unread 或 session_item。
    """
    sel = get_selectors()
    if sel.session_item_unread.strip():
        loc = page.locator(sel.session_item_unread).first
        try:
            if loc.count() < 1:
                return None
        except Exception:
            return None
        label = _safe_inner_text(loc)
        _retry("点击未读会话", lambda: loc.click(timeout=8000))
        human_delay()
        return label or "pdd_buyer"

    if sel.session_item.strip():
        root = page.locator(sel.session_list).locator(sel.session_item) if sel.session_list.strip() else page.locator(sel.session_item)
        try:
            n = root.count()
        except Exception:
            n = 0
        for i in range(n):
            item = root.nth(i)
            try:
                unread = item.locator("[class*='unread'], [class*='UnRead'], .red-dot, .badge").first
                has_unread = False
                try:
                    has_unread = unread.count() > 0
                except Exception:
                    has_unread = False
                if not has_unread:
                    continue
                label = _safe_inner_text(item)
                _retry("点击带未读标记的会话", lambda it=item: it.click(timeout=8000))
                human_delay()
                return label or "pdd_buyer"
            except Exception:
                continue
        return None

    log.debug("未配置 session_item_unread / session_item，无法从 DOM 选择会话")
    return None


def read_latest_buyer_message_from_dom(page: Page) -> tuple[str | None, str | None]:
    sel = get_selectors()
    text: str | None = None
    try:
        if sel.message_list.strip() and sel.buyer_message_row.strip():
            row = page.locator(sel.message_list).locator(sel.buyer_message_row).last
            text = _safe_inner_text(row, 8000)
        elif sel.buyer_message_text.strip():
            text = _safe_inner_text(page.locator(sel.buyer_message_text).last, 8000)
    except Exception as exc:
        log.debug("读取消息 DOM 失败: %s", exc)
        text = None
    if not text:
        return None, None
    return text, extract_time_token(text)


def send_reply(page: Page, body: str) -> bool:
    sel = get_selectors()
    msg = (body or "").strip()
    if not msg:
        return False
    if not sel.input_editor.strip() or not sel.send_button.strip():
        log.error("请在 config/selectors.json 配置 input_editor 与 send_button")
        return False
    try:
        ed = page.locator(sel.input_editor).first
        btn = page.locator(sel.send_button).first
        _retry("点击输入框", lambda: ed.click(timeout=8000))
        human_delay()
        try:
            ed.fill("")
        except Exception:
            pass
        try:
            ed.fill(msg)
        except Exception:
            try:
                page.keyboard.press("Control+A")
                page.keyboard.press("Backspace")
            except Exception:
                pass
            page.keyboard.insert_text(msg)
        human_delay()
        _retry("点击发送", lambda: btn.click(timeout=8000))
        human_delay()
        # 验证发送是否成功：检查输入框是否被清空
        try:
            input_value = ed.input_value(timeout=3000)
            if input_value.strip():
                log.warning("发送后输入框未清空，可能发送失败: %r", input_value[:100])
                return False
        except Exception as exc:
            # input_value 可能不支持（如 contenteditable），尝试 inner_text
            try:
                inner_text = ed.inner_text(timeout=3000)
                if inner_text.strip():
                    log.warning("发送后输入框未清空，可能发送失败: %r", inner_text[:100])
                    return False
            except Exception:
                pass  # 无法验证，继续返回 True
        return True
    except Exception as exc:
        log.exception("发送消息失败: %s", exc)
        return False


def selectors_configured_for_automation() -> bool:
    sel = get_selectors()
    return bool(
        sel.session_item_unread.strip()
        or sel.session_item.strip()
    ) and bool(
        (sel.message_list.strip() and sel.buyer_message_row.strip())
        or sel.buyer_message_text.strip()
    ) and bool(sel.input_editor.strip() and sel.send_button.strip())
