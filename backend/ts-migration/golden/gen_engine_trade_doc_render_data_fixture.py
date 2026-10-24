# -*- coding: utf-8 -*-
r"""生成 P2 第三个切片金标 fixture：GET /api/v1/trade-docs/{doc_id}/render-data。

为什么要有这个脚本（而不是手写 fixture）
==========================================
fixture 里的 old_sql / facade / response 必须来自**旧路径真实跑一遍**，否则「改造前后一致」
无从谈起。本脚本用内核旧端点 + 桩 DB 跑一遍，把「实际发出的 SQL、绑定参数、响应 JSON」
原样落盘；两侧测试（backend/worker/tests/test_engine_rpc_trade_docs_render_data.py 与
backend/ts-worker/tests/engine-trade-docs-render-data.test.ts）都读**同一份** fixture。

本切片与 export-quote 同族切片的差异（契约要点见 docs/P2_COUPLING_ENGINE_2026-10-24.md §6.3（三条硬规则）+ 本脚本 facade 段）：
- render-data 的装配链是「读一步、按结果再决定读什么」（§7.2 的 C 类形态）⇒ 门面按
  **_render_dataset_plan** 的**最小集合**供数，且每个 dataset 允许与旧 SQL 的列/谓词形态不同
  （批量/整表下发），语义等价由 response 金标 + Python 侧「旧路径 SQL 不变」断言共同锁定；
- 图片/公章是**短期签名直链**（token 里含 time.time() 的 exp）⇒ 生成器与两侧测试都**冻结**
  kaas_common.files.token.time（否则每次生成都变，fixture 无法稳定）。

用法（Windows / PowerShell 5.1；必须从 backend/worker 目录跑，借它的 uv 环境）：
  $env:UV_CACHE_DIR='D:\tools\uv-cache'; $env:PYTHONUTF8='1'
  cd backend/worker
  uv run --frozen --with pytest --with httpx2 python ../ts-migration/golden/gen_engine_trade_doc_render_data_fixture.py

纪律：
- 只有**故意**改响应形状/供数契约时才重跑，且 PR 里必须人工 review fixture diff（尤其 response 段）；
- 测试禁止自更新 fixture（防止「测试跟着错误实现走」）；
- 幂等：同一命令重跑两次 sha256 相同（时间已冻结）。
"""
from __future__ import annotations

import json
import platform
import re
import sys
from datetime import datetime
from pathlib import Path

# 预热 stdlib platform / asyncpg（与 export-quote 生成器同款注释）
import asyncpg  # noqa: F401

platform.uname()

BACKEND = Path(__file__).resolve().parents[2]          # backend/
WORKER = BACKEND / "worker"
sys.path.insert(0, str(WORKER / "src"))
sys.path.insert(0, str(WORKER / "tests"))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

import kaas_common.files.token as _asset_token_mod  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=False)

# ── 冻结时间（签名 URL 的 exp 来源）─────────────────────────────────────────
# 2026-10-24T00:00:00Z；token exp = ASSET_TIME + 900。
ASSET_TIME = 1761264000.0
_ASSET_TTL = 900


class _FrozenTime:
    @staticmethod
    def time() -> float:
        return ASSET_TIME


# ── 身份（本切片沿用既有判定：owner_scope/owner_id/team_id 三条可见性口径）──
ACTOR = {
    "id": 5, "email": "buyer@qa.test", "display_name": "买家",
    "account_type": "customer", "role": "owner", "status": "active",
    "team_id": 2, "console_access": False, "plan": "free", "is_tenant_admin": False,
}

DOC_ID = 1

