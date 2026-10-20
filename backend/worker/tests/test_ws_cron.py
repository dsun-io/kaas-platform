"""Cloudflare Cron 三个任务的行为锁（纯假连接，无数据库、无网络）。

为什么需要这个文件
------------------
README §8 已知问题 #5：orchestrator 里两个 APScheduler 任务**生产从未执行**。
它们被迁移到 Worker 的 CF Cron（`src/ws_cron.py` + `main.Default.scheduled`），
而这条链路没有 request、没有 HTTP 入口 —— 生产上唯一能看到的只有日志和
`/cdn-cgi/local/scheduled`。所以 SQL 语义与容错必须由单测锁死：

1. **replied→询盘扫描**（真源 `app/jobs/lead_scan.py`）：
   筛选条件 / 幂等 / 客户复用与团队归属 / 询盘 INSERT 字段 / 线索状态回写；
2. **events 每日归档**（真源 `app/jobs/archive.py`）：
   UTC 时间窗 / 按 schema_version 分桶 / JSONL+GZIP / R2 键 / events_archive_log 行；
3. **单证指纹定时对账**（TODO A8/A9）：
   近 30 天 issued 单据 / 每张独立 try（一张炸不拖垮整轮）/ 结论 upsert 覆盖写；
4. **接线与健壮性**：空数据与异常都不抛穿；scheduled 只按 `controller.cron` 分派；
   `wrangler.jsonc` 的 crons 与 `ws_cron` 常量逐字符一致（防「改了配置忘了改代码」）。

假连接的约定见 `_Conn`：结果按调用顺序预置，每条查询都记进 `queries` 供断言。
"""
from __future__ import annotations

import asyncio
import gzip
import json
import re
import sys
import types
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import ws_cron  # noqa: E402

_UTC = timezone.utc


def _run(coro):
    return asyncio.run(coro)


# ── 假连接 / 假 env / 假 R2 ──────────────────────────────────────────────────

class _Tx:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        self._conn.tx_started += 1
        return self._conn

    async def __aexit__(self, *exc):
        return False


class _Conn:
    """按调用顺序吐出预置结果；所有 SQL 连参数一起记下来。"""

    def __init__(self, *results):
        self._results = list(results)
        self.queries: list[tuple[str, tuple]] = []
        self.tx_started = 0
        self.closed = False
        self.connect_kwargs: dict = {}

    def _next(self, sql, args):
        self.queries.append((sql, args))
        assert self._results, f"执行了多于预期的查询（桩结果已用尽）：{sql}"
        return self._results.pop(0)

    def transaction(self):
        return _Tx(self)

    async def fetch(self, sql, *args):
        return self._next(sql, args)

    async def fetchrow(self, sql, *args):
        return self._next(sql, args)

    async def fetchval(self, sql, *args):
        return self._next(sql, args)

    async def execute(self, sql, *args):
        self.queries.append((sql, args))
        return "INSERT 0 1"

    async def close(self):
        self.closed = True


class _Hd:
    """Hyperdrive binding 替身（port 故意给字符串：真实 binding 是字符串）。"""

    host = "db.example.invalid"
    port = "5432"
    user = "hyperdrive_user"
    password = "hyperdrive_password"
    database = "kaas"


class _Env:
    """`env` 替身：按**属性**读 binding（与 Pyodide 里一致）。"""

    def __init__(self, **bindings):
        self.__dict__.update(bindings)


class _Bucket:
    """R2 `FILES` binding 替身：记下每次 put 的 (key, body, opts)。"""

    def __init__(self):
        self.puts: list[tuple[str, object, object]] = []

    async def put(self, key, body, opts):
        self.puts.append((key, body, opts))


def _patch_connect(monkeypatch, *conns):
    """把 `asyncpg.connect` 换成返回预置连接（异常则照抛）；返回调用 kwargs 列表。"""
    calls: list[dict] = []
    pending = list(conns)

    async def _connect(**kwargs):
        calls.append(kwargs)
        assert pending, "连接次数多于预期"
        item = pending.pop(0)
        if isinstance(item, Exception):
            raise item
        item.connect_kwargs = kwargs
        return item

    monkeypatch.setattr(ws_cron.asyncpg, "connect", _connect)
    return calls


