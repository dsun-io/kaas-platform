"""business_events 写入口径回归（2026-10-21）。

生产 500 事故：`_record_business_event` 在单据事务提交**之后**执行；
`business_events.actor_id` 是 text，而 payload["actor_id"] 来自 JWT 是 int
⇒ asyncpg 抛 `expected str, got int` ⇒ 接口 500（但单据已落库）。
该测试钉住「actor_id 必须转 str、None 保持 None」。
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()


class _FakeDb:
    def __init__(self):
        self.calls = []

    async def execute(self, request, sql, *args):
        self.calls.append((sql, args))


def test_record_business_event_stringifies_actor_id():
    fake = _FakeDb()
    old = worker_main.db
    worker_main.db = fake
    try:
        asyncio.run(
            worker_main._record_business_event(
                None,
                "shipment.documented",
                {"doc_id": 1, "doc_no": "PI-1", "actor_id": 15},
                from_ws="trade_docs",
                to_ws="trade_docs",
            )
        )
    finally:
        worker_main.db = old

    assert len(fake.calls) == 1
    sql, args = fake.calls[0]
    assert "INSERT INTO business_events" in sql
    assert args[0] == "default"
    assert args[1] == "shipment.documented"
    assert args[-1] == "15"
    assert isinstance(args[-1], str)


def test_record_business_event_keeps_none_actor():
    fake = _FakeDb()
    old = worker_main.db
    worker_main.db = fake
    try:
        asyncio.run(
            worker_main._record_business_event(None, "market.selected", {"doc_id": 1})
        )
    finally:
        worker_main.db = old

    _sql, args = fake.calls[0]
    assert args[-1] is None
