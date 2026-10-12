# -*- coding: utf-8 -*-
"""把 Tim 单已有的 PI / 报价单内容逐格打印，作为后续单证的数据源。"""
import openpyxl

FILES = [
    r"D:\projects\报价制作\Proforma Invoice - Tim - 20260929.xlsx",
    r"D:\projects\报价制作\Fence Quotation - Tim - 20260928.xlsx",
]

for path in FILES:
    print("=" * 100)
    print(path)
    print("=" * 100)
    wb = openpyxl.load_workbook(path, data_only=True)
    for ws in wb.worksheets:
        print(f"--- sheet: {ws.title}  dims={ws.dimensions} ---")
        for row in ws.iter_rows():
            for c in row:
                if c.value is None:
                    continue
                v = c.value
                if isinstance(v, float):
                    v = repr(v)
                print(f"{c.coordinate}\t{ws.column_dimensions[c.column_letter].width}\t{v}")
            # 行高
        for r in sorted(ws.row_dimensions.keys()):
            print(f"[rowheight] {r}\t{ws.row_dimensions[r].height}")
