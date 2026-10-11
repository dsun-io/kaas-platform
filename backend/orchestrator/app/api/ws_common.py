"""工位 API 公共助手：可见范围 / 客户引用校验 / 取号 / 汇率锁定

- 可见范围三助手与 customers.py 内同源（§10.3），新工位模块统一从这里导入
- resolve_customer_for_doc：单据引用业务客户时的强校验（2026-10-11 新增）
- next_doc_no：§10.7 doc_sequences 事务取号，格式 {TYPE}-{YYYYMM}-{SEQ:04d}
- lock_fx_rate：§10.2 按订单/报价币种取最新 fx_rates 锁定汇率快照

可见性判定本身（含**三层组织：管理员/团队/成员**）已收敛到共享内核
`kaas_common/workstation/scope.py` —— Worker 用同一份规则，避免两端口径漂移。
"""
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional, Tuple

from fastapi import HTTPException
from sqlalchemy import select, update, or_
from sqlalchemy.dialects.postgresql import insert as pg_insert

from kaas_common.workstation.scope import can_view, is_admin_role
from app.db.models import Customer
from app.db.workstation_models import DocSequence, FxRate

DEFAULT_TENANT = "default"

# 单证/单据类型 → 编号前缀（§10.7）
# 必须覆盖全部单证类型；未列出类型会用前三位大写兜底，
# 但兜底会产生 SA/NON/WEI 这类无业务含义的编号，所以新类型要显式登记。
DOC_TYPE_PREFIX = {
    # 出口商自制
    "quotation": "QUO", "pi": "PI", "contract": "CON", "ci": "CI", "pl": "PL",
    "shipping_advice": "SA", "draft": "DR", "beneficiary_cert": "BEN",
    "non_wood_packing": "NWP", "weight_list": "WL", "quality_cert": "QC",
    "manufacturer_cert": "MC",
    # 第三方签发
    "bl": "BL", "co": "CO", "insurance": "INS",
    "customs_declaration": "CD", "fumigation_cert": "FUM",
    # 通用与其它单据
    "other": "DOC", "order": "ORD", "shipment": "SHP",
}


def tenant_id_of(auth) -> str:
    return auth.tenant_id or DEFAULT_TENANT


def can_see_all(auth) -> bool:
    """system_admin（含历史 'admin'）看全部；其余按可见范围过滤。"""
    return is_admin_role(auth.role)


def scope_filter(stmt, model, auth):
    """§10.3 + 三层组织：可见的数据范围。

    可见 ⟺ 管理员 / `owner_scope='tenant'`（显式共享）/ `owner_id=我` /
           **`team_id=我的团队`（本团队，2026-10-11 新增）**。

    注意 `team_id IS NULL` 的行**不因团队规则而改变可见性**：它们仍按前三条判定
    （即本次上线前的行为）。所以这是**纯增量**条件，不会让任何人突然看不到数据。
    """
    if can_see_all(auth):
        return stmt
    conds = [
        model.owner_id == str(auth.user_id),
        model.owner_scope == "tenant",
    ]
    # 表没有 team_id 列（如线索池/调研域）或访问者未分组时，不参与团队判定
    if hasattr(model, "team_id") and getattr(auth, "team_id", None) is not None:
        conds.append(model.team_id == auth.team_id)
    return stmt.where(or_(*conds))


def visible_to(row, auth) -> bool:
    """单行可见性判定（与 `scope_filter` 同一份规则，供取回后再判的场景用）。"""
    return can_view(
        role=auth.role,
        owner_id=getattr(row, "owner_id", None),
        owner_scope=getattr(row, "owner_scope", None),
        team_id=getattr(row, "team_id", None),
        viewer_id=auth.user_id,
        viewer_team_id=getattr(auth, "team_id", None),
    )


def check_write_access(row, auth):
    """写规则：成员只能改 owner_id=自己的数据；admin 全可改。"""
    from fastapi import HTTPException
    if can_see_all(auth):
        return
    if row.owner_id is not None and row.owner_id != str(auth.user_id):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "NOT_OWNER",
            "detail": "只能修改自己账号的数据",
        })


