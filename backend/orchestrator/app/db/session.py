"""
Kaas v2 · 数据库会话管理
─────────────────────
AsyncSession 工厂，配合 FastAPI 依赖注入使用。
所有 repository 层必须显式接收 tenant_id（不允许默认值/可选值）。
"""

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.engine.url import make_url
from app.config.settings import settings


def _build_engine():
    """创建异步引擎。

    asyncpg 不接受 sslmode/ssl 查询参数（SQLAlchemy 会原样透传或转成 bool 导致报错），
    因此对需要 SSL 的云端数据库改为通过 connect_args 显式传入 SSLContext，
    并剥离 URL 中的查询参数。

    判定口径（2026-10-19 起，不再硬编码 neon.tech）：
    - URL 显式带 ssl / sslmode 参数 ⇒ 开 SSL；
    - host 非本地/非 docker 服务名（localhost/127.0.0.1/::1/db/postgres/
      host.docker.internal）⇒ 视为云端库，默认开 SSL。

    判定不依赖具体厂商：覆盖 Neon 与未来任何托管 PG（PPG 已随决策 1 放弃，不保留专用分支）。
    """
    url = make_url(settings.database_url)
    connect_args: dict = {}
    host = (url.host or "").lower()
    local_hosts = {"", "localhost", "127.0.0.1", "::1", "db", "postgres", "host.docker.internal"}
    explicit_ssl = bool(url.query.get("ssl")) or url.query.get("sslmode") in (
        "require",
        "verify-ca",
        "verify-full",
    )
    if explicit_ssl or host not in local_hosts:
        import ssl as _ssl

        connect_args["ssl"] = _ssl.create_default_context()
        url = url.set(query={})
    return create_async_engine(
        url,
        echo=(settings.app_env == "development"),
        pool_size=10,
        max_overflow=20,
        pool_pre_ping=True,
        connect_args=connect_args,
    )


# 创建异步引擎
engine = _build_engine()

# 会话工厂
async_session_factory = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_db_session() -> AsyncSession:
    """
    FastAPI 依赖注入：获取数据库会话。

    Usage:
        @router.post("/api/v1/events")
        async def create_event(db: AsyncSession = Depends(get_db_session)):
            ...
    """
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
