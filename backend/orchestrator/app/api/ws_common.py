"""工位 API 公共助手：可见范围 / 取号 / 汇率锁定

- 可见范围三助手与 customers.py 内同源（§10.3），新工位模块统一从这里导入
- next_doc_no：§10.7 doc_sequences 事务取号，格式 {TYPE}-{YYYYMM}-{SEQ:04d}
- lock_fx_rate：§10.2 按订单/报价币种取最新 fx_rates 锁定汇率快照
"""
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional, Tuple

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

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
    """system_admin 看全部；企业管理员（Phase 6）同样看全部。"""
    return auth.is_admin()


def scope_filter(stmt, model, auth):
    """§10.3：自己账号数据 + owner 开放 tenant 的基础数据。"""
    from sqlalchemy import or_
    if can_see_all(auth):
        return stmt
    return stmt.where(or_(
        model.owner_id == str(auth.user_id),
        model.owner_scope == "tenant",
    ))


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