# ── 供数行（= 门面会下发的 dataset；JSON 口径见契约 §6.3）──────────────────
# 单据：owner_scope='private' + owner_id 不是本人 + team_id 命中 ⇒ 走「同团队可见」分支
# （顺带覆盖 file_objects 的团队谓词）。
TRADE_DOC = {
    "id": DOC_ID,
    "tenant_id": "default",
    "doc_no": "PI-2026-0001",
    "doc_type": "pi",
    "order_id": 3,
    "customer_id": 9,
    "quote_id": None,
    "status": "draft",
    "currency": "USD",
    "total_amount": 12345.67,
    # 微秒必须保留（Python isoformat 的精度口径）：ISO 文本由门面用 to_char 生成，
    # 绝不能用 JS Date（只有毫秒）—— 否则 doc.updated_at 等字段在真实数据下静默截断。
    "issued_at": "2026-10-21T08:00:00+00:00",
    "issued_by": "ops@kaas.io",
    "owner_id": "99",
    "owner_scope": "private",
    "team_id": 2,
    "with_seal": None,
    "created_at": "2026-10-20T02:30:00.123456+00:00",
    # 零微秒样本（Python isoformat 省略小数；docs §8.9 的 parity 缺口回归点）
    "updated_at": "2026-10-24T03:04:05+00:00",
    "raw_payload": {
        "sources": {
            "order": {
                "order_no": "SO-2026-0007",
                "currency": "USD",
                "items": [{
                    "product_name": "牛栏网",
                    "qty": 100,
                    "qty_unit": "roll",
                    "unit_price": 12.5,
                    "line_amount": 1250,
                    "spec_snapshot": {"specification": "1.8m x 30m"},
                }],
                "incoterm": "FOB",
                "payment_terms": "T/T 30% deposit",
                "port_of_loading": "Tianjin",
                "port_of_destination": "Hamburg",
                "country_of_origin": "China",
            },
        },
        "custom": {
            "product_key": "field_fence",
            # 三种条目混排（契约：ref / 已是图源 / 无效 ref 原样透传）
            "product_photos": [
                {"file_id": 12, "caption": "成品图"},
                {"file_id": 13},
                {"image": "https://example.invalid/offline.png", "caption": "离线图"},
                {"file_id": "abc"},
            ],
            "shipping_marks": "N/M",
        },
    },
}

TENANT_PROFILE = {
    "tenant_id": "default",
    "name_en": "HEBEI KAAS TRADING CO., LTD",
    "address_en": "No.1 Industry Road, Anping, Hebei, China",
    "phone": "+86 318 000 0000",
    "email": "sales@kaas.example",
    "bank_name": "Bank of China",
    "bank_account": "6217 0000 0000 0000",
    "swift_code": "BKCHCNBJ",
    "bank_address_en": "Bank of China, Shijiazhuang Branch",
    "tax_id": "91130000XXXXXXXX",
    "default_incoterm": "CIF",
    "default_payment_terms": "L/C",
    "default_country_of_origin": "China",
}

CUSTOMER = {"id": 9, "name": "ACME GMBH", "address": "Hamburg, Germany"}
CONTACT = {"name": "Hans Muller", "phone": "+49 40 000000", "email": "hans@acme.example"}

DEFAULT_SEAL = {"id": 7, "mime": "image/png"}

PRODUCT_PROFILES = [{
    "product_key": "field_fence",
    "info": {"hs_code": "7314.41.00", "material": "Galvanized steel"},
    "team_id": 2,
}]

FILE_OBJECTS = [
    {
        "id": 12, "name": "成品图.png", "content_type": "image/png",
        "file_name": "product.png", "object_key": "files/12.png",
        "storage": "r2", "team_id": 2,
    },
    {
        "id": 13, "name": "包装图.jpg", "content_type": "image/jpeg",
        "file_name": "pack.jpg", "object_key": "files/13.jpg",
        "storage": "r2", "team_id": 2,
    },
]

DATASETS = {
    "trade_docs": [TRADE_DOC],
    "tenant_company_profile": [TENANT_PROFILE],
    "customers": [CUSTOMER],
    "cust_contacts": [CONTACT],
    "tenant_company_seals": [DEFAULT_SEAL],
    "product_profiles": PRODUCT_PROFILES,
    "file_objects": FILE_OBJECTS,
}