def _lead(**over):
    lead = {
        "id": 11,
        "company_name": "ACME GmbH",
        "country": "US",
        "address": "1 Main St",
        "owner_id": None,
    }
    lead.update(over)
    return lead


def _customer(**over):
    customer = {"id": 5, "name": "ACME GmbH", "country": "US", "abbr": "ACM"}
    customer.update(over)
    return customer


def _event(event_id, schema_version=1, **over):
    row = {
        "id": event_id,
        "schema_version": schema_version,
        "tenant_id": "default",
        "event_type": "page_view",
        "event_source": "frontend",
        "actor_id": "1",
        "session_id": "s-1",
        "payload": {"path": "/export-quote"},
        "trace_id": None,
        "sampled": False,
        "created_at": datetime(2026, 10, 18, 12, event_id, tzinfo=_UTC),
    }
    row.update(over)
    return row


# ── 任务 1：replied → 询盘扫描 ──────────────────────────────────────────────

def test_scan_no_leads_returns_zero_and_uses_default_tenant():
    conn = _Conn([])

    result = _run(ws_cron.scan_replied_leads(conn))

    assert result == {"scanned": 0, "created": 0, "already_linked": 0}
    assert ws_cron.DEFAULT_TENANT == "default"
    sql, args = conn.queries[0]
    assert "FROM lead_candidates" in sql
    assert "outreach_status='replied'" in sql
    assert "inquiry_status='none'" in sql
    assert "ORDER BY id LIMIT 100" in sql   # 与 worker 手动入口同序（确定性）
    assert args == ("default",)             # tenant 口径：恒为 default
    assert len(conn.queries) == 1           # 空数据：不再打库


def test_scan_creates_inquiry_for_new_lead_reusing_customer():
    conn = _Conn([_lead()], None, _customer(), None)

    result = _run(ws_cron.scan_replied_leads(conn))

    assert result == {"scanned": 1, "created": 1, "already_linked": 0}

    # 0) 线索筛选
    sql0, args0 = conn.queries[0]
    assert "outreach_status='replied'" in sql0 and args0 == ("default",)

    # 1) 幂等检查：该 lead 是否已有询盘
    sql1, args1 = conn.queries[1]
    assert "FROM cust_inquiries WHERE tenant_id=$1 AND lead_id=$2" in sql1
    assert args1 == ("default", 11)

    # 2) 客户复用：租户 + 同名 + 同团队（owner 无团队 → NULL，IS NOT DISTINCT FROM）
    sql2, args2 = conn.queries[2]
    assert "FROM customers" in sql2 and "team_id IS NOT DISTINCT FROM $3" in sql2
    assert args2 == ("default", "ACME GmbH", None)

    # 3) 编号查重（复用 main._next_inquiry_no：INQ-国家-客户-时间戳）
    sql3, args3 = conn.queries[3]
    assert "SELECT 1 FROM cust_inquiries" in sql3
    assert args3[0] == "default" and args3[1].startswith("INQ-US-ACM-")

    # 4) 询盘 INSERT：channel/status/可见性都在 SQL 里写死
    sql4, args4 = conn.queries[4]
    assert "INSERT INTO cust_inquiries" in sql4
    assert "'email'" in sql4 and "'unquoted'" in sql4 and "'private'" in sql4
    assert args4 == (
        "default", 5, args3[1], 11,
        "来自线索池触达回复（lead#11）", None, None,
    )

    # 5) 线索状态回写
    sql5, args5 = conn.queries[5]
    assert "UPDATE lead_candidates SET inquiry_status='new'" in sql5
    assert args5 == ("default", 11)

    # 复用已有客户 → 不插 customers
    assert not any("INSERT INTO customers" in q for q, _ in conn.queries)


