"""C8 四源计数：leads 的 demand_index / blank_index 真实回填。

口径（实现见 chain.py 的「C8 · 四源计数」段，设计见 WORKSTATION_DESIGN §6.8）：
- 已开发量 = 已抓取（lead_candidates）+ 已调研（research_products）
            + 已触达（outreach_messages.status='sent'）
            + 已成交（F4 `cust_inquiries.stage` ∈ order/shipment/completed，
              或该询盘经 quote_orders 关联存在**非 cancelled** 订单）
- 空白指数 = 需求量 − 已开发量（Decimal 计算）
- 需求量缺失 ⇒ demand_index / blank_index **都是 null**（"数据未接入"，不拿 0 冒充）
- 地区维度 = lead_candidates.region（code/name/大小写归一化）；
  country 只做需求量兜底；region 为空的行不参与归属（两个字段 null）

本文件只测纯函数 + 查询形状 + 两个读端点；不连数据库、不联网。
"""
import platform  # noqa: F401  先占住 stdlib platform：src/platform 是命名空间包，会遮蔽它
import asyncio
import sys
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

import chain  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=False)
USER = {"id": 7, "account_type": "internal", "role": "system_admin", "team_id": None}


# ── 假连接：按调用顺序吐预置结果，并记录每条 SQL 与参数 ─────────────────────

class _Conn:
    def __init__(self, *, fetch=None, fetchval=None, fetchrow=None):
        self._fetch = list(fetch or [])
        self._fetchval = list(fetchval or [])
        self._fetchrow = list(fetchrow or [])
        self.calls: list[tuple[str, str, tuple]] = []

    async def fetch(self, sql, *args):
        self.calls.append(("fetch", sql, args))
        assert self._fetch, f"fetch 次数多于预期：{sql}"
        return self._fetch.pop(0)

    async def fetchval(self, sql, *args):
        self.calls.append(("fetchval", sql, args))
        assert self._fetchval, f"fetchval 次数多于预期：{sql}"
        return self._fetchval.pop(0)

    async def fetchrow(self, sql, *args):
        self.calls.append(("fetchrow", sql, args))
        assert self._fetchrow, f"fetchrow 次数多于预期：{sql}"
        return self._fetchrow.pop(0)


class _Ctx:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *exc):
        return False


@contextmanager
def _patched(conn, user=USER):
    """把 chain 的 `_acquire` 换成假连接、把鉴权依赖换成固定用户。"""
    old_acquire = chain._acquire
    chain._acquire = lambda request: _Ctx(conn)
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield
    finally:
        chain._acquire = old_acquire
        worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)


def _run(coro):
    return asyncio.run(coro)


def _lead(**over):
    row = {
        "id": 1, "tenant_id": "default", "company_name": "Lone Star Fence Co",
        "country": "US", "region": "Texas", "city": "Houston",
        "outreach_status": "none", "inquiry_status": "none",
        "created_at": "2026-10-20T00:00:00+00:00",
    }
    row.update(over)
    return row


# ── 1. 地区归一化 / 别名（这任务最容易错的地方）─────────────────────────────

def test_region_code_and_name_alias_to_same_canonical_key():
    """intel 侧可能写 `US-TX`，线索池写 `Texas`/`Texas, USA` —— 必须是同一桶。"""
    keys = {
        chain._region_key({"region": "US-TX"}),
        chain._region_key({"region": "Texas"}),
        chain._region_key({"region": "Texas, USA"}),
        chain._region_key({"region": "  texas,   usa "}),
    }
    assert keys == {"texas"}, f"同一地区不同写法应归一到同一 key，实际 {keys}"
    assert keys == {chain._region_key({"region": "TEXAS"})}


def test_region_alias_group_is_symmetric_and_unknown_is_identity():
    assert sorted(chain._alias_group(chain._REGION_INDEX, "Texas")) == [
        "texas", "texas, usa", "us-tx"]
    # 别名表没覆盖的地区不能硬凑：原样（归一化后）作为自己的组
    assert chain._alias_group(chain._REGION_INDEX, "Kanto") == frozenset({"kanto"})
    assert chain._region_key({"region": "Kanto"}) == "kanto"


def test_region_missing_is_empty_not_guessed():
    assert chain._region_key({"region": None}) == ""
    assert chain._region_key({"region": "   "}) == ""
    assert chain._region_key({}) == ""


def test_country_alias_covers_iso_and_english_name():
    """lead 写 `USA`、intel 写 `United States` 时要能兜上。"""
    assert chain._canonical(chain._COUNTRY_INDEX, "USA") == chain._canonical(
        chain._COUNTRY_INDEX, "United States")
    assert chain._canonical(chain._COUNTRY_INDEX, "united states of america") == (
        chain._canonical(chain._COUNTRY_INDEX, "US"))
    assert chain._canonical(chain._COUNTRY_INDEX, "Kazakhstan") == "kazakhstan"


