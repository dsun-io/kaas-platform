"""Kaas v2 · CustomerQuoteProfile 仓储

客户报价税率档案 —— 把「这个客户填过的那套税率」存成一份命名档案，下次一键套用。

三条纪律（与客户成本价仓储保持一致）
-----------------------------------
1. **身份不从前端传**：tenant/customer 一律由调用方从 AuthContext 取，
   仓储层只管按给定的键查，不做权限判断（权限在 API 层做）。
2. **历史不删**：停用 = status 置为 inactive，行仍在库里。
   档案一旦生成过报价单，删掉就无法回答「当时用的是哪套税率」。
3. **只有 active 可见**：所有查询都带 status='active'，别让停用的档案
   悄悄回到下拉里。
"""
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import CustomerQuoteProfile

ACTIVE = "active"
INACTIVE = "inactive"


async def list_profiles(
    session: AsyncSession,
    tenant_id: str,
    product_key: str,
    customer_id: Optional[str] = None,
) -> list[CustomerQuoteProfile]:
    """列出某产品下的有效档案。

    `customer_id=None` = **跨客户**（管理员「看所有客户」的路径）。
    调用方必须自己确认调用者有此权限 —— 仓储不做权限判断。
    """
    stmt = select(CustomerQuoteProfile).where(
        CustomerQuoteProfile.tenant_id == tenant_id,
        CustomerQuoteProfile.product_key == product_key,
        CustomerQuoteProfile.status == ACTIVE,
    )
    if customer_id is not None:
        stmt = stmt.where(CustomerQuoteProfile.customer_id == customer_id)
    # 新的在前：界面「默认选择最新创建的」直接取第一条，不用再排一次
    stmt = stmt.order_by(
        CustomerQuoteProfile.created_at.desc(), CustomerQuoteProfile.id.desc()
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def get_profile(
    session: AsyncSession,
    profile_id: int,
    tenant_id: str,
    customer_id: Optional[str] = None,
) -> Optional[CustomerQuoteProfile]:
    """按 ID 取一份档案。

    `customer_id` 给定时会一并校验归属 —— 防止客户 A 改到客户 B 的档案。
    管理员路径传 None，表示「本租户内不限定客户」。
    """
    stmt = select(CustomerQuoteProfile).where(
        CustomerQuoteProfile.id == profile_id,
        CustomerQuoteProfile.tenant_id == tenant_id,
        CustomerQuoteProfile.status == ACTIVE,
    )
    if customer_id is not None:
        stmt = stmt.where(CustomerQuoteProfile.customer_id == customer_id)
    result = await session.execute(stmt)
    return result.scalar_one_or_none()


async def find_by_name(
    session: AsyncSession,
    tenant_id: str,
    customer_id: str,
    product_key: str,
    profile_name: str,
    exclude_id: Optional[int] = None,
) -> Optional[CustomerQuoteProfile]:
    """查同名档案（用于拦截重名）。

    为什么拦重名：档案例唯一的用处就是「在下拉里认出是哪一份」。
    两份同名档案摆在一起，用户选哪个都一样 —— 那就等于没有档案。
    """
    stmt = select(CustomerQuoteProfile).where(
        CustomerQuoteProfile.tenant_id == tenant_id,
        CustomerQuoteProfile.customer_id == customer_id,
        CustomerQuoteProfile.product_key == product_key,
        CustomerQuoteProfile.profile_name == profile_name,
        CustomerQuoteProfile.status == ACTIVE,
    )
    if exclude_id is not None:
        stmt = stmt.where(CustomerQuoteProfile.id != exclude_id)
    result = await session.execute(stmt)
    return result.scalars().first()


async def create_profile(
    session: AsyncSession,
    tenant_id: str,
    customer_id: str,
    product_key: str,
    profile_name: str,
    rate_set_code: str,
    tax_overrides: dict[str, Any],
    created_by: Optional[str] = None,
    source: str = "manual",
) -> CustomerQuoteProfile:
    """新建一份档案。tax_overrides 的键名由 API 层按白名单校验后再传进来。"""
    profile = CustomerQuoteProfile(
        tenant_id=tenant_id,
        customer_id=customer_id,
        product_key=product_key,
        profile_name=profile_name,
        rate_set_code=rate_set_code,
        tax_overrides=dict(tax_overrides or {}),
        status=ACTIVE,
        source=source,
        created_by=created_by,
    )
    session.add(profile)
    await session.flush()
    return profile


async def update_profile(
    session: AsyncSession,
    profile: CustomerQuoteProfile,
    *,
    profile_name: Optional[str] = None,
    rate_set_code: Optional[str] = None,
    tax_overrides: Optional[dict[str, Any]] = None,
) -> CustomerQuoteProfile:
    """改名 / 改内容。只改传进来的项 —— None 表示「不动这一项」。

    注意区分「不改」与「改成空」：税率里没有「空」这个语义（空 = 用法定值），
    所以未提供的键就从 tax_overrides 里删掉，而不是塞 null。
    """
    if profile_name is not None:
        profile.profile_name = profile_name
    if rate_set_code is not None:
        profile.rate_set_code = rate_set_code
    if tax_overrides is not None:
        profile.tax_overrides = dict(tax_overrides)
    await session.flush()
    # ⚠️ 必须显式 await 刷新一下，不能省。
    #
    # 模型的 `updated_at` 用了 `onupdate=func.now()`。SQLAlchemy 执行 UPDATE 之后
    # 会把这个属性**标记为过期**（因为新值由数据库算出来，ORM 并不知道），
    # 下次读它时会触发一次隐式懒加载 —— 而异步会话里"隐式 IO"是非法的，
    # 会抛 MissingGreenlet，HTTP 侧表现为 500。
    #
    # 症状很隐蔽：这是个 INSERT 没事、UPDATE 才炸的问题（INSERT 走 RETURNING
    # 把值一并带回了），所以「新建档案」一直是好的，只有「改名」会挂。
    #
    # 这里刻意不用 Python 的 datetime.now() 绕开，是为了让 created_at 与
    # updated_at 取同一个时钟（数据库），否则应用服务器时钟偏一点，
    # 就会出现「更新时间早于创建时间」这种没人能解释的记录。
    await session.refresh(profile)
    return profile


async def deactivate_profile(
    session: AsyncSession,
    profile: CustomerQuoteProfile,
) -> None:
    """停用（软删）。行留在库里 —— 历史报价单要能回答「当时用的哪套税率」。"""
    profile.status = INACTIVE
    await session.flush()