def test_scan_new_customer_uses_lead_owner_team():
    lead = _lead(id=12, company_name="Beta Sarl", country="FR",
                 address="1 Rue", owner_id="42")
    created_customer = {"id": 9, "name": "Beta Sarl", "country": "FR", "abbr": None}
    conn = _Conn([lead], None, 7, None, created_customer, None)

    result = _run(ws_cron.scan_replied_leads(conn))

    assert result == {"scanned": 1, "created": 1, "already_linked": 0}

    # 团队归属取自**线索 owner**（orchestrator 口径），不是「谁触发了任务」
    sql_users, args_users = conn.queries[2]
    assert "SELECT team_id FROM users WHERE id=$1" in sql_users
    assert args_users == (42,)

    sql_lookup, args_lookup = conn.queries[3]
    assert "team_id IS NOT DISTINCT FROM $3" in sql_lookup
    assert args_lookup == ("default", "Beta Sarl", 7)

    sql_insert_customer, args_customer = conn.queries[4]
    assert "INSERT INTO customers" in sql_insert_customer
    assert "'active'" in sql_insert_customer and "'private'" in sql_insert_customer
    assert args_customer == ("default", "Beta Sarl", "FR", "1 Rue", "42", 7)

    # 询盘同时带上 owner 与团队（team 隔离；见 ws_cron 模块头「有意偏差 1」）
    assert conn.queries[5][1][0] == "default"
    assert conn.queries[5][1][1].startswith("INQ-FR-")
    sql_insert_inq, args_inq = conn.queries[6]
    assert "INSERT INTO cust_inquiries" in sql_insert_inq
    assert args_inq[3] == 12 and args_inq[5] == "42" and args_inq[6] == 7


@pytest.mark.parametrize(
    ("inq_status", "mapped"),
    [
        ("unquoted", "new"),
        ("quoted", "following"),
        ("closed", "lost"),
        ("legacy_status", "new"),  # 未知状态按 orchestrator 的 .get(..., "new") 兜底
    ],
)
def test_scan_syncs_existing_inquiry_status(inq_status, mapped):
    conn = _Conn([_lead(id=13)], {"status": inq_status})

    result = _run(ws_cron.scan_replied_leads(conn))

    assert result == {"scanned": 1, "created": 0, "already_linked": 1}
    assert len(conn.queries) == 3            # 只查 + 回写，不建客户/询盘
    sql, args = conn.queries[2]
    assert "UPDATE lead_candidates SET inquiry_status=$1" in sql
    assert "inquiry_status IS DISTINCT FROM $1" in sql   # 值没变就不写（同 ws_crm_ext）
    assert args == (mapped, "default", 13)


def test_scan_dirty_owner_id_degrades_to_no_team():
    """owner_id 非数字（历史脏数据）不能让整轮扫描抛异常。"""
    conn = _Conn([_lead(id=14, owner_id="system")], None, _customer(), None)

    result = _run(ws_cron.scan_replied_leads(conn))

    assert result == {"scanned": 1, "created": 1, "already_linked": 0}
    assert not any("FROM users" in q for q, _ in conn.queries)
    assert conn.queries[2][1] == ("default", "ACME GmbH", None)


def test_run_lead_scan_ok_closes_connection_and_binds_hyperdrive(monkeypatch):
    conn = _Conn([_lead()], None, _customer(), None)
    calls = _patch_connect(monkeypatch, conn)

    result = _run(ws_cron.run_lead_scan(_Env(HYPERDRIVE=_Hd())))

    assert result == {"scanned": 1, "created": 1, "already_linked": 0}
    assert conn.tx_started == 1          # 一轮扫描一个事务
    assert conn.closed is True
    # 连接参数必须与 main._acquire 逐项一致（scheduled 没有 request，只能按 env 直连）
    assert calls == [{
        "host": _Hd.host, "port": 5432, "user": _Hd.user,
        "password": _Hd.password, "database": _Hd.database, "ssl": False,
    }]


def test_run_lead_scan_swallows_error(monkeypatch):
    _patch_connect(monkeypatch, RuntimeError("db down"))

    result = _run(ws_cron.run_lead_scan(_Env(HYPERDRIVE=_Hd())))

    assert result["scanned"] == 0 and result["created"] == 0
    assert "db down" in result["error"]   # 异常不抛穿；如实进 error 字段


# ── 任务 2：events 每日归档 ─────────────────────────────────────────────────

