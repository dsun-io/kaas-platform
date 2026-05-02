"""
Kaas v2 · 应用配置
─────────────────
使用 pydantic-settings 管理所有配置项。
敏感信息通过环境变量注入，绝不硬编码。
"""

from pydantic_settings import BaseSettings
from pydantic import Field
from typing import List
import json


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # ─── Application ───
    app_env: str = Field(default="development", alias="APP_ENV")
    log_level: str = Field(default="DEBUG", alias="LOG_LEVEL")
    cors_origins: str = Field(
        default='["http://localhost:3000","http://localhost:5173"]',
        alias="CORS_ORIGINS",
    )

    # ─── Database (PostgreSQL · 本地优先 · 铁律4 客户数据主权) ───
    database_url: str = Field(
        default="postgresql+asyncpg://kaas:kaas_dev@localhost:5432/kaas_dev",
        alias="DATABASE_URL",
    )

    # ─── Redis (L5 session memory) ───
    redis_url: str = Field(
        default="redis://localhost:6379/0",
        alias="REDIS_URL",
    )

    # ─── MinIO / OSS (L0 events archive · §3.7.4) ───
    minio_endpoint: str = Field(default="localhost:9000", alias="MINIO_ENDPOINT")
    minio_access_key: str = Field(default="minioadmin", alias="MINIO_ACCESS_KEY")
    minio_secret_key: str = Field(default="minioadmin", alias="MINIO_SECRET_KEY")
    minio_bucket: str = Field(default="kaas-events-archive", alias="MINIO_BUCKET")
    minio_secure: bool = Field(default=False, alias="MINIO_SECURE")

    # ─── FastGPT (反向调用知识库检索引擎 · Q6) ───
    fastgpt_base_url: str = Field(default="", alias="FASTGPT_BASE_URL")
    fastgpt_api_key: str = Field(default="", alias="FASTGPT_API_KEY")

    # ─── DeepSeek LLM (仅末端话术包装 · 铁律3 确定性优先) ───
    deepseek_api_key: str = Field(default="", alias="DEEPSEEK_API_KEY")
    deepseek_base_url: str = Field(
        default="https://api.deepseek.com", alias="DEEPSEEK_BASE_URL"
    )

    @property
    def cors_origins_list(self) -> List[str]:
        """Parse CORS origins from JSON string."""
        try:
            return json.loads(self.cors_origins)
        except (json.JSONDecodeError, TypeError):
            return ["http://localhost:3000"]

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "case_sensitive": False,
    }


# Singleton instance
settings = Settings()
