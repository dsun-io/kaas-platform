"""单证模板与渲染 API

- GET /api/v1/trade-doc-templates           可用模板清单（含字段定义）
- GET /api/v1/trade-doc-templates/{type}    指定模板字段定义
- GET /api/v1/trade-docs/{id}/render        渲染单证为 HTML（可浏览器打印为 PDF）
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from sqlalchemy import select

from app.db.session import get_db_session
from app.db.workstation_links import TradeDoc
from app.core.auth import AuthContext, get_auth_context
from app.api.ws_common import tenant_id_of
from app.renderers import trade_doc_renderer

router = APIRouter(prefix="/api/v1", tags=["trade-doc-templates"])


@router.get("/trade-doc-templates")
async def list_templates(auth: AuthContext = Depends(get_auth_context)):
    """返回所有可用单证模板清单"""
    return {"items": trade_doc_renderer.get_available_templates()}


@router.get("/trade-doc-templates/{doc_type}")
async def get_template_fields(
    doc_type: str,
    auth: AuthContext = Depends(get_auth_context),
):
    """返回指定单证类型的字段定义（用于前端动态表单 / AI 填充参考）"""
    fields = trade_doc_renderer.get_template_fields(doc_type)
    if fields is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "TEMPLATE_NOT_FOUND",
            "detail": f"模板不存在: {doc_type}",
        })
    return {"doc_type": doc_type, "fields": fields}


def _build_render_data(doc: TradeDoc) -> dict:
    """从 TradeDoc.raw_payload 组装渲染数据

    raw_payload 结构：
      sources: { order: {...}, quote: {...}, inquiry: {...} }  # 上游快照
      custom:  {...}                                            # 手工补充字段

    组装规则：custom 优先，上游快照兜底。
    """
    payload = doc.raw_payload or {}
    sources = payload.get("sources", {})
    custom = payload.get("custom", {})

    order = sources.get("order", {})
    quote = sources.get("quote", {})

    # 卖方信息（企业主体，可从 custom 覆盖；默认占位）
    seller_default = {
        "company": custom.get("seller_company", ""),
        "address": custom.get("seller_address", ""),
        "phone": custom.get("seller_phone", ""),
        "email": custom.get("seller_email", ""),
    }

    # 买方信息：优先 custom.buyer，其次订单/报价快照中的客户名
    buyer_default = custom.get("buyer") or {
        "company": order.get("customer_name") or quote.get("customer_name") or "",
        "address": custom.get("buyer_address", ""),
        "contact": custom.get("buyer_contact", ""),
    }

    items = custom.get("items") or order.get("items") or quote.get("items") or []

    data = {
        # 通用字段
        "seller": custom.get("seller") or seller_default,
        "buyer": buyer_default,
        "currency": doc.currency or custom.get("currency", "USD"),
        "total_amount": doc.total_amount if doc.total_amount is not None else custom.get("total_amount", ""),
        "items": items,

        # 编号与日期（以单证实际字段为准，custom 可覆盖）
        "quote_no": custom.get("quote_no") or (quote.get("quote_no") if quote else doc.doc_no),
        "quote_date": custom.get("quote_date") or doc.created_at.strftime("%Y-%m-%d") if doc.created_at else "",
        "valid_until": custom.get("valid_until", ""),
        "pi_no": custom.get("pi_no") or doc.doc_no,
        "pi_date": custom.get("pi_date") or doc.created_at.strftime("%Y-%m-%d") if doc.created_at else "",
        "contract_no": custom.get("contract_no") or doc.doc_no,
        "contract_date": custom.get("contract_date") or doc.created_at.strftime("%Y-%m-%d") if doc.created_at else "",
        "invoice_no": custom.get("invoice_no") or doc.doc_no,
        "invoice_date": custom.get("invoice_date") or (doc.issued_at.strftime("%Y-%m-%d") if doc.issued_at else ""),
        "pl_no": custom.get("pl_no") or doc.doc_no,
        "pl_date": custom.get("pl_date") or doc.created_at.strftime("%Y-%m-%d") if doc.created_at else "",
        "bl_no": custom.get("bl_no") or doc.doc_no,
        "co_no": custom.get("co_no") or doc.doc_no,
        "policy_no": custom.get("policy_no") or doc.doc_no,
        "issue_date": custom.get("issue_date") or (doc.issued_at.strftime("%Y-%m-%d") if doc.issued_at else ""),

        # 条款与物流（主要来自 custom）
        "payment_terms": custom.get("payment_terms", ""),
        "delivery_time": custom.get("delivery_time", ""),
        "incoterm": custom.get("incoterm", ""),
        "port_of_loading": custom.get("port_of_loading", ""),
        "port_of_destination": custom.get("port_of_destination", ""),
        "port_of_discharge": custom.get("port_of_discharge") or custom.get("port_of_destination", ""),
        "shipping_marks": custom.get("shipping_marks", ""),
        "bank_info": custom.get("bank_info", {}),
        "remarks": custom.get("remarks", ""),

        # 合同条款
        "inspection": custom.get("inspection", ""),
        "claims": custom.get("claims", ""),
        "force_majeure": custom.get("force_majeure", ""),
        "arbitration": custom.get("arbitration", ""),

        # 装箱单汇总
        "total_qty": custom.get("total_qty", ""),
        "total_gross_weight": custom.get("total_gross_weight", ""),
        "total_net_weight": custom.get("total_net_weight", ""),
        "total_volume": custom.get("total_volume", ""),

        # 提单
        "shipper": custom.get("shipper") or custom.get("seller") or seller_default,
        "consignee": custom.get("consignee") or buyer_default,
        "notify_party": custom.get("notify_party", {}),
        "vessel": custom.get("vessel", ""),
        "booking_no": custom.get("booking_no", ""),
        "place_of_delivery": custom.get("place_of_delivery", ""),
        "place_of_issue": custom.get("place_of_issue", ""),
        "description_of_goods": custom.get("description_of_goods", ""),
        "gross_weight": custom.get("gross_weight", ""),
        "volume": custom.get("volume", ""),
        "quantity": custom.get("quantity", ""),
        "freight_terms": custom.get("freight_terms", ""),

        # 原产地证
        "exporter": custom.get("exporter") or custom.get("seller") or seller_default,
        "transport_details": custom.get("transport_details", ""),
        "country_of_origin": custom.get("country_of_origin", "China"),
        "items_rows": custom.get("items_rows", ""),

        # 保险单
        "insured": custom.get("insured") or buyer_default,
        "insured_amount": custom.get("insured_amount", ""),
        "conveyance": custom.get("conveyance") or custom.get("vessel", ""),
        "sailing_date": custom.get("sailing_date", ""),
        "coverage": custom.get("coverage", ""),

        # 其他
        "title": custom.get("title", ""),
        "doc_no": doc.doc_no,
        "doc_date": doc.created_at.strftime("%Y-%m-%d") if doc.created_at else "",
        "content": custom.get("content", ""),
    }
    return data


@router.get("/trade-docs/{doc_id}/render", response_class=HTMLResponse)
async def render_trade_doc(
    doc_id: int,
    preview: bool = Query(False, description="预览模式：注入示例数据"),
    auth: AuthContext = Depends(get_auth_context),
    db=Depends(get_db_session),
):
    """渲染单证为 HTML（浏览器可直接打印为 PDF）"""
    tenant_id = tenant_id_of(auth)
    d = (await db.execute(
        select(TradeDoc).where(TradeDoc.tenant_id == tenant_id, TradeDoc.id == doc_id)
    )).scalar_one_or_none()
    if d is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "DOC_NOT_FOUND"})

    data = _build_render_data(d)
    try:
        html = trade_doc_renderer.render_trade_doc(d.doc_type, data)
    except ValueError as e:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "RENDER_FAILED", "detail": str(e)})
    return HTMLResponse(content=html)
