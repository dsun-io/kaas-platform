"""生成一份示例 PI 单证(用模拟业务数据,验证模板渲染效果)

用法:
  cd backend/orchestrator
  python scripts/render_sample_doc.py
输出:
  sample_pi.html (可直接浏览器打开预览/打印 PDF)
"""
import sys
from pathlib import Path

# 保证能 import app 包
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.renderers import trade_doc_renderer

SAMPLE_DATA = {
    "seller": {
        "company": "安平县恒泰金属丝网制品有限公司",
        "address": "河北省衡水市安平县丝网工业园区 88 号",
        "phone": "+86-318-7654321",
        "email": "export@hengtai-mesh.com",
    },
    "buyer": {
        "company": "Australian Rural Fencing Pty Ltd",
        "address": "45 Outback Road, Toowoomba QLD 4350, Australia",
        "contact": "Mr. Jack Thompson",
    },
    "pi_no": "PI-202609-0001",
    "pi_date": "2026-09-26",
    "currency": "USD",
    "items": [
        {
            "product_name": "牛栏网 Cattle Fence (拧编 Hinge Joint)",
            "specification": "丝径 2.5mm, 8/150/15, 高1.5m, 卷长50m",
            "qty": 500,
            "qty_unit": "Rolls",
            "unit_price": 28.50,
            "line_amount": 14250.00,
        },
        {
            "product_name": "Y型立柱 Y Post (直边 Plain)",
            "specification": "高1.8m, 镀锌, 带卡扣",
            "qty": 2000,
            "qty_unit": "Pcs",
            "unit_price": 2.80,
            "line_amount": 5600.00,
        },
        {
            "product_name": "勾花网 Chain Link Fence",
            "specification": "网孔 50x50mm, 丝径 3.0mm, 高1.8m, 卷长25m",
            "qty": 300,
            "qty_unit": "Rolls",
            "unit_price": 22.00,
            "line_amount": 6600.00,
        },
    ],
    "total_amount": 26450.00,
    "payment_terms": "T/T 30% 定金,余款见提单副本 T/T 30% deposit, balance against copy of B/L",
    "delivery_time": "收到定金后 25 天内 Within 25 days after receipt of deposit",
    "incoterm": "FOB Tianjin",
    "port_of_loading": "Xingang, Tianjin, China",
    "port_of_destination": "Brisbane, Australia",
    "bank_info": {
        "bank": "中国银行安平支行 Bank of China, Anping Sub-branch",
        "account": "4567 8901 2345 6789",
        "swift": "BKCHCNBJ220",
    },
}


def main() -> None:
    html = trade_doc_renderer.render_trade_doc("pi", SAMPLE_DATA)
    out = Path(__file__).parent.parent / "sample_pi.html"
    out.write_text(html, encoding="utf-8")
    print(f"OK 已生成示例 PI: {out}")
    print(f"  数据校验: 总金额 = {SAMPLE_DATA['total_amount']}, 行项数 = {len(SAMPLE_DATA['items'])}")


if __name__ == "__main__":
    main()
