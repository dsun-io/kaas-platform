"""把开发库里「我端到端测试时写入的残留数据」占位符化。

背景：端到端验证时用样例数据建了 1 条报价单 + 1 张已签发单证（租户 default），
它们被当成真实业务数据展示在系统里。按用户要求，把其中「真实主体类」取值
替换为与 sample-data.json 一致的方括号占位符（日期/金额/数量等格式值保留）。

用法：
  python scripts/placeholderize_demo_data.py            # 预演，只报告不改
  python scripts/placeholderize_demo_data.py --apply    # 实际执行
"""
from __future__ import annotations

import asyncio
import json
import pathlib
import sys

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

APPLY = "--apply" in sys.argv

ENV = pathlib.Path(__file__).resolve().parent.parent / ".env"
url = None
for line in ENV.read_text(encoding="utf-8").splitlines():
    if line.startswith("DATABASE_URL"):
        url = line.split("=", 1)[1].strip().strip('"')
if not url:
    raise SystemExit("未找到 DATABASE_URL")

# 真实主体类取值 → 明确占位符（与 frontend/src/lib/trade-doc/sample-data.json 保持一致）
MAPPING: dict[str, str] = {
    # 卖方 / 发货人 / 出口商
    "ANPING HENGTAI WIRE MESH PRODUCTS CO., LTD.": "[SELLER COMPANY NAME]",
    "Wire Mesh Industrial Park, Anping County, Hengshui, Hebei 053600, China": "[SELLER ADDRESS]",
    "Wire Mesh Industrial Park, Anping County, Hengshui, Hebei, China": "[FACTORY ADDRESS]",
    "+86-318-765-4321": "[TEL]",
    "export@hengtai-mesh.com": "[EMAIL]",
    # 买方 / 收货人 / 被保险人
    "Australian Rural Fencing Pty Ltd": "[BUYER COMPANY NAME]",
    "45 Outback Road, Toowoomba QLD 4350, Australia": "[BUYER ADDRESS]",
    "Mr. Jack Thompson": "[CONTACT PERSON]",
    "+61-7-4635-8899": "[TEL]",
    "jack.t@ausruralfencing.com.au": "[EMAIL]",
    # 商品
    "Cattle Fence (Hinge Joint)": "[PRODUCT NAME 1]",
    "Y Post (Plain, Galvanised)": "[PRODUCT NAME 2]",
    "Chain Link Fence (Galvanised)": "[PRODUCT NAME 3]",
    "2.5mm wire, 8/150/15, H1.5m x L50m/roll": "[SPECIFICATION 1]",
    "H1.8m, 1.8mm thickness, with clips": "[SPECIFICATION 2]",
    "50x50mm mesh, 3.0mm wire, H1.8m x L25m/roll": "[SPECIFICATION 3]",
    # 银行 / 运输
    "Bank of China, Anping Sub-branch": "[BANK NAME]",
    "4567 8901 2345 6789": "[ACCOUNT NO.]",
    "BKCHCNBJ220": "[SWIFT CODE]",
    "BANK OF CHINA, HEBEI BRANCH": "[PAYEE BANK]",
    "WESTPAC BANKING CORPORATION, BRISBANE": "[DRAWEE BANK]",
    "COSCO SHIPPING UNIVERSE / 088E": "[VESSEL / VOYAGE]",
    "Xingang, Tianjin, China": "[PORT OF LOADING]",
    "Brisbane, Australia": "[PORT OF DESTINATION]",
    "Tianjin, China": "[PLACE OF ISSUE]",
    "FOB Tianjin": "[INCOTERM]",
    "T/T 30% deposit upon contract signing, balance against copy of B/L": "[PAYMENT TERMS]",
    "Within 25 days after receipt of deposit": "[DELIVERY TIME]",
    "CATTLE FENCE, Y POST AND CHAIN LINK FENCE": "[DESCRIPTION OF GOODS]",
    "HT2026-0918": "[BATCH NO.]",
    "CSNU7654321": "[CONTAINER NO.]",
    "CN1234567": "[SEAL NO.]",
}


def map_value(v):
    """递归替换：只动字符串取值，不改结构，不碰数字与日期。"""
    if isinstance(v, str):
        return MAPPING.get(v, v)
    if isinstance(v, dict):
        return {k: map_value(x) for k, x in v.items()}
    if isinstance(v, list):
        return [map_value(x) for x in v]
    return v


# 不扫描的表：迁移版本记录，与业务数据无关
EXCLUDE_TABLES = {"alembic_version"}

TEXT_TYPES = ("text", "character varying", "character")


