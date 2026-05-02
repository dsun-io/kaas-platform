"""
Kaas v2 · 数据库会话管理
─────────────────────
AsyncSession 工厂，配合 FastAPI 依赖注入使用。
所有 repository 层必须显式接收 tenant_id（不允许默认值/可选值）。
"""

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from app.config.settings import settings

# 创建异步引擎
engine = create_async_engine(
    settings.database_url,
    echo=(settings.app_env == "development"),
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,
)

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
