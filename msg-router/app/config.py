from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    fastgpt_api_key: str = ""
    fastgpt_api_base: str = "https://api.fastgpt.cn/api"
    fastgpt_timeout_seconds: float = 30.0

    # 相对 msg-router 工作目录
    sqlite_path: str = "data/conversations.db"

    @property
    def sqlite_absolute_path(self) -> Path:
        return Path(self.sqlite_path).resolve()


settings = Settings()