async def all_tables(c) -> list[str]:
    """自动发现 public 下的所有表。

    为什么不用写死的清单：表名会变（例如联系人表叫 customer_contacts 就猜错了）。
    换成发现式后，不管实际叫什么都全覆盖；又因为只做「整值精确匹配」，
    扫描多余的表也不会误伤任何数据。
    """
    rows = (await c.execute(text(
        "select table_name from information_schema.tables "
        "where table_schema='public' and table_type='BASE TABLE' "
        "order by table_name"))).all()
    return [r.table_name for r in rows if r.table_name not in EXCLUDE_TABLES]


async def main() -> None:
    engine = create_async_engine(url)
    async with engine.begin() as c:
        tables = await all_tables(c)
        print("=" * 74)
        print("预演（加 --apply 才真正改动）" if not APPLY else "执行")
        print(f"扫描 {len(tables)} 张表：{', '.join(tables)}")
        print("=" * 74)

        for table in tables:
            cols = (await c.execute(text(
                "select column_name, data_type from information_schema.columns "
                "where table_name=:t order by ordinal_position"), {"t": table})).all()
            if not cols:
                print(f"  {table}: 表不存在，跳过")
                continue

            text_cols = [r.column_name for r in cols if r.data_type in TEXT_TYPES]
            json_cols = [r.column_name for r in cols if "json" in r.data_type]
            if not text_cols and not json_cols:
                continue

            # 一次读全表（ctid 作行标识），在内存里改，只回写命中行。
            # 不用「逐字段逐映射发 SQL」：9 张表 × 几十字段 × 几十映射 = 上千次查询，实测会卡死。
            sel = ", ".join(["ctid"] + text_cols + json_cols)
            rows = (await c.execute(text(f"select {sel} from {table}"))).mappings().all()

            hits = 0
            for row in rows:
                sets: list[str] = []
                wheres: list[str] = []
                params: dict = {}
                for col in text_cols:
                    v = row[col]
                    if isinstance(v, str) and v in MAPPING:
                        sets.append(f"{col} = :set_{col}")
                        wheres.append(f"{col} = :old_{col}")
                        params[f"set_{col}"] = MAPPING[v]
                        params[f"old_{col}"] = v
                        print(f"    {table}.{col}: {v[:40]!r}… → {MAPPING[v]!r}")
                for col in json_cols:
                    v = row[col]
                    if v is None:
                        continue
                    try:
                        payload = json.loads(v) if isinstance(v, str) else v
                    except Exception:
                        continue  # json 列里也可能存着纯文本，解析不了就跳过
                    new = map_value(payload)
                    if new != payload:
                        sets.append(f"{col} = CAST(:set_{col} AS jsonb)")
                        # jsonb 用「结构相等」定位行，避免依赖文本格式（jsonb 会规范化空白）
                        wheres.append(f"{col} = CAST(:old_{col} AS jsonb)")
                        params[f"set_{col}"] = json.dumps(new, ensure_ascii=False)
                        params[f"old_{col}"] = json.dumps(payload, ensure_ascii=False)
                        print(f"    {table}.{col}: 快照含样例值 → 占位符化")
                if not sets:
                    continue
                hits += 1
                if APPLY:
                    # 定位条件 = 上述各列的「原值」：只会命中当前恰好等于样例值的行，
                    # 既不依赖主键名（各表不一），也避开了 ctid 的类型转换坑。
                    await c.execute(
                        text(f"update {table} set {', '.join(sets)} where {' AND '.join(wheres)}"),
                        params,
                    )
            print(f"  [{table}] 命中 {hits} 行")

        # 残留自检：整表读入内存后查找，避免上千条 count 查询
        print("\n残留检查（应为 0）：")
        left = 0
        for table in tables:
            cols = (await c.execute(text(
                "select column_name, data_type from information_schema.columns "
                "where table_name=:t"), {"t": table})).all()
            searchable = [r.column_name for r in cols
                          if r.data_type in TEXT_TYPES or "json" in r.data_type]
            if not searchable:
                continue
            rows = (await c.execute(text(
                f"select ctid, {', '.join(searchable)} from {table}"))).mappings().all()
            for row in rows:
                for col in searchable:
                    v = row[col]
                    if v is None:
                        continue
                    sv = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
                    for old in MAPPING:
                        if old in sv:
                            left += 1
                            print(f"  ⚠ {table}.{col} {row['ctid']}: 仍含 {old[:40]!r}")
                            break
        if not left:
            print("  ✓ 全库未发现样例值残留")

    await engine.dispose()


asyncio.run(main())