# ── 门面供数契约（TS 侧 engine.ts 的 SQL 必须与这里逐字一致；由 fixture 锁定）──
# 差异说明（与旧路径相比，语义等价，见契约文档）：
# - tenant_company_seals：不下发 png_bytes（字节列不进 JSON；生产/测试都有签名直链）；
# - product_profiles：整表（租户内一行/产品）下发，由内核按 product_key_of 选行；
# - file_objects：按 id 批量（ANY），列不含 content 字节；
# - customers/cust_contacts 旧路径按需查，门面在「customer_id 可转正整数」时查（同一条件）。
#: 时间戳列显式 to_char 成 Python `datetime.isoformat()` 口径 —— JS Date 只有毫秒，
#: 直接下发会在真实数据下把 doc.updated_at 之类的字段静默截断（本切片最重要的类型边界）。
#: ⚠️ 微秒为 0 时 Python isoformat **省略**小数（docs §8.9 真库核对抓到的 parity 缺口）⇒
#: 必须**条件式**：先判 US 再选「带/不带小数」的格式，统一拼 +00:00。
_TS = (
    "CASE WHEN to_char(%(c)s AT TIME ZONE 'UTC', 'US') = '000000'"
    " THEN to_char(%(c)s AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS')"
    " ELSE to_char(%(c)s AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US')"
    " END || '+00:00' AS %(c)s"
)


def _ts(col: str) -> str:
    return _TS % {"c": col}


FACADE_SQL = {
    "trade_docs": {
        "sql": (
            "SELECT id, tenant_id, doc_no, doc_type, order_id, customer_id, quote_id,"
            " status, currency, total_amount, %s, issued_by, raw_payload, owner_id,"
            " owner_scope, team_id, with_seal, %s, %s"
            " FROM trade_docs WHERE tenant_id=$1 AND id=$2"
        ) % (_ts("issued_at"), _ts("created_at"), _ts("updated_at")),
        "params": ["default", DOC_ID],
    },
    "tenant_company_profile": {
        "sql": "SELECT * FROM tenant_company_profile WHERE tenant_id=$1",
        "params": ["default"],
    },
    "customers": {
        "sql": "SELECT id, name, address FROM customers WHERE tenant_id=$1 AND id=$2",
        "params": ["default", 9],
    },
    "cust_contacts": {
        "sql": ("SELECT name, phone, email FROM cust_contacts"
                " WHERE tenant_id=$1 AND customer_id=$2 ORDER BY is_primary DESC, id LIMIT 1"),
        "params": ["default", 9],
    },
    "tenant_company_seals": {
        "sql": ("SELECT id, mime FROM tenant_company_seals"
                " WHERE tenant_id=$1 AND is_default ORDER BY id LIMIT 1"),
        "params": ["default"],
    },
    "product_profiles": {
        "sql": "SELECT product_key, info, team_id FROM product_profiles WHERE tenant_id=$1",
        "params": ["default"],
    },
    "file_objects": {
        # id 是必需列：内核按 id 建 map 再按 photo 引用顺序装配（旧路径的 id 在 SQL 谓词里，
        # 行上不需要；供数路径必须带上，否则内核无法把行对回引用）。
        "sql": ("SELECT id, name, content_type, file_name, object_key, storage, team_id"
                " FROM file_objects WHERE tenant_id=$1 AND id = ANY($2) AND is_current"
                " AND team_id=$3"),
        "params": ["default", [12, 13], 2],
    },
}

REQUEST = {
    "doc_id": DOC_ID,
    "request_context": {"host": "testserver", "x_forwarded_proto": "http"},
}

captured: list[tuple[str, list]] = []


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


def _py_row(row: dict) -> dict:
    """dataset 行 → 旧路径桩的形状（时间戳还原成 datetime；doc_dict 只能吃 datetime）。"""
    out = dict(row)
    for field in ("created_at", "issued_at"):
        value = out.get(field)
        if isinstance(value, str) and value:
            out[field] = datetime.fromisoformat(value)
    return out


