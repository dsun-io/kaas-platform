"""Kaas v2 · 归档定时任务测试 (§3.7.10)

测试场景:
- archive_old_events 正常执行
- 无昨日事件时返回 0
- 多版本分桶归档到 OSS
- 边界场景: 空表/跨版本/并发
"""
import pytest
pytestmark = pytest.mark.db
import asyncio
from unittest.mock import MagicMock, AsyncMock, patch
from datetime import datetime, timezone, timedelta


def _make_mock_event(
    evt_id: str = "evt-1",
    tenant_id: str = "lianjia",
    schema_version: int = 1,
    event_type: str = "chat.turn",
):
    """创建模拟事件对象（§3.7.1 schema 对齐）。"""
    evt = MagicMock()
    evt.id = evt_id
    evt.schema_version = schema_version
    evt.tenant_id = tenant_id
    evt.event_type = event_type
    evt.event_source = "orchestrator"
    evt.actor_id = None
    evt.session_id = None
    evt.payload = {"test": True}
    evt.trace_id = "a" * 32
    evt.sampled = False
    evt.created_at = datetime.now(timezone.utc) - timedelta(days=1)
    return evt


class TestArchiveJob:
    """归档定时任务测试。"""

    async def test_archive_no_yesterday_events_returns_zero(self):
        """无昨日事件时归档返回 0。"""
        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        mock_session.execute.return_value = mock_result

        with patch("app.jobs.archive.async_session_factory") as mock_factory:
            mock_factory.return_value.__aenter__.return_value = mock_session
            from app.jobs.archive import archive_old_events

            result = await archive_old_events()

        assert result["archived"] == 0

    async def test_archive_writes_to_oss_and_log(self, minio_archive_mock):
        """有昨日事件时归档到 OSS 并写入日志。"""
        mock_event = _make_mock_event("evt-1")
        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [mock_event]
        mock_session.execute.return_value = mock_result

        with patch("app.jobs.archive.async_session_factory") as mock_factory:
            mock_factory.return_value.__aenter__.return_value = mock_session
            from app.jobs.archive import archive_old_events

            result = await archive_old_events()

        assert result["archived"] == 1
        minio_archive_mock.return_value.put_object.assert_called_once()
        mock_session.commit.assert_called()

    async def test_archive_grouped_by_schema_version(self, minio_archive_mock):
        """按 schema_version 分桶，不同版本分别压缩上传。"""
        events = [
            _make_mock_event("evt-1", schema_version=1),
            _make_mock_event("evt-2", schema_version=2),
        ]

        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = events
        mock_session.execute.return_value = mock_result

        with patch("app.jobs.archive.async_session_factory") as mock_factory:
            mock_factory.return_value.__aenter__.return_value = mock_session
            from app.jobs.archive import archive_old_events

            result = await archive_old_events()

        assert result["archived"] == 2
        assert result["version_count"] == 2
        assert minio_archive_mock.return_value.put_object.call_count == 2


class TestArchiveBoundary:
    """归档任务边界场景测试。"""

    async def test_empty_table_no_archive_log(self):
        """空表归档返回 0，不调用 insert_archive_log。"""
        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        mock_session.execute.return_value = mock_result

        with patch(
            "app.jobs.archive.async_session_factory"
        ) as mock_factory, patch(
            "app.jobs.archive.insert_archive_log"
        ) as mock_insert_log:
            mock_factory.return_value.__aenter__.return_value = mock_session
            from app.jobs.archive import archive_old_events

            result = await archive_old_events()

        assert result["archived"] == 0
        mock_insert_log.assert_not_called()

    async def test_cross_version_archive(self, minio_archive_mock):
        """不同 schema_version 的事件分桶归档。"""
        events = [
            _make_mock_event("evt-v1", schema_version=1),
            _make_mock_event("evt-v2", schema_version=2),
            _make_mock_event("evt-v3", schema_version=3),
        ]

        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = events
        mock_session.execute.return_value = mock_result

        with patch("app.jobs.archive.async_session_factory") as mock_factory:
            mock_factory.return_value.__aenter__.return_value = mock_session
            from app.jobs.archive import archive_old_events

            result = await archive_old_events()

        assert result["archived"] == 3
        assert result["version_count"] == 3

    async def test_concurrent_archive_no_crash(self, minio_archive_mock):
        """两次归档同时触发不会崩溃。"""
        events = [
            _make_mock_event("evt-a"),
            _make_mock_event("evt-b"),
        ]

        def _new_mock_session():
            s = AsyncMock()
            r = MagicMock()
            r.scalars.return_value.all.return_value = events
            s.execute.return_value = r
            return s

        sessions = [_new_mock_session(), _new_mock_session()]
        session_iter = iter(sessions)

        with patch("app.jobs.archive.async_session_factory") as mock_factory:
            mock_factory.return_value.__aenter__.side_effect = lambda: next(session_iter)
            from app.jobs.archive import archive_old_events

            results = await asyncio.gather(
                archive_old_events(),
                archive_old_events(),
            )

        for r in results:
            assert r["archived"] == 2
        for s in sessions:
            s.commit.assert_called_once()

    async def test_concurrent_archive_insert_log_per_call(self, minio_archive_mock):
        """并发归档时 insert_archive_log 被调用两次。"""
        events = [_make_mock_event("evt-x")]

        def _new_mock_session():
            s = AsyncMock()
            r = MagicMock()
            r.scalars.return_value.all.return_value = events
            s.execute.return_value = r
            return s

        sessions = [_new_mock_session(), _new_mock_session()]
        session_iter = iter(sessions)

        with patch(
            "app.jobs.archive.async_session_factory"
        ) as mock_factory, patch(
            "app.jobs.archive.insert_archive_log"
        ) as mock_insert_log:
            mock_factory.return_value.__aenter__.side_effect = lambda: next(session_iter)
            from app.jobs.archive import archive_old_events

            await asyncio.gather(
                archive_old_events(),
                archive_old_events(),
            )

        assert mock_insert_log.call_count == 2
        called_sessions = {c.kwargs["session"] for c in mock_insert_log.call_args_list}
        assert len(called_sessions) == 2

    async def test_mixed_empty_result(self, minio_archive_mock):
        """无数据时不触发 OSS put_object。"""
        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        mock_session.execute.return_value = mock_result

        with patch("app.jobs.archive.async_session_factory") as mock_factory:
            mock_factory.return_value.__aenter__.return_value = mock_session
            from app.jobs.archive import archive_old_events

            result = await archive_old_events()

        assert result["archived"] == 0
        minio_archive_mock.return_value.put_object.assert_not_called()
