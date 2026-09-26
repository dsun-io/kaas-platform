"""生成全部单证类型的英文样例，用于版面评审与打印效果验证

用法:
  cd backend/orchestrator
  python scripts/render_all_samples.py

输出:
  sample_docs/sample_<doc_type>.html —— 自包含 HTML（内联样式），
  双击即可用浏览器打开预览，Ctrl+P 可直接打印为 A4 PDF。

说明:
  示例数据全部使用**英文**（国际单证惯例）：境外客户、银行、海关均按英文审单，
  卖方（中国出口商）信息同样使用英文名称与英文地址，避免境外方无法辨识。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.renderers import trade_doc_renderer

SELLER = {
    "company": "ANPING HENGTAI WIRE MESH PRODUCTS CO., LTD.",
    "address": "Wire Mesh Industrial Park, Anping County, Hengshui, Hebei 053600, China",
    "phone": "+86-318-765-4321",
    "email": "export@hengtai-mesh.com",
}

BUYER = {
    "company": "Australian Rural Fencing Pty Ltd",
    "address": "45 Outback Road, Toowoomba QLD 4350, Australia",
    "contact": "Mr. Jack Thompson",
    "phone": "+61-7-4635-8899",
    "email": "jack.t@ausruralfencing.com.au",
}

# 商品行项：合计 500×28.50 + 2000×2.80 + 300×22.00 = USD 26,450.00
ITEMS = [
    {
        "product_name": "Cattle Fence (Hinge Joint)",
        "specification": "2.5mm wire, 8/150/15, H1.5m x L50m/roll",
        "qty": 500, "qty_unit": "Rolls", "unit_price": 28.50, "line_amount": 14250.00,
        "hs_code": "7314410000", "package": 500,
        "gross_weight": 12500, "net_weight": 12300, "volume": 22.50,
    },
    {
        "product_name": "Y Post (Plain, Galvanised)",
        "specification": "H1.8m, 1.8mm thickness, with clips",
        "qty": 2000, "qty_unit": "Pcs", "unit_price": 2.80, "line_amount": 5600.00,
        "hs_code": "7308900000", "package": 100,
        "gross_weight": 9800, "net_weight": 9600, "volume": 8.40,
    },
    {
        "product_name": "Chain Link Fence (Galvanised)",
        "specification": "50x50mm mesh, 3.0mm wire, H1.8m x L25m/roll",
        "qty": 300, "qty_unit": "Rolls", "unit_price": 22.00, "line_amount": 6600.00,
        "hs_code": "7314490000", "package": 300,
        "gross_weight": 4200, "net_weight": 4100, "volume": 6.60,
    },
]

BASE = {
    # ── 交易双方 ────────────────────────────────────────────────
    "seller": SELLER,
    "buyer": BUYER,
    "shipper": SELLER,
    "exporter": SELLER,
    "consignee": BUYER,
    "insured": BUYER,
    "notify_party": {
        "company": "Same as consignee",
        "address": "45 Outback Road, Toowoomba QLD 4350, Australia",
        "contact": "Mr. Jack Thompson",
    },

    # ── 金额 ────────────────────────────────────────────────────
    "currency": "USD",
    "total_amount": 26450.00,
    "insured_amount": 29095.00,          # 按发票金额 110% 投保
    "items": ITEMS,

    # ── 单据编号与日期（2026 年 9-10 月一票真实节奏）──────────────
    "quote_no": "QT-202609-0001", "quote_date": "2026-09-26", "valid_until": "2026-10-26",
    "pi_no": "PI-202609-0001", "pi_date": "2026-09-28",
    "contract_no": "SC-202609-0001", "contract_date": "2026-10-06",
    "invoice_no": "CI-202609-0001", "invoice_date": "2026-10-20", "lc_no": "LC-ABC-2026-123456",
    "pl_no": "PL-202609-0001", "pl_date": "2026-10-20",
    "co_no": "CO-202609-0001", "policy_no": "PICC-2026-0001",
    "bl_no": "COSU2026090001", "booking_no": "COSU-BK-2026090001",
    "issue_date": "2026-10-21", "sailing_date": "2026-10-24",
    "doc_no": "DOC-202609-0001", "doc_date": "2026-10-22",

    # ── 条款与物流 ──────────────────────────────────────────────
    "incoterm": "FOB Tianjin",
    "payment_terms": "T/T 30% deposit upon contract signing, balance against copy of B/L",
    "delivery_time": "Within 25 days after receipt of deposit",
    "port_of_loading": "Xingang, Tianjin, China",
    "port_of_destination": "Brisbane, Australia",
    "port_of_discharge": "Brisbane, Australia",
    "place_of_delivery": "Brisbane, Australia",
    "place_of_issue": "Tianjin, China",
    "shipping_marks": "N/M",
    "vessel": "COSCO SHIPPING UNIVERSE / 088E",
    "conveyance": "COSCO SHIPPING UNIVERSE / 088E",
    "freight_terms": "Freight Prepaid",
    "transport_details": "By Sea",
    "country_of_origin": "China",
    "coverage": "All Risks and War Risk as per CIC of PICC",

    # ── 收付款 ──────────────────────────────────────────────────
    "bank_info": {
        "bank": "Bank of China, Anping Sub-branch",
        "account": "4567 8901 2345 6789",
        "swift": "BKCHCNBJ220",
    },

    # ── 装箱汇总（未提供时由行项自动汇总）──────────────────────
    "total_gross_weight": 26500, "total_net_weight": 26000, "total_volume": 37.50,

    # ── 货物描述（提单 / 保单 / 各类证明用）─────────────────────
    "description_of_goods": "CATTLE FENCE, Y POST AND CHAIN LINK FENCE",
    "gross_weight": 26500, "volume": 37.50, "quantity": "2800",

    # ── 装运通知 ───────────────────────────────────────────────
    "advice_no": "SA-202609-0001", "advice_date": "2026-10-21",
    "etd": "2026-10-24", "eta": "2026-11-08",

    # ── 汇票（信用证议付）──────────────────────────────────────
    "draft_no": "DR-202609-0001", "draft_date": "2026-10-21",
    "tenor": "SIGHT",   # 模板已含 At ... of this FIRST of Exchange，此处只填期限本身
    "payee": "BANK OF CHINA, HEBEI BRANCH",
    "drawee": "WESTPAC BANKING CORPORATION, BRISBANE",
    "issuing_bank": "WESTPAC BANKING CORPORATION, BRISBANE",
    "lc_date": "2026-09-15",

    # ── 受益人证明 / 非木质包装声明 ─────────────────────────────
    "cert_no": "BEN-202609-0001", "cert_date": "2026-10-21",
    "declaration_no": "NWP-202609-0001", "declaration_date": "2026-10-21",

    # ── 重量单 ─────────────────────────────────────────────────
    "weight_list_no": "WL-202609-0001", "weight_list_date": "2026-10-20",

    # ── 质量证明 ───────────────────────────────────────────────
    "quality_cert_no": "QC-202609-0001", "quality_cert_date": "2026-10-19",
    "batch_no": "HT2026-0918",
    "standard_applied": "GB/T 26941.1-2004 and contract specification",
    "inspection_result": "QUALIFIED",

    # ── 制造商证明 ─────────────────────────────────────────────
    "mfr_cert_no": "MC-202609-0001", "mfr_cert_date": "2026-10-19",
    "factory_address": "Wire Mesh Industrial Park, Anping County, Hengshui, Hebei, China",

    # ── 报关信息 / 熏蒸申请 ───────────────────────────────────
    "customs_decl_no": "CD-202609-0001", "customs_decl_date": "2026-10-21",
    "trade_mode": "General Trade (0110)", "transport_mode": "By Sea",
    "destination_country": "Australia",
    "container_no": "CSNU7654321", "seal_no": "CN1234567",
    "fumi_cert_no": "FUM-202609-0001", "fumi_cert_date": "2026-10-22",
    "treatment": "FUMIGATION", "fumigant": "METHYL BROMIDE",
    "dosage": "48 g/m3", "duration": "24 HOURS",
    "temperature": "21 C MINIMUM", "treatment_date": "2026-10-22",

    # ── 合同条款 ────────────────────────────────────────────────
    "inspection": "Inspection by CIQ at port of loading; certificate to form part of documents",
    "claims": "Claims to be raised within 30 days after arrival of goods at destination",
    "force_majeure": "Standard force majeure clause applies; affected party to notify within 14 days",
    "arbitration": "Disputes to be settled by CIETAC arbitration in Beijing",
}

OUT_DIR = Path(__file__).parent.parent / "sample_docs"
DOC_TYPES = [
    # 出口商自制（正式件）
    "quotation", "pi", "contract", "ci", "pl",
    "shipping_advice", "draft", "beneficiary_cert", "non_wood_packing",
    "weight_list", "quality_cert", "manufacturer_cert",
    # 第三方签发（本系统产出申报 / 申请信息）
    "bl", "co", "insurance", "customs_declaration", "fumigation_cert",
    # 通用
    "other",
]

# 通用单证演示内容（content 字段按原始 HTML 透传）
OTHER_DOC_CONTENT = (
    "<p>We hereby declare that the goods described in the above-mentioned invoice have been "
    "exported from the People's Republic of China in accordance with the applicable laws and "
    "regulations, and that all statements made herein are true and correct.</p>"
)


def main() -> None:
    OUT_DIR.mkdir(exist_ok=True)
    for doc_type in DOC_TYPES:
        data = dict(BASE)
        if doc_type == "other":
            data["title"] = "Exporter's Declaration"
            data["content"] = OTHER_DOC_CONTENT
        html = trade_doc_renderer.render_trade_doc(doc_type, data)
        out = OUT_DIR / f"sample_{doc_type}.html"
        out.write_text(html, encoding="utf-8")
        print(f"OK {doc_type:20s} -> {out.name} ({len(html)} bytes)")

    print()
    print("模板总数:", len(trade_doc_renderer.get_available_templates()))
    print("金额大写:", trade_doc_renderer.amount_in_words(26450.00, "USD"))


if __name__ == "__main__":
    main()