@pytest.mark.parametrize(
    ("now", "expected"),
    [
        (datetime(2026, 10, 19, 16, 30, tzinfo=_UTC), "2026-10-18"),  # 目标日 = UTC 昨日
        (datetime(2026, 10, 19, 0, 0, 0, tzinfo=_UTC), "2026-10-18"),
        (datetime(2026, 1, 1, 3, 0, 0, tzinfo=_UTC), "2025-12-31"),  # 跨年
    ],
)
def test_archive_target_date_is_utc_yesterday(now, expected):
    assert ws_cron.archive_target_date(now) == expected


def test_archive_window_is_half_open_utc():
    start, end = ws_cron.archive_window("2026-10-18")
    assert start == datetime(2026, 10, 18, 0, 0, tzinfo=_UTC)
    assert end == datetime(2026, 10, 19, 0, 0, tzinfo=_UTC)
    assert start.utcoffset() is not None and start.utcoffset().total_seconds() == 0


def test_archive_no_events_returns_message_without_touching_bucket():
    conn = _Conn([])

    # 无数据时不需要 R2（与 orchestrator「先查后建 Minio client」同序）
    result = _run(ws_cron.archive_events_for_day(conn, None, "2026-10-18"))

    assert result == {"archived": 0, "message": "No events on 2026-10-18"}
    assert len(conn.queries) == 1
    sql, args = conn.queries[0]
    assert "FROM events" in sql
    assert "ORDER BY created_at ASC" in sql
    assert args == (
        datetime(2026, 10, 18, 0, 0, tzinfo=_UTC),
        datetime(2026, 10, 19, 0, 0, tzinfo=_UTC),
    )


def test_archive_buckets_by_schema_version_and_writes_gzip_to_r2():
    rows = [
        _event(1, schema_version=1),
        _event(2, schema_version=1, payload={"path": "/orders"}),
        _event(3, schema_version=2, event_type="quote_created"),
    ]
    conn = _Conn(rows)
    bucket = _Bucket()

    result = _run(ws_cron.archive_events_for_day(conn, bucket, "2026-10-18"))

    assert result == {"archived": 3, "date": "2026-10-18", "version_count": 2}

    # 按 schema_version 分桶 → 每桶一个对象，键布局与 orchestrator OSS 一致
    assert [key for key, _body, _opts in bucket.puts] == [
        "events-archive/2026/10/18/v1.jsonl.gz",
        "events-archive/2026/10/18/v2.jsonl.gz",
    ]
    bodies = [gzip.decompress(body).decode("utf-8") for _key, body, _opts in bucket.puts]
    lines_v1 = bodies[0].splitlines()
    assert len(lines_v1) == 2
    first = json.loads(lines_v1[0])
    assert first["id"] == 1
    assert first["payload"] == {"path": "/export-quote"}   # payload 是对象，不是字符串
    assert first["created_at"] == "2026-10-18T12:01:00+00:00"   # isoformat
    assert first["schema_version"] == 1 and first["tenant_id"] == "default"
    assert json.loads(bodies[1].splitlines()[0])["event_type"] == "quote_created"
    # 压缩/内容类型如实标注
    for _key, body, opts in bucket.puts:
        assert body[:2] == b"\x1f\x8b"                       # gzip magic
        assert opts == {"httpMetadata": {"contentType": "application/gzip"}}

    # 每桶一条归档日志（tenant='*'，month=YYYY-MM，路径带 bucket 前缀）
    log_rows = [q for q in conn.queries if "INSERT INTO events_archive_log" in q[0]]
    assert len(log_rows) == 2
    assert log_rows[0][1] == (
        "*", "2026-10", "kaas-files/events-archive/2026/10/18/v1.jsonl.gz", "archived",
    )
    assert log_rows[1][1][2].endswith("/v2.jsonl.gz")


def test_archive_payload_json_string_is_normalized():
    """Workers 的 asyncpg 会把 jsonb 返回成 str：JSONL 里必须还原成对象。"""
    conn = _Conn([_event(1, payload='{"path": "/orders", "n": 2}')])
    bucket = _Bucket()

    _run(ws_cron.archive_events_for_day(conn, bucket, "2026-10-18"))

    body = gzip.decompress(bucket.puts[0][1]).decode("utf-8")
    assert json.loads(body.splitlines()[0])["payload"] == {"path": "/orders", "n": 2}


