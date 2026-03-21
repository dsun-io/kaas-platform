from __future__ import annotations

from pathlib import Path

from playwright.sync_api import Browser, BrowserContext, Page, Playwright, sync_playwright

from app.config import settings
from app.logger import get_logger

log = get_logger("browser_manager")


class BrowserManager:
    def __init__(self) -> None:
        self._pw: Playwright | None = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None
        self._page: Page | None = None

    @property
    def page(self) -> Page | None:
        return self._page

    @property
    def context(self) -> BrowserContext | None:
        return self._context

    def start(self) -> Page:
        self.close()
        log.info("启动 Chromium（headless=%s）", settings.headless)
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(
            headless=settings.headless,
            args=["--disable-blink-features=AutomationControlled"],
        )
        cookie_file = settings.cookies_absolute_path
        storage_state = str(cookie_file) if cookie_file.exists() else None
        ua = settings.user_agent or None
        self._context = self._browser.new_context(
            viewport={
                "width": settings.viewport_width,
                "height": settings.viewport_height,
            },
            user_agent=ua,
            ignore_https_errors=True,
            storage_state=storage_state,
        )
        self._page = self._context.new_page()
        self._page.set_default_timeout(30_000)
        return self._page

    def save_storage(self) -> None:
        if not self._context:
            return
        path = settings.cookies_absolute_path
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        self._context.storage_state(path=str(tmp))
        tmp.replace(path)
        log.info("已保存登录态: %s", path)

    def is_page_alive(self) -> bool:
        try:
            return self._page is not None and not self._page.is_closed()
        except Exception:
            return False

    def restart(self) -> Page:
        log.warning("浏览器重启")
        return self.start()

    def close(self) -> None:
        try:
            if self._context:
                self._context.close()
        except Exception as exc:
            log.debug("context.close: %s", exc)
        try:
            if self._browser:
                self._browser.close()
        except Exception as exc:
            log.debug("browser.close: %s", exc)
        try:
            if self._pw:
                self._pw.stop()
        except Exception as exc:
            log.debug("playwright.stop: %s", exc)
        self._context = None
        self._browser = None
        self._page = None
        self._pw = None


def screenshot_on_error(page: Page | None, tag: str) -> None:
    if page is None:
        return
    try:
        if page.is_closed():
            return
    except Exception:
        return
    d = Path(settings.screenshot_dir)
    d.mkdir(parents=True, exist_ok=True)
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in tag)[:80]
    path = d / f"{safe}.png"
    try:
        page.screenshot(path=str(path), full_page=True)
        log.error("已保存异常截图: %s", path)
    except Exception as exc:
        log.debug("截图失败: %s", exc)
