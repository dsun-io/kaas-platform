from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402


def test_health_endpoint() -> None:
    with TestClient(app) as client:
        resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_chat_stub_mode() -> None:
    old_stub_mode = settings.chat_stub_mode
    old_stub_reply = settings.chat_stub_reply
    settings.chat_stub_mode = True
    settings.chat_stub_reply = "stub reply"
    try:
        payload = {
            "platform": "qianniu",
            "buyer_id": "buyer-1",
            "message": "你好",
        }
        with TestClient(app) as client:
            resp = client.post("/v1/chat", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["reply"] == "stub reply"
        assert data["should_transfer"] is False
        assert isinstance(data["conversation_id"], str) and data["conversation_id"]
    finally:
        settings.chat_stub_mode = old_stub_mode
        settings.chat_stub_reply = old_stub_reply


def test_chat_invalid_platform() -> None:
    payload = {
        "platform": "xxx",
        "buyer_id": "buyer-1",
        "message": "hello",
    }
    with TestClient(app) as client:
        resp = client.post("/v1/chat", json=payload)
    assert resp.status_code == 400