def test_archive_without_gzip_falls_back_to_plain_jsonl(monkeypatch):
    monkeypatch.setattr(ws_cron, "gzip", None)
    conn = _Conn([_event(1)])
    bucket = _Bucket()

    result = _run(ws_cron.archive_events_for_day(conn, bucket, "2026-10-18"))

    assert result["archived"] == 1
    key, body, opts = bucket.puts[0]
    assert key == "events-archive/2026/10/18/v1.jsonl"
    assert isinstance(body, bytes)          # 降级时如实是纯 JSONL 字节
    assert json.loads(body.decode("utf-8").splitlines()[0])["id"] == 1
    assert opts == {"httpMetadata": {"contentType": "application/x-ndjson"}}


def test_archive_requires_r2_binding():
    conn = _Conn([_event(1)])

    with pytest.raises(RuntimeError, match="FILES"):
        _run(ws_cron.archive_events_for_day(conn, None, "2026-10-18"))


def test_run_archive_events_empty_day_returns_message(monkeypatch):
    conn = _Conn([])
    _patch_connect(monkeypatch, conn)

    result = _run(ws_cron.run_archive_events(
        _Env(HYPERDRIVE=_Hd(), FILES=_Bucket()),
        now=datetime(2026, 10, 19, 16, 30, tzinfo=_UTC),
    ))

    assert result == {"archived": 0, "message": "No events on 2026-10-18"}
    assert conn.tx_started == 1 and conn.closed is True


def test_run_archive_events_writes_and_closes(monkeypatch):
    conn = _Conn([_event(1), _event(2, schema_version=2)])
    _patch_connect(monkeypatch, conn)
    env = _Env(HYPERDRIVE=_Hd(), FILES=_Bucket(), S3_BUCKET="kaas-files")

    result = _run(ws_cron.run_archive_events(
        env, now=datetime(2026, 10, 19, 16, 30, tzinfo=_UTC)))

    assert result == {"archived": 2, "date": "2026-10-18", "version_count": 2}
    assert len(env.FILES.puts) == 2
    assert conn.tx_started == 1 and conn.closed is True


def test_run_archive_events_retries_three_times_then_returns_error(monkeypatch):
    calls = _patch_connect(monkeypatch, *[RuntimeError("boom") for _ in range(3)])

    result = _run(ws_cron.run_archive_events(
        _Env(HYPERDRIVE=_Hd(), FILES=_Bucket()),
        now=datetime(2026, 10, 19, 16, 30, tzinfo=_UTC),
    ))

    assert len(calls) == ws_cron.MAX_ARCHIVE_RETRIES == 3
    assert result["archived"] == 0 and result["date"] == "2026-10-18"
    assert "boom" in result["error"]        # 异常不抛穿


# ── scheduled 分派 + 钩子 + wrangler 配置 ───────────────────────────────────

@pytest.mark.parametrize(
    ("cron", "job", "runner"),
    [
        (ws_cron.CRON_SCAN_REPLIED, "scan_replied_leads", "scan"),
        (ws_cron.CRON_ARCHIVE_EVENTS, "archive_events", "archive"),
        (ws_cron.CRON_RENDER_CHECK, "check_render_fingerprints", "render"),
    ],
)
def test_run_scheduled_dispatches_by_exact_cron(monkeypatch, cron, job, runner):
    recorded: list[tuple[str, object]] = []

    async def fake_scan(env):
        recorded.append(("scan", env))
        return {"scanned": 0, "created": 0, "already_linked": 0}

    async def fake_archive(env):
        recorded.append(("archive", env))
        return {"archived": 0, "message": "No events on 2026-10-18"}

    async def fake_render(env):
        recorded.append(("render", env))
        return {"total": 0, "matched": 0}

    monkeypatch.setattr(ws_cron, "run_lead_scan", fake_scan)
    monkeypatch.setattr(ws_cron, "run_archive_events", fake_archive)
    monkeypatch.setattr(ws_cron, "run_check_render_fingerprints", fake_render)
    env = _Env(HYPERDRIVE=_Hd())

    result = _run(ws_cron.run_scheduled(env, SimpleNamespace(cron=cron)))

    assert [name for name, _env in recorded] == [runner]
    assert result["job"] == job and result["cron"] == cron
    zero_key = {
        "scan_replied_leads": "scanned",
        "archive_events": "archived",
        "check_render_fingerprints": "total",
    }[job]
    assert result["result"][zero_key] == 0
    assert recorded[0][1] is env


