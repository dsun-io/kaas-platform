"""A14 包装事实 · API 级测试（facts 端点 + doc-set 触发器端到端）。

复用 `test_trade_doc_hardening_api.py` 的起手式/假 db/`_patched`，只在需要
`tenant_products` 产品定义（含 `packaging[]`）时补一条 SQL 路由。

覆盖：
1. 行 `spec_snapshot.packaging_id` 命中产品 packaging ⇒ facts 里
   `packing_method` 是产品 `method` 原文、`packing_type` 是归类枚举，
   `source=manual`、`evidence_ref` 带 `packaging_id`；
2. 本单没带 `packaging_id` ⇒ 用产品默认包装，`evidence_ref` 以
   `inferred:product_default` 标注（任务要求）；
3. 产品无 packaging 配置 ⇒ `packing_method=none` / `packing_type=none`；
4. 产品解析不到、只有快照里的包装名 ⇒ `inferred:snapshot`，仍能出 `packing_type`；
5. **doc-set GET 端到端**：`trigger_expr` 用 `packing_type` 求值 ——
   `packing_type != "wood"` 的非木包装声明在木质包装单上 `applicable=false`
   且 `skipped_by_trigger=true`；`packing_type == "wood"` 的熏蒸相关项则适用。
"""
from __future__ import annotations

import sys
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_trade_doc_hardening_api import (  # noqa: E402
    _FakeDb,
    _patched,
    client,
)

TEAM_USER = {"id": 10, "team_id": 1, "role": "member", "account_type": "internal"}

WOOD_PACKAGING = [
    {
        "id": "pk_wood",
        "name": "木托盘",
        "method": "木托盘",
        "is_default": True,
        "created_at": "2026-01-01T00:00:00Z",
    },
    {
        "id": "pk_carton",
        "name": "纸箱",
        "method": "纸箱",
        "is_default": False,
        "created_at": "2026-02-01T00:00:00Z",
    },
]


class _PackingFakeDb(_FakeDb):
    """假 db + 一条 `tenant_products` 行（产品 packaging 定义）。"""

    def __init__(self, packaging: list[dict] | None = None) -> None:
        super().__init__()
        self.packaging = packaging if packaging is not None else []
        self.product_rows: list[dict] | None = None

    def enable_product(self, packaging: list[dict]) -> None:
        self.product_rows = [{
            "spec": {
                "key": "field_fence",
                "name": "牛栏网",
                "packaging": list(packaging),
            },
            "override": None,
            "team_id": 1,
        }]

    async def fetch(self, request, sql, *args, table=None):
        if "FROM tenant_products" in sql:
            return [dict(row) for row in (self.product_rows or [])]
        return await super().fetch(request, sql, *args, table=table)


@contextmanager
def _patched_packing(fake: _PackingFakeDb, user: dict = TEAM_USER):
    """同 `_patched`，并同步替换**当前** `quote_api` 模块的 db 绑定。

    为什么不能 `import quote_api` 后直接改：`_bootstrap.load_main()` 会重载路由模块，
    全量跑时 sys.modules 里的 `quote_api` 可能已经不是本文件导入时那个对象
    （单跑能过、全量跑产品解析却静默失败，就是踩了这个）。按名字取**当前**模块再替换。
    """
    quote_mod = sys.modules.get("quote_api")
    old_quote_db = getattr(quote_mod, "_db", None) if quote_mod is not None else None
    if quote_mod is not None:
        quote_mod._db = fake
    try:
        with _patched(fake, user=user):
            yield fake
    finally:
        if quote_mod is not None:
            quote_mod._db = old_quote_db


def _payload(snapshot_extra: dict | None = None,
             packaging_note: dict | None = None) -> dict:
    spec_snapshot: dict = {"product_key": "field_fence"}
    spec_snapshot.update(snapshot_extra or {})
    return {
        "sources": {
            "quote": {
                "quote_no": "Q-202610-001",
                "items": [{
                    "product_name": "牛栏网",
                    "qty": 10,
                    "unit_price": 30,
                    "line_amount": 300,
                    "spec_snapshot": spec_snapshot,
                }],
            },
        },
        "custom": dict(packaging_note or {}),
    }


