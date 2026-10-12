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

    # ─── Export Quote (出口报价工位) ───
    # 税务档案目录；留空用包内自带的 rate_sets/
    export_quote_rate_sets_dir: str = Field(
        default="", alias="EXPORT_QUOTE_RATE_SETS_DIR"
    )
    # 出口退税率查询服务（需自行订阅或自建；目前无免鉴权的官方 API）
    # 未配置时退税率查询只走本地税务档案库
    rebate_rate_api_url: str = Field(default="", alias="REBATE_RATE_API_URL")
    rebate_rate_api_key: str = Field(default="", alias="REBATE_RATE_API_KEY")
    rebate_rate_cache_ttl: int = Field(
        default=24 * 3600, alias="REBATE_RATE_CACHE_TTL"
    )

    # ─── Knowledge Provider (自包含知识检索 · 去 FastGPT 架构) ───
    knowledge_provider: str = Field(default="postgres", alias="KNOWLEDGE_PROVIDER")
    # FastGPT (可选 · 向后兼容 · 降级为 runtime adapter)
    fastgpt_base_url: str = Field(default="", alias="FASTGPT_BASE_URL")
    fastgpt_api_key: str = Field(default="", alias="FASTGPT_API_KEY")

    # ─── DeepSeek LLM (仅末端话术包装 · 铁律3 确定性优先) ───
    deepseek_api_key: str = Field(default="", alias="DEEPSEEK_API_KEY")
    deepseek_base_url: str = Field(
        default="https://api.deepseek.com", alias="DEEPSEEK_BASE_URL"
    )

    # ─── Auth (AUTH-WX-R1: JWT 鉴权) ───
    jwt_secret: str = Field(default="kaas-dev-jwt-secret-change-in-prod", alias="JWT_SECRET")
    jwt_algorithm: str = Field(default="HS256", alias="JWT_ALGORITHM")
    jwt_expire_minutes: int = Field(default=1440, alias="JWT_EXPIRE_MINUTES")  # 24h

    # ─── Admin Bootstrap ───
    admin_setup_token: str = Field(default="", alias="ADMIN_SETUP_TOKEN")

    # ─── Seed Dev Accounts (SEED_DEV_ACCOUNTS 开关) ───
    seed_dev_accounts: bool = Field(default=False, alias="SEED_DEV_ACCOUNTS")
    dev_admin_email: str = Field(default="", alias="DEV_ADMIN_EMAIL")
    dev_admin_password: str = Field(default="", alias="DEV_ADMIN_PASSWORD")
    dev_lianjia_email: str = Field(default="", alias="DEV_LIANJIA_EMAIL")
    dev_lianjia_password: str = Field(default="", alias="DEV_LIANJIA_PASSWORD")
    dev_clientb_email: str = Field(default="", alias="DEV_CLIENTB_EMAIL")
    dev_clientb_password: str = Field(default="", alias="DEV_CLIENTB_PASSWORD")

    # ─── WeChat ClawBot (AUTH-WX-R1) ───
    clawbot_base_url: str = Field(default="", alias="CLAWBOT_BASE_URL")
    clawbot_api_key: str = Field(default="", alias="CLAWBOT_API_KEY")

    # ─── 忘记密码：Resend 发信（send.powervoy.com 已验证域名）──────────
    # RESEND_API_KEY 为空时，forgot-password 仍返回统一 {ok:true}（不泄露邮箱存在性），
    # 但不发信 —— 日志里如实记录 "email_not_configured"。
    resend_api_key: str = Field(default="", alias="RESEND_API_KEY")
    reset_from_email: str = Field(
        default="noreply@send.powervoy.com", alias="RESET_FROM_EMAIL"
    )
    # 重置链接指向的前端地址（/reset-password?token=...）
    frontend_base_url: str = Field(
        default="https://kaas.powervoy.com", alias="FRONTEND_BASE_URL"
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
        "extra": "allow",
    }


# Singleton instance
settings = Settings()
