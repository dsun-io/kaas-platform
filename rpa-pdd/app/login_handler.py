from __future__ import annotations

import threading
from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError

from app.browser_manager import BrowserManager, screenshot_on_error
from app.config import settings
from app.logger import get_logger
from app.page_selectors import get_selectors

log = get_logger("login_handler")


def _is_login_like(page: Page) -> bool:
    sel = get_selectors()
    u = (page.url or "").lower()
    key = (sel.login_page_url_contains or "").lower().strip()
    if key and key in u:
        return True
    if sel.login_form_selector.strip():
        try:
            if page.locator(sel.login_form_selector).first.is_visible(timeout=800):
                return True
        except Exception:
            pass
    return False


def _wait_console_continue(reason: str) -> None:
    print(f"\n{reason}\n完成登录后，回到此窗口按 **回车** 继续…\n")
    done = threading.Event()

    def _read_stdin() -> None:
        try:
            input()
        except EOFError:
            pass
        finally:
            done.set()

    t = threading.Thread(target=_read_stdin, daemon=True)
    t.start()
    timeout = max(1, int(settings.login_console_wait_timeout_sec))
    done.wait(timeout=timeout)
    if not done.is_set():
        log.error("控制台等待登录确认超时（%ss）", timeout)
        raise RuntimeError(f"登录确认超时（{timeout}s）")


def needs_relogin(page: Page) -> bool:
    try:
        if page.is_closed():
            return True
    except Exception:
        return True
    return _is_login_like(page)


def ensure_logged_in(bm: BrowserManager, page: Page) -> None:
    sel = get_selectors()
    url = settings.pdd_chat_url.strip()
    if not url:
        raise RuntimeError("PDD_CHAT_URL 未配置")

    log.info("打开客服页: %s", url)
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=settings.login_nav_timeout_ms)
    except Exception as exc:
        log.exception("打开页面失败: %s", exc)
        screenshot_on_error(page, "goto_failed")
        raise

    if sel.chat_ready_selector.strip():
        try:
            page.wait_for_selector(
                sel.chat_ready_selector,
                state="visible",
                timeout=settings.login_nav_timeout_ms,
            )
            bm.save_storage()
            log.info("登录态有效（chat_ready 已出现）")
            return
        except PlaywrightTimeoutError:
            log.warning("chat_ready 未出现，可能未登录或选择器需更新")

    if _is_login_like(page):
        log.info("检测到登录页/登录控件")
        screenshot_on_error(page, "need_login")
        _wait_console_continue("Cookie 失效或未登录：请在浏览器中扫码/登录。")
        page.goto(url, wait_until="domcontentloaded", timeout=settings.login_nav_timeout_ms)

    if not sel.chat_ready_selector.strip():
        _wait_console_continue("未配置 chat_ready_selector：请手动进入客服工作台聊天界面。")
        page.goto(url, wait_until="domcontentloaded", timeout=settings.login_nav_timeout_ms)
    else:
        try:
            page.wait_for_selector(
                sel.chat_ready_selector,
                state="visible",
                timeout=settings.login_nav_timeout_ms,
            )
        except PlaywrightTimeoutError:
            screenshot_on_error(page, "login_timeout")
            _wait_console_continue("仍未检测到工作台就绪，请确认已进入聊天页后按回车。")

    bm.save_storage()
    log.info("登录流程结束，已写入 storage_state")