# ── 2. 空白指数公式（Decimal、缺失语义、允许负数）──────────────────────────

def test_blank_index_formula():
    assert chain._lead_index_values(Decimal("100.0000"), 30) == {
        "demand": 100.0, "blank": 70.0}
    # 需求量 0 也照公式算（减法无零除问题）；开发量>需求 ⇒ 负数（过度覆盖，真实信号）
    assert chain._lead_index_values(Decimal("0"), 4) == {"demand": 0.0, "blank": -4.0}
    assert chain._lead_index_values(Decimal("2"), 5) == {"demand": 2.0, "blank": -3.0}
    # Decimal 计算，避免 0.1% 级数据 float 漂移
    assert chain._lead_index_values(Decimal("0.3"), 0) == {"demand": 0.3, "blank": 0.3}


def test_missing_demand_keeps_both_null_not_zero():
    """intel_demand_index 空表/无该地区 ⇒ 两个字段都 null（不把"没数据"当"需求 0"）。"""
    assert chain._lead_index_values(None, 0) == {"demand": None, "blank": None}
    assert chain._lead_index_values(None, 99) == {"demand": None, "blank": None}


# ── 3. 月份/品类加总规则 ────────────────────────────────────────────────────

def test_latest_month_sum_not_all_months():
    rows = [("2026-09", Decimal("10")), ("2026-10", Decimal("40")),
            ("2026-10", Decimal("60"))]
    assert chain._latest_month_demand(rows) == Decimal("100")


def test_latest_month_handles_empty_and_blank_month():
    assert chain._latest_month_demand([]) is None
    assert chain._latest_month_demand([(None, None)]) is None
    # 只有空月份桶时也正常（外部导入可能不填 month）
    assert chain._latest_month_demand([("", Decimal("7"))]) == Decimal("7")


# ── 4. 批量计算：四源相加 / 编码别名归并 / country 兜底 / 缺失语义 ──────────

def test_bulk_indices_sums_four_sources_and_merges_region_aliases():
    leads = [_lead(id=1, region="Texas"), _lead(id=2, region="US-TX")]
    # 四源：captured 3 + researched 2 + reached 1 + dealt 1 = 7
    # 地区别名分别以 "texas" 与 "us-tx" 出现在 DB 行里，必须归并到同一桶
    developed_rows = [
        {"src": "captured", "k": "texas", "n": 2},
        {"src": "captured", "k": "us-tx", "n": 1},
        {"src": "researched", "k": "texas", "n": 2},
        {"src": "reached", "k": "us-tx", "n": 1},
        {"src": "dealt", "k": "texas", "n": 1},
    ]
    demand_rows = [{"rk": "texas", "ck": "us", "month_key": "2026-10",
                    "demand_index": Decimal("100.0000")}]
    conn = _Conn(fetch=[developed_rows, demand_rows])
    got = _run(chain._lead_indices(conn, leads))
    assert got[1] == {"demand": 100.0, "blank": 93.0}
    assert got[2] == {"demand": 100.0, "blank": 93.0}
    # 固定 2 条 SQL（四源计数 + 需求量），不存在"每条 lead 一次查询"
    assert len(conn.calls) == 2


def test_bulk_indices_demand_country_fallback_when_region_has_no_rows():
    leads = [_lead(id=1, region="Ontario", country="CA")]
    developed_rows = [{"src": "captured", "k": "ontario", "n": 4}]
    demand_rows = [{"rk": "", "ck": "canada", "month_key": "2026-10",
                    "demand_index": Decimal("10")}]
    conn = _Conn(fetch=[developed_rows, demand_rows])
    got = _run(chain._lead_indices(conn, leads))
    # 地区粒度无需求行 → 按国家兜底；开发量仍按地区算
    assert got[1] == {"demand": 10.0, "blank": 6.0}


def test_bulk_indices_missing_demand_stays_null_and_blank_region_is_skipped():
    leads = [
        _lead(id=1, region="Kanto"),          # 有地区但 intel 无数据
        _lead(id=2, region=None, country="JP"),  # 无地区：不猜、不参与归属
    ]
    developed_rows = [{"src": "captured", "k": "kanto", "n": 5}]
    demand_rows = [{"rk": "", "ck": "japan", "month_key": "2026-10",
                    "demand_index": Decimal("8")}]
    conn = _Conn(fetch=[developed_rows, demand_rows])
    got = _run(chain._lead_indices(conn, leads))
    assert got[1] == {"demand": None, "blank": None}
    assert got[2] == {"demand": None, "blank": None}


def test_bulk_indices_all_blank_region_short_circuits_without_sql():
    conn = _Conn()
    got = _run(chain._lead_indices(conn, [_lead(region=None)]))
    assert got[1] == {"demand": None, "blank": None}
    assert conn.calls == []


# ── 5. SQL 形状：参数化 / tenant / 四源与成交口径 ──────────────────────────

