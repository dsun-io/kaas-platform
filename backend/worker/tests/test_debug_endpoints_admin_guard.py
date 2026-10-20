"""B0-6 诊断端点收敛：`_r2_debug` / `fx-rates/_debug` 仅平台管理员可用。

背景（PROBLEM_STATUS P2-⑩ / docs/archive/2026-10-20-closeout/HANDOVER_2026-10-17.md）：两个诊断端点是排障期留下的
线上自检口（R2 binding put/get 真实错误、汇率源直连探测），文档口径「管理员可访问，
不是公开面；收尾后可按需删除」。本次收敛选择**加保护而非删除**：HANDOVER 的故障
排查手册（汇率 503 先打 `/fx-rates/_debug`、文件 404 先打 `_r2_debug`）仍引用它们，
删掉会让 runbook 失效。保护方式与 worker 其他管理端点同一把尺（共享内核
`is_admin_role`）：普通登录用户 / 团队负责人一律 403 `ADMIN_ONLY`。

不改被测代码之外的任何东西；用例快、确定、无外网、无数据库。
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

load_main()  # 先装好 `workers` stub 并保证 `main` 可导入，再 import 路由模块

import ws_extras  # noqa: E402
import ws_files  # noqa: E402

# open.er-api.com 的真实响应形状（与 test_fx_rates.py 同一 fixture 口径）
_FX_PAYLOAD = {"time_last_update_unix": 1792195352, "rates": {"CNY": 6.698464}}


def _run(coro):
    return asyncio.run(coro)


# ── fx-rates/_debug ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("role", ["user", "customer_owner", None])
def test_fx_debug_rejects_non_admin(role):
    with pytest.raises(HTTPException) as ei:
        _run(ws_extras.fx_provider_debug(user={"role": role}))
    assert ei.value.status_code == 403
    assert ei.value.detail["code"] == "ADMIN_ONLY"


def test_fx_debug_allows_admin(monkeypatch):
    """管理员放行：到达打源那一层即可（stub 掉外网）。"""
    async def fake_get_json(url):
        return _FX_PAYLOAD

    monkeypatch.setattr(ws_extras, "_http_get_json", fake_get_json)
    out = _run(ws_extras.fx_provider_debug(user={"role": "system_admin"}))
    assert out["ok"] is True
    assert out["rate"] == pytest.approx(6.698464)


# ── file-objects/_r2_debug ───────────────────────────────────────────────────

@pytest.mark.parametrize("role", ["user", "customer_owner", None])
def test_r2_debug_rejects_non_admin(role):
    with pytest.raises(HTTPException) as ei:
        _run(ws_files.r2_debug(None, user={"role": role}))
    assert ei.value.status_code == 403
    assert ei.value.detail["code"] == "ADMIN_ONLY"


def test_r2_debug_allows_admin(monkeypatch):
    """管理员放行：binding 不可见时返回自检结果而不再 403。"""
    monkeypatch.setattr(wsf := ws_files, "_r2_bucket", lambda _req: None)
    out = _run(wsf.r2_debug(None, user={"role": "system_admin"}))
    assert out["binding"] is False
    assert out["put_ok"] is False
    assert out["get_ok"] is False
