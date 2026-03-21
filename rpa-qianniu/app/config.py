from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    msg_router_url: str = "http://localhost:8000"
    msg_router_api_key: str = ""

    qianniu_window_substring: str = "千牛"
    window_locate_retries: int = 15
    window_locate_interval_sec: float = 2.0

    poll_interval_sec: float = 2.0
    action_delay_ms_min: int = 200
    action_delay_ms_max: int = 500

    ai_http_timeout_sec: float = 15.0

    state_dir: str = "data"
    log_dir: str = "logs"

    # UI 选择器 JSON（相对 rpa-qianniu 根目录）；可拷贝修改而无需改 Python
    selectors_path: str = "config/selectors.json"

    @property
    def state_path(self) -> Path:
        p = Path(self.state_dir)
        p.mkdir(parents=True, exist_ok=True)
        return p / "rpa_state.json"

    @property
    def chat_endpoint(self) -> str:
        return self.msg_router_url.rstrip("/") + "/v1/chat"


settings = Settings()
