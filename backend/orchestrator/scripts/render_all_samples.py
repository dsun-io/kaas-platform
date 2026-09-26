import sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd()))

from app.renderers import trade_doc_renderer

# 各单证类型的最小示例数据
base = {
    "seller": {"company": "安平县恒泰金属丝网制品有限公司", "address": "河北省安平县丝网园区88号", "phone": "+86-318-7654321", "email": "export@hengtai-mesh.com"},
    "buyer": {"company": "Australian Rural Fencing Pty Ltd", "address": "45 Outback Rd, Toowoomba QLD 4350, Australia", "contact": "Mr. Jack Thompson"},
    "shipper": {"company": "安平县恒泰金属丝网制品有限公司", "address": "河北省安平县丝网园区88号"},
    "consignee": {"company": "Australian Rural Fencing Pty Ltd", "address": "45 Outback Rd, Toowoomba QLD 4350, Australia"},
    "notify_party": {"company": "Same as consignee"},
    "exporter": {"company": "安平县恒泰金属丝网制品有限公司", "address": "河北省安平县丝网园区88号"},
    "insured": {"company": "Australian Rural Fencing Pty Ltd"},
    "currency": "USD",
    "total_amount": 26450.00,
    "items": [
        {"product_name": "牛栏网 Cattle Fence", "specification": "2.5mm, 高1.5m, 50m/卷", "qty": 500, "qty_unit": "Rolls", "unit_price": 28.50, "line_amount": 14250.00, "hs_code": "73144100", "gross_weight": 12500, "net_weight": 12300, "volume": 22.5},
    ],
    "items_rows": '<tr><td>N/M</td><td>Cattle Fence</td><td>73144100</td><td>500 Rolls</td><td>12500 KGS</td></tr>',
    "payment_terms": "T/T 30% deposit, balance against copy of B/L",
    "delivery_time": "Within 25 days after deposit",
    "incoterm": "FOB Tianjin",
    "port_of_loading": "Xingang, Tianjin, China",
    "port_of_destination": "Brisbane, Australia",
    "port_of_discharge": "Brisbane, Australia",
    "place_of_delivery": "Brisbane, Australia",
    "place_of_issue": "Tianjin, China",
    "shipping_marks": "N/M",
    "bank_info": {"bank": "Bank of China, Anping", "account": "4567 8901 2345 6789", "swift": "BKCHCNBJ220"},
    "quote_no": "QUO-202609-0001", "quote_date": "2026-09-26", "valid_until": "2026-10-26",
    "pi_no": "PI-202609-0001", "pi_date": "2026-09-26",
    "contract_no": "CON-202609-0001", "contract_date": "2026-09-26",
    "invoice_no": "CI-202609-0001", "invoice_date": "2026-10-20", "lc_no": "LC-ABC-123456",
    "pl_no": "PL-202609-0001", "pl_date": "2026-10-20",
    "bl_no": "COSU2026090001", "vessel": "COSCO SHIPPING UNIVERSE / 088E",
    "co_no": "CO-202609-0001",
    "policy_no": "PICC-2026-0001",
    "issue_date": "2026-10-21",
    "inspection": "由中国商检出证 / Inspection by CIQ", "claims": "到货后30天内提出 / Within 30 days after arrival",
    "force_majeure": "不可抗力条款适用 / Standard force majeure clause applies", "arbitration": "提交中国国际经济贸易仲裁委员会 / CIETAC arbitration",
    "total_qty": "500 Rolls", "total_gross_weight": 12500, "total_net_weight": 12300, "total_volume": 22.5,
    "description_of_goods": "CATTLE FENCE, Y POST, CHAIN LINK FENCE", "gross_weight": 12500, "volume": 22.5, "quantity": "500 Rolls",
    "freight_terms": "Freight Prepaid",
    "transport_details": "By Sea",
    "country_of_origin": "China",
    "insured_amount": 29095.00, "conveyance": "COSCO SHIPPING UNIVERSE / 088E",
    "sailing_date": "2026-10-22", "coverage": "All Risks & War Risk (一切险+战争险)",
    "title": "受益人证明 Beneficiary Certificate", "doc_no": "DOC-202609-0001", "doc_date": "2026-09-26",
    "content": "<p>兹证明已按信用证要求寄送全套单据。We hereby certify that one full set of documents has been sent to the applicant as required by the L/C.</p>",
}

out_dir = Path("sample_docs")
out_dir.mkdir(exist_ok=True)
for t in ["quotation", "pi", "contract", "ci", "pl", "bl", "co", "insurance", "other"]:
    html = trade_doc_renderer.render_trade_doc(t, base)
    out = out_dir / f"sample_{t}.html"
    out.write_text(html, encoding="utf-8")
    print(f"OK {t:10s} -> {out} ({len(html)} bytes)")

print()
print("templates API:", [t["doc_type"] for t in trade_doc_renderer.get_available_templates()])
print("pi fields keys:", list(trade_doc_renderer.get_template_fields("pi").keys()))
