"""Kaas v2 · 归档定时任务测试 (§13)

测试场景:
- archive_old_events 正常执行
- 无过期事件时返回 0
- 多租户归档到 MinIO
"""
from unittest.mock import MagicMock, AsyncMock, patch
from datetime import datetime, timezone, timedelta


class TestArchiveJob:
    """归档定时任务测试。"""

    async def test_archive_no_old_events_returns_zero(self):
        """无过期事件时归档返回 0。"""
        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        mock_session.execute.return_value = mock_result

        with patch("app.jobs.archive.async_session_factory") as mock_factory:
            mock_factory.return_value.__aenter__.return_value = mock_session
            from app.jobs.archive import archive_old_events

            result = await archive_old_events()
            assert result["archived"] == 0

    async def test_archive_writes_to_minio_and_log(self, minio_archive_mock):
        """有过期事件时归档到 MinIO 并写入日志。"""
        mock_event = MagicMock()
        mock_event.id = "evt-1"
        mock_event.created_at = datetime.now(timezone.utc) - timedelta(days=100)
        mock_event.trace_id = "a" * 32
        mock_event.route_version = "v2"
        mock_event.tenant_id = "liankai"
        mock_event.event_type = "chat.turn"
        mock_event.schema_version = "1.0"
        mock_event.payload = {"test": True}
        mock_event.sampled = True
        mock_event.source = "test"

        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [mock_event]
        mock_session.execute.return_value = mock_result

        with patch("app.jobs.archive.async_session_factory") as mock_factory:
            mock_factory.return_value.__aenter__.return_value = mock_session
            from app.jobs.archive import archive_old_events

            result = await archive_old_events()

        assert result["archived"] == 1
        assert result["tenants"] == ["liankai"]
        minio_archive_mock.return_value.put_object.assert_called_once()
        mock_session.commit.assert_called()

    async def test_archive_grouped_by_tenant(self, minio_archive_mock):
        """多租户事件按租户分别归档。"""
        events = []
        for i, tenant in enumerate(["liankai", "client_b"]):
            evt = MagicMock()
            evt.id = f"evt-{i}"
            evt.created_at = datetime.now(timezone.utc) - timedelta(days=100)
            evt.trace_id = f"{i:032d}"
            evt.route_version = "v2"
            evt.tenant_id = tenant
            evt.event_type = "chat.turn"
            evt.schema_version = "1.0"
            evt.payload = {}
            evt.sampled = False
            evt.source = "test"
            events.append(evt)

        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = events
        mock_session.execute.return_value = mock_result

        with patch("app.jobs.archive.async_session_factory") as mock_factory:
            mock_factory.return_value.__aenter__.return_value = mock_session
            from app.jobs.archive import archive_old_events

            result = await archive_old_events()

        assert result["archived"] == 2
        assert set(result["tenants"]) == {"liankai", "client_b"}
        assert minio_archive_mock.return_value.put_object.call_count == 2