@pytest.mark.parametrize("controller", [
    SimpleNamespace(cron="0 0 * * *"),      # 未登记：不猜该跑哪个任务
    SimpleNamespace(cron=None),
    object(),                               # 连 cron 属性都没有
])
def test_run_scheduled_unknown_cron_is_skipped(controller):
    result = _run(ws_cron.run_scheduled(_Env(HYPERDRIVE=_Hd()), controller))

    assert result["job"] is None and result["skipped"] is True


def test_default_scheduled_hook_delegates_to_ws_cron(monkeypatch):
    """main.Default.scheduled 只是钩子：必须把 (env, controller) 原样交给 ws_cron。"""
    recorded: list[tuple[object, object]] = []

    async def fake_run_scheduled(env, controller):
        recorded.append((env, controller))
        return {"ok": True}

    monkeypatch.setattr(ws_cron, "run_scheduled", fake_run_scheduled)
    env = _Env(HYPERDRIVE=_Hd())
    controller = SimpleNamespace(cron=ws_cron.CRON_SCAN_REPLIED)

    instance = worker_main.Default()   # _bootstrap 的 WorkerEntrypoint 是空壳，可直接实例化
    result = _run(instance.scheduled(controller, env, types.SimpleNamespace()))

    assert result == {"ok": True}
    assert recorded == [(env, controller)]


def test_wrangler_crons_match_ws_cron_constants():
    """配置 ↔ 代码双向锁：scheduled 靠 controller.cron 的**精确字符串**分派。"""
    text = (Path(__file__).resolve().parents[1] / "wrangler.jsonc").read_text(encoding="utf-8")
    # 只处理「整行注释 + 尾逗号」这两种 JSONC 语法（本文件即如此书写）
    stripped = "\n".join(
        line for line in text.splitlines() if not line.lstrip().startswith("//")
    )
    stripped = re.sub(r",(\s*[}\]])", r"\1", stripped)
    data = json.loads(stripped)

    crons = data["triggers"]["crons"]
    assert crons == [
        ws_cron.CRON_SCAN_REPLIED,
        ws_cron.CRON_ARCHIVE_EVENTS,
        ws_cron.CRON_RENDER_CHECK,
    ]
    assert set(ws_cron.JOBS_BY_CRON) == set(crons)


def test_cron_expressions_are_five_field_utc_schedules():
    for cron in (
        ws_cron.CRON_SCAN_REPLIED,
        ws_cron.CRON_ARCHIVE_EVENTS,
        ws_cron.CRON_RENDER_CHECK,
    ):
        assert len(cron.split()) == 5
    # 归档：Asia/Shanghai 00:30 == UTC 16:30 前一日（UTC+8）
    assert ws_cron.CRON_ARCHIVE_EVENTS == "30 16 * * *"
    # 对账：Asia/Shanghai 次日 01:40 == UTC 前一日 17:40（UTC+8），避开归档窗口
    assert ws_cron.CRON_RENDER_CHECK == "40 17 * * *"


# ── 任务 3：单证指纹定时对账（TODO A8/A9）───────────────────────────────────

def _issued_doc_row(**over):
    row = {
        "id": 7, "doc_no": "PI-202610-0007", "status": "issued", "raw_payload": {},
    }
    row.update(over)
    return row


def _fingerprint_row(data):
    """构造一张「签发时冻结了指纹」的单据行（冻结输入 = data）。"""
    from kaas_common.trade_doc import render_fingerprint

    return _issued_doc_row(raw_payload={
        "_render": render_fingerprint(data, frozen_at="2026-10-20T00:00:00+00:00"),
    })


