from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    fastgpt_api_key: str = ""
    fastgpt_api_base: str = "https://cloud.fastgpt.cn/api"
    fastgpt_timeout_seconds: float = 30.0
    # 工作流应用若 choices.message.content 为空，可设 true 让 FastGPT 返回 responseData 便于解析
    fastgpt_chat_detail: bool = False
    # 开发排障：将 FastGPT 失败时的状态码与响应片段写入日志（勿在生产长期开启大量敏感内容）
    fastgpt_log_failures: bool = True

    # 为 true 时：在调用 FastGPT 前根据买家原文做意图归类，并注入「像真人、先答具体问题」等行为约束（推荐开启）
    chat_augment_enabled: bool = True

    # 为 true 时：不调用 FastGPT，直接返回 chat_stub_reply（省积分；转人工逻辑仍生效）
    chat_stub_mode: bool = False
    chat_stub_reply: str = "回复测试~"

    # 相对 msg-router 工作目录
    sqlite_path: str = "data/conversations.db"

    @property
    def sqlite_absolute_path(self) -> Path:
        return Path(self.sqlite_path).resolve()


settings = Settings()
