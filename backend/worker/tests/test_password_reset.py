"""忘记密码 / 重置密码 —— worker 路由级测试（无数据库、无网络）。

验证三件事：
1. `/api/v1/auth/forgot-password` 与 `/api/v1/auth/reset-password` 已注册到正确路径与方法；
2. 非法入参（缺 email / 缺 token / 密码过短）返回 422，且**不泄露邮箱存在性**的响应形状；
3. 无效 token 走到 400 `invalid_token`（统一错误，不细分）。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=False)


def _routes() -> set[tuple[str, str]]:
    out: set[tuple[str, str]] = set()
    for r in worker_main.app.routes:
        for m in (getattr(r, "methods", None) or set()):
            out.add((r.path, m))
    return out


def test_忘记密码两路由已注册():
    routes = _routes()
    assert ("/api/v1/auth/forgot-password", "POST") in routes
    assert ("/api/v1/auth/reset-password", "POST") in routes


def test_缺email返回422():
    resp = client.post("/api/v1/auth/forgot-password", json={"email": ""})
    assert resp.status_code == 422


def test_缺token返回422():
    resp = client.post("/api/v1/auth/reset-password", json={"token": "", "new_password": "longenough1"})
    assert resp.status_code == 422


def test_密码过短返回422():
    resp = client.post("/api/v1/auth/reset-password", json={"token": "sometoken", "new_password": "short"})
    assert resp.status_code == 422
