from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ========== 服务配置 ==========
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    api_workers: int = 1  # 工作进程数，生产环境可设为 CPU 核心数

    # ========== FastGPT 配置 ==========
    fastgpt_api_key: str = ""
    fastgpt_api_base: str = "https://cloud.fastgpt.cn/api"
    # 优化：降低默认超时以控制RPA端到端延迟（配合RPA的10s超时）
    fastgpt_timeout_seconds: float = 10.0  # 优化: 10s（原30s）
    # 工作流应用若 choices.message.content 为空，可设 true 让 FastGPT 返回 responseData 便于解析
    fastgpt_chat_detail: bool = False
    # 开发排障：将 FastGPT 失败时的状态码与响应片段写入日志（勿在生产长期开启大量敏感内容）
    fastgpt_log_failures: bool = True

    # 为 true 时：在调用 FastGPT 前根据买家原文做意图归类，并注入「像真人、先答具体问题」等行为约束（推荐开启）
    chat_augment_enabled: bool = True

    # 为 true 时：不调用 FastGPT，直接返回 chat_stub_reply（省积分；转人工逻辑仍生效）
    chat_stub_mode: bool = False
    # 更人性化的桩回复，模拟真实客服语气
    chat_stub_reply: str = "亲，您好呀~ 欢迎光临我们的店铺！有什么可以帮您的吗？"

    # 相对 msg-router 工作目录
    sqlite_path: str = "data/conversations.db"

    # 安全过滤配置
    safety_rules_path: str | None = None  # 安全规则配置文件路径，默认使用 data/safety_rules.json
    safety_filter_enabled: bool = True  # 是否启用安全过滤

    @property
    def sqlite_absolute_path(self) -> Path:
        return Path(self.sqlite_path).resolve()

    @property
    def safety_rules_absolute_path(self) -> Path | None:
        if self.safety_rules_path:
            return Path(self.safety_rules_path).resolve()
        # 默认路径
        base_dir = Path(__file__).parent.parent
        return base_dir / "data" / "safety_rules.json"


settings = Settings()
