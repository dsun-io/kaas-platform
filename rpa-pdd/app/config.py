from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    pdd_chat_url: str = "https://mms.pinduoduo.com/"
    msg_router_url: str = "http://localhost:8000"
    msg_router_api_key: str = ""

    playwright_headless: bool = Field(
        default=False,
        validation_alias=AliasChoices("PLAYWRIGHT_HEADLESS", "playwright_headless"),
    )
    viewport_width: int = 1280
    viewport_height: int = 800
    browser_user_agent: str = ""

    state_dir: str = "data"
    cookies_path: str = "data/cookies.json"
    selectors_path: str = "config/selectors.json"

    action_delay_ms_min: int = 200
    action_delay_ms_max: int = 500
    action_max_retries: int = 3

    ai_http_timeout_sec: float = 15.0
    dom_poll_interval_sec: float = 2.0
    login_nav_timeout_ms: int = 60_000

    screenshot_dir: str = "screenshots"
    log_dir: str = "logs"

    @property
    def headless(self) -> bool:
        return self.playwright_headless

    @property
    def user_agent(self) -> str:
        return (self.browser_user_agent or "").strip()

    @property
    def chat_endpoint(self) -> str:
        return self.msg_router_url.rstrip("/") + "/v1/chat"

    @property
    def state_path(self) -> Path:
        p = Path(self.state_dir)
        p.mkdir(parents=True, exist_ok=True)
        return p / "pdd_state.json"

    @property
    def cookies_absolute_path(self) -> Path:
        p = Path(self.cookies_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p.resolve()


settings = Settings()