def test_sql_is_parameterized_and_tenant_scoped():
    leads = [_lead(id=1, region="x'; DROP TABLE lead_candidates; --")]
    developed_rows, demand_rows = [], []
    conn = _Conn(fetch=[developed_rows, demand_rows])
    _run(chain._lead_indices(conn, leads))

    developed_sql, developed_args = conn.calls[0][1], conn.calls[0][2]
    demand_sql, demand_args = conn.calls[1][1], conn.calls[1][2]
    for sql, args in ((developed_sql, developed_args), (demand_sql, demand_args)):
        assert "tenant_id = $1" in sql
        assert args[0] == chain.DEFAULT_TENANT
        # 用户输入只能出现在参数里，不能拼进 SQL
        assert "DROP TABLE" not in sql
    # 地区键走 ANY($n) 绑定；四条来源同一条 SQL
    assert "= ANY($2::text[])" in developed_sql
    for marker in ("lead_candidates", "research_products", "outreach_messages",
                   "cust_inquiries", "quote_orders", "orders"):
        assert marker in developed_sql, marker
    assert "status = 'sent'" in developed_sql  # 已触达只算 sent
    assert "IS DISTINCT FROM 'cancelled'" in developed_sql
    assert "stage = ANY($3::text[])" in developed_sql
    assert demand_sql.count("intel_demand_index") == 1
    assert "demand_index IS NOT NULL" in demand_sql
    assert "= ANY($2::text[])" in demand_sql and "= ANY($3::text[])" in demand_sql


def test_dealt_stages_are_f4_order_and_beyond_not_closed():
    """已成交口径 = order/shipment/completed；closed/unquoted/quoted 都不算。"""
    from inquiry_stage import (STAGE_CLOSED, STAGE_COMPLETED, STAGE_INQUIRY,
                               STAGE_ORDER, STAGE_QUOTATION, STAGE_SHIPMENT)

    assert set(chain._DEALT_STAGES) == {STAGE_ORDER, STAGE_SHIPMENT, STAGE_COMPLETED}
    for excluded in (STAGE_INQUIRY, STAGE_QUOTATION, STAGE_CLOSED):
        assert excluded not in chain._DEALT_STAGES


# ── 6. `_row_to_lead` 回填 & 写路径保持 null（不额外查库）───────────────────

def test_row_to_lead_fills_indices_and_pops_raw():
    row = {**_lead(), "raw": {"demo": True}}
    filled = chain._row_to_lead(row, {"demand": 12.5, "blank": 3.5})
    assert filled["demand_index"] == 12.5
    assert filled["blank_index"] == 3.5
    assert "raw" not in filled
    plain = chain._row_to_lead(_lead())
    assert plain["demand_index"] is None and plain["blank_index"] is None


# ── 7. 读端点：/leads 与 /leads/{id} 返回数值（有 intel 行时）────────────────

def _sql_of(conn, marker):
    return [(s, a) for kind, s, a in conn.calls if marker in s]


def test_leads_list_endpoint_returns_numeric_indices():
    conn = _Conn(
        fetchval=[1, 1],  # 订阅校验 + COUNT(*)
        fetch=[
            [_lead()],
            [{"src": "captured", "k": "texas", "n": 3},
             {"src": "dealt", "k": "texas", "n": 1}],
            [{"rk": "texas", "ck": "us", "month_key": "2026-10",
              "demand_index": Decimal("50.0000")}],
        ],
    )
    with _patched(conn):
        resp = client.get("/api/v1/leads")
    assert resp.status_code == 200, resp.text
    item = resp.json()["items"][0]
    assert item["demand_index"] == 50.0
    assert item["blank_index"] == 46.0  # 50 − (3 抓取 + 1 成交)
    # 列表只打 2 条计数 SQL（四源 1 条 + 需求 1 条），无 N+1
    assert len(_sql_of(conn, "intel_demand_index")) == 1
    assert len(_sql_of(conn, "WITH captured")) == 1


def test_leads_list_without_intel_rows_keeps_null():
    conn = _Conn(
        fetchval=[1, 1],
        fetch=[[_lead()], [], []],
    )
    with _patched(conn):
        resp = client.get("/api/v1/leads")
    assert resp.status_code == 200
    item = resp.json()["items"][0]
    assert item["demand_index"] is None and item["blank_index"] is None


def test_lead_detail_endpoint_returns_numeric_indices():
    conn = _Conn(
        fetchval=[1],
        fetchrow=[_lead()],
        fetch=[
            [],  # outreach_history
            [],  # inquiry_history
            [{"src": "researched", "k": "texas", "n": 2}],
            [{"rk": "texas", "ck": "us", "month_key": "2026-10",
              "demand_index": Decimal("7.5")}],
        ],
    )
    with _patched(conn):
        resp = client.get("/api/v1/leads/1")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["demand_index"] == 7.5
    assert body["blank_index"] == 5.5