def _facts(resp_json: dict) -> dict[str, dict]:
    return {item["key"]: item for item in resp_json["items"]}


def test_facts_use_row_packaging_id_to_product_method():
    fake = _PackingFakeDb()
    fake.enable_product(WOOD_PACKAGING)
    fake.add_doc(11, raw_payload=_payload({"packaging_id": "pk_carton"}))

    with _patched_packing(fake):
        resp = client.get("/api/v1/trade-docs/11/facts")
    assert resp.status_code == 200, resp.text
    facts = _facts(resp.json())

    assert facts["packing_method"]["value"] == "纸箱"       # 产品 packing.method 原文
    assert facts["packing_type"]["value"] == "carton"
    assert facts["packing_method"]["source"] == "manual"    # 本单行命中 ≠ 推断
    assert facts["packing_method"]["trust"] == "confirmed"  # 配置派生值不该拦签发
    assert "spec_snapshot.packaging_id=pk_carton" in facts["packing_method"]["evidence_ref"]


def test_facts_fall_back_to_product_default_and_annotate_inferred():
    fake = _PackingFakeDb()
    fake.enable_product(WOOD_PACKAGING)
    fake.add_doc(11, raw_payload=_payload())                 # 快照里没有 packaging_id

    with _patched_packing(fake):
        resp = client.get("/api/v1/trade-docs/11/facts")
    facts = _facts(resp.json())

    assert facts["packing_method"]["value"] == "木托盘"      # is_default 优先
    assert facts["packing_type"]["value"] == "wood"
    assert facts["packing_method"]["source"] == "inferred"
    evidence = facts["packing_method"]["evidence_ref"]
    assert evidence.startswith("inferred:product_default")
    assert "pk_wood" in evidence


def test_facts_product_without_packaging_config_is_none():
    fake = _PackingFakeDb()
    fake.enable_product([])                                   # 产品无 packaging 配置
    fake.add_doc(11, raw_payload=_payload())

    with _patched_packing(fake):
        resp = client.get("/api/v1/trade-docs/11/facts")
    facts = _facts(resp.json())
    assert facts["packing_method"]["value"] == "none"
    assert facts["packing_type"]["value"] == "none"
    assert facts["packing_method"]["evidence_ref"] == "inferred:none"


def test_facts_snapshot_name_used_when_product_unresolvable():
    fake = _PackingFakeDb()                                   # 无 tenant_products 行
    fake.add_doc(11, raw_payload=_payload(
        {"packaging_id": "pk_unknown", "packaging_name": "编织袋"},
    ))
    # 产品解析不到（注册表里没有 pk 对应配置）⇒ 退回快照里的包装名
    with _patched_packing(fake):
        resp = client.get("/api/v1/trade-docs/11/facts")
    facts = _facts(resp.json())
    assert facts["packing_method"]["value"] == "编织袋"
    assert facts["packing_type"]["value"] == "bag"
    assert facts["packing_method"]["evidence_ref"] == "inferred:snapshot"


def test_doc_set_applicable_uses_packing_type_facts_end_to_end():
    fake = _PackingFakeDb()
    fake.enable_product(WOOD_PACKAGING)
    fake.add_doc(11, raw_payload=_payload({"packaging_id": "pk_wood"}))
    # 木包装单：非木包装声明不适用；木质包装相关的熏蒸项适用
    fake.add_doc_set_item(11, "non_wood_packing", role="required",
                          trigger_expr='packing_type != "wood"')
    fake.add_doc_set_item(11, "fumigation_cert", role="required",
                          trigger_expr='packing_type == "wood"')

    with _patched_packing(fake):
        resp = client.get("/api/v1/trade-docs/11/doc-set")
    assert resp.status_code == 200, resp.text
    items = {item["doc_type"]: item for item in resp.json()["items"]}

    non_wood = items["non_wood_packing"]
    assert non_wood["applicable"] is False
    assert non_wood["skipped_by_trigger"] is True
    assert "触发条件不满足" in non_wood["trigger_reason"]

    fumigation = items["fumigation_cert"]
    assert fumigation["applicable"] is True
    assert fumigation["skipped_by_trigger"] is False