async def resolve_customer_for_doc(db, tenant_id: str, customer_id, auth) -> Optional[Customer]:
    """单据引用业务客户时的强校验：客户必须**存在、未软删、且属于本团队**。

    为什么单据侧要单独校验，而不是信任前端传值
    ------------------------------------------
    三张单据表的 `customer_id` 在 202610110009 之前是**自由文本**，历史值里有
    `'3'`（客户已删）、`'lianjia-demo'`（演示串）这类垃圾 —— 于是"客户详情页
    列不出他的单据"。改成外键之后，新建单据必须**从已有业务客户里选**，
    后端就要把这条件变成硬校验，否则前端随便传一个 id 就能绕过。

    为什么不可见一律 404（而不是 403 / 400）
    ----------------------------------------
    404 `CUSTOMER_NOT_FOUND` 与客户域 `_get_customer_or_404` 同一口径：
    "别家团队的客户"与"根本不存在的客户"对外**长得一模一样**，
    否则这个接口就成了探测别家客户是否存在的旁路。

    为什么管理员不受团队限制
    ------------------------
    管理员在客户域本来就"全租户可见"（`can_see_all`）。若这里强行要求团队一致，
    会出现"客户列表里看得见、开单时选不了"的死路。

    返回值：命中的 `Customer`（`customer_id` 为空时返回 None）。
    调用方用它的 `name` 兜 `customer_name` 快照、用 `team_id` 让单据落本团队。
    """
    if customer_id is None:
        return None
    stmt = select(Customer).where(
        Customer.tenant_id == tenant_id,
        Customer.id == customer_id,
        # 软删除的客户视为不存在（与客户域一致：is_deleted 不是"只写不读"的标记）
        Customer.is_deleted.is_(False),
    )
    # 可见性 = 引用权：与客户域（列表/详情）**同一套规则**。
    #
    # 两个方向都要对齐，否则两边会互相打架：
    #   1) 行规则 → 内核 `visible_to`（管理员 / owner_scope=tenant / owner_id=我 / team_id=我的团队）
    #      原先这里只比"团队相等"，于是"自己名下但 team_id 为空"的客户看得见却选不了。
    #   2) 管理员概念 → 客户域的 `customer_rules.can_see_all`
    #      它包含 `account_type='internal'`（内部账号），而内核 `can_view` 只认 role 管理员。
    #      只用内核判会导致"internal + role=user：客户详情看得见、开单却 404"。
    from kaas_common.workstation.customer_rules import can_see_all as customer_can_see_all

    customer = (await db.execute(stmt)).scalar_one_or_none()
    if customer is None or not (customer_can_see_all(auth) or visible_to(customer, auth)):
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "CUSTOMER_NOT_FOUND",
            "detail": "客户不存在或对你的账号不可见",
        })
    return customer


async def next_doc_no(db, tenant_id: str, doc_type: str) -> str:
    """§10.7 单事务取号：INSERT 初始化（幂等）+ UPDATE...RETURNING 自增。"""
    prefix = DOC_TYPE_PREFIX.get(doc_type, doc_type.upper()[:3])
    period = datetime.now(timezone.utc).strftime("%Y%m")
    await db.execute(
        pg_insert(DocSequence)
        .values(tenant_id=tenant_id, doc_type=doc_type, period=period, last_seq=0)
        .on_conflict_do_nothing()
    )
    seq = (await db.execute(
        update(DocSequence)
        .where(
            DocSequence.tenant_id == tenant_id,
            DocSequence.doc_type == doc_type,
            DocSequence.period == period,
        )
        .values(last_seq=DocSequence.last_seq + 1)
        .returning(DocSequence.last_seq)
    )).scalar_one()
    return f"{prefix}-{period}-{seq:04d}"


async def lock_fx_rate(db, currency: str, base: str = "CNY") -> Tuple[Optional[Decimal], Optional[date]]:
    """§10.2 锁定汇率：fx_rates 语义 1 base = rate quote。

    订单原币 → 本币折算需要 base_currency=订单币, quote_currency=本币。
    同币返回 1；无记录返回 (None, None)（调用方继续落单，汇率后补）。
    """
    if currency == base:
        return Decimal("1"), date.today()
    row = (await db.execute(
        select(FxRate.rate, FxRate.rate_date)
        .where(
            FxRate.base_currency == currency,
            FxRate.quote_currency == base,
            FxRate.rate_date <= date.today(),
        )
        .order_by(FxRate.rate_date.desc())
        .limit(1)
    )).first()
    if row is None:
        return None, None
    return row.rate, row.rate_date