async def fake_fetchrow(request, sql, *args, table=None):
    captured.append((_norm(sql), list(args)))
    text = sql
    if "FROM trade_docs" in text:
        return _py_row(TRADE_DOC)
    if "FROM tenant_company_profile" in text:
        return dict(TENANT_PROFILE)
    if "FROM customers" in text:
        return dict(CUSTOMER)
    if "FROM cust_contacts" in text:
        return dict(CONTACT)
    if "FROM file_objects" in text:
        file_id = int(args[1])
        for row in FILE_OBJECTS:
            if row["id"] == file_id:
                return dict(row)
        return None
    if "FROM tenant_company_seals" in text:
        return dict(DEFAULT_SEAL)
    if "FROM product_profiles" in text:
        return {k: PRODUCT_PROFILES[0][k] for k in ("info", "team_id")}
    raise AssertionError("unexpected SQL in old path: " + sql)


async def fake_fetch(*_a, **_kw):
    raise AssertionError("render-data 旧路径不应走 db.fetch（多行版）")


def main() -> None:
    original_fetchrow = worker_main.db.fetchrow
    original_fetch = worker_main.db.fetch
    original_time = _asset_token_mod.time
    worker_main.db.fetchrow = fake_fetchrow
    worker_main.db.fetch = fake_fetch
    _asset_token_mod.time = _FrozenTime
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: dict(ACTOR)
    try:
        resp = client.get("/api/v1/trade-docs/%d/render-data" % DOC_ID)
    finally:
        worker_main.db.fetchrow = original_fetchrow
        worker_main.db.fetch = original_fetch
        _asset_token_mod.time = original_time
        worker_main.app.dependency_overrides.clear()

    assert resp.status_code == 200, resp.text
    body = resp.json()

    fixture = {
        "_comment": (
            "P2 第三个切片金标（docs/P2_COUPLING_ENGINE_2026-10-24.md §6.3/§8.3/§9#2）："
            "GET /trade-docs/{doc_id}/render-data（7 张表的装配链）。"
            "由同目录 gen_engine_trade_doc_render_data_fixture.py 用内核**旧路径**真实跑一遍生成："
            "response = 旧路径真实响应体；old_sql = 旧路径实际执行的 SQL 与绑定参数（按执行顺序）；"
            "facade = 门面**供数契约**（查哪些 dataset / SQL 文本 / 绑定参数）——TS 侧逐字断言；"
            "datasets = 门面下发给内核的行（Python 侧当 DB 返回、TS 侧当 payload 断言）；"
            "⚠️ 签名直链含时间戳（token 的 exp = time.time() + 900）⇒ **只在生成器与两侧测试"
            "进程内**把 kaas_common.files.token.time 冻结到 asset_time，保证 fixture 可复现；"
            "生产代码零改动（无任何时钟注入/全局开关）。"
            "⚠️ 时间戳样本同时覆盖「零微秒」（issued_at / updated_at ⇒ Python isoformat **无小数**）"
            "与「非零微秒」（created_at ⇒ 6 位小数）：门面 SQL 必须用条件式 to_char 才能两边都对"
            "（docs §8.9 的真库核对缺口）。"
        ),
        "endpoint": {
            "method": "GET",
            "path": "/api/v1/trade-docs/%d/render-data" % DOC_ID,
            "query_string": "",
        },
        "rpc": "/api/v1/internal/engine/trade-docs/render-data",
        "request": REQUEST,
        "asset_time": ASSET_TIME,
        "asset_ttl": _ASSET_TTL,
        "actor": {k: ACTOR[k] for k in (
            "id", "account_type", "role", "team_id", "is_tenant_admin")},
        "datasets": DATASETS,
        "old_sql": [{"sql": sql, "params": params} for sql, params in captured],
        "facade": FACADE_SQL,
        "response": body,
    }
    out = Path(__file__).with_name("engine-trade-doc-render-data.fixture.json")
    out.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("fixture written:", out.name, "bytes:", out.stat().st_size)
    print("old path db calls:", len(captured), "| response keys:", list(body))
    print("data keys:", list(body["data"]))


if __name__ == "__main__":
    main()