def _patch_render_data(monkeypatch, data=None, exc=None):
    """替换装配函数：cron 对账要把每张单据的渲染输入重新装配一遍。

    `request` 在真实现里只用来取 Hyperdrive 绑定；这里替换后完全不碰网络。
    """
    async def fake_render_data(doc_id, request, user):
        if exc is not None:
            raise exc
        return {"data": data}

    monkeypatch.setattr(ws_cron._main, "get_trade_doc_render_data", fake_render_data)


def _render_check_inserts(conn):
    return [
        (sql, args) for sql, args in conn.queries
        if "INSERT INTO trade_doc_render_checks" in sql
    ]


def test_render_check_no_issued_docs_returns_zero():
    conn = _Conn([])
    result = _run(ws_cron.check_render_fingerprints(conn, SimpleNamespace(scope={})))

    assert result["total"] == 0 and result["checked"] == 0
    # 只扫 issued + 近 30 天 + 上限 50；空结果不写对账表
    sql, args = conn.queries[0]
    assert "status='issued'" in sql and "LIMIT $3" in sql
    assert args[0] == ws_cron.DEFAULT_TENANT
    assert args[2] == ws_cron.RENDER_CHECK_LIMIT
    assert _render_check_inserts(conn) == []


def test_render_check_matched_persists_upsert(monkeypatch):
    data = {"currency": "USD", "total_amount": 1200, "items": [], "remarks": "x"}
    conn = _Conn([_fingerprint_row(data)])
    _patch_render_data(monkeypatch, data)

    result = _run(ws_cron.check_render_fingerprints(conn, SimpleNamespace(scope={})))

    assert result["matched"] == 1 and result["checked"] == 1
    inserts = _render_check_inserts(conn)
    assert len(inserts) == 1
    sql, args = inserts[0]
    # 覆盖写：每张单据只留最近一次结论（不是事件流）
    assert "ON CONFLICT (tenant_id, trade_doc_id) DO UPDATE" in sql
    assert args[0] == ws_cron.DEFAULT_TENANT and args[1] == 7
    assert args[3] is True and args[4] == "matched"


def test_render_check_after_data_change_reports_changed(monkeypatch):
    frozen = {"currency": "USD", "total_amount": 1200}
    conn = _Conn([_fingerprint_row(frozen)])
    _patch_render_data(monkeypatch, {**frozen, "total_amount": 999})

    result = _run(ws_cron.check_render_fingerprints(conn, SimpleNamespace(scope={})))

    assert result["data_changed"] == 1
    _sql, args = _render_check_inserts(conn)[0]
    assert args[3] is False and args[4] == "data_changed"


def test_render_check_assembly_error_marks_unavailable(monkeypatch):
    """一张装配失败只能标 unavailable —— 绝不假装匹配，也不能拖垮整轮。"""
    conn = _Conn([_fingerprint_row({"currency": "USD"})])
    _patch_render_data(monkeypatch, exc=RuntimeError("no company profile"))

    result = _run(ws_cron.check_render_fingerprints(conn, SimpleNamespace(scope={})))

    assert result["unavailable"] == 1
    assert result["matched"] == 0
    _sql, args = _render_check_inserts(conn)[0]
    # reason 存内核原值（current_unavailable），汇总时才折进 unavailable 桶
    assert args[3] is False and args[4] == "current_unavailable"


def test_run_render_check_uses_hyperdrive_and_closes(monkeypatch):
    data = {"currency": "USD"}
    conn = _Conn([_fingerprint_row(data)])
    calls = _patch_connect(monkeypatch, conn)
    _patch_render_data(monkeypatch, data)

    result = _run(ws_cron.run_check_render_fingerprints(_Env(HYPERDRIVE=_Hd())))

    assert result["checked"] == 1
    assert conn.closed is True
    # 连接参数与 main._acquire 同口径（真实 binding 的 port 是字符串 → 转 int）
    assert calls[0]["host"] == "db.example.invalid"
    assert calls[0]["port"] == 5432 and calls[0]["ssl"] is False


def test_run_render_check_swallows_error(monkeypatch):
    _patch_connect(monkeypatch, RuntimeError("boom"))

    result = _run(ws_cron.run_check_render_fingerprints(_Env(HYPERDRIVE=_Hd())))

    assert result["checked"] == 0
    assert "boom" in result["error"]     # 异常不抛穿（Cron 不能让调度器变错误态）
