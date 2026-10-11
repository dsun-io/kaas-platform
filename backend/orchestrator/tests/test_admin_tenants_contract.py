"""`/admin/tenants` 系列契约回归（用户裁决 P1 + P2 + P4）。

为什么单独一个文件、且**不带 db 标记**：
`tests/test_admin_api.py` 整体标了 `pytest.mark.db`（要真 PostgreSQL），
而这三个 handler 根本**不碰数据库**（租户配置来自 `config/tenants.yaml`）——
按仓库既有做法（`test_cors.py` 用 `async_client`），把它们放进 `unit`，
本地/CI 的 `pytest -m unit` 就能真正跑到，契约回归不会因为"没起库"被 skip 掉。

钉住的是**精确键集合**（与 `scripts/contracts-check.ts` 的 R5 同一期望）：
- `GET  /api/v1/admin/tenants`        → `{tenants:[{tenant_id, display_name, is_active}]}`
- `POST /api/v1/admin/tenants/reload` → `{reloaded_count, active_tenants:[{tenant_id,
                                          display_name, locale, region, is_active}]}`
- `GET  /api/v1/admin/feature_flag`   → `Record<tenant_id, Record<flag, bool>>`

修好前的实测症状（real 模式）：租户名空白（前端读 `t.name` 得到 undefined）、
状态恒"停用"（读 `t.is_active` 得到 undefined）、点"重载"`undefined.map` 崩。
"""
import pytest

from app.api import admin as admin_api
from app.domain.tenant_config import get_all_tenants

pytestmark = pytest.mark.unit

TENANT_ITEM_KEYS = {"tenant_id", "display_name", "is_active"}
RELOAD_ENVELOPE_KEYS = {"reloaded_count", "active_tenants"}
RELOAD_ITEM_KEYS = {"tenant_id", "display_name", "locale", "region", "is_active"}

HEADERS = {"X-Tenant-Id": "lianjia"}


@pytest.fixture(autouse=True)
def _no_audit_write(monkeypatch):
    """reload 会往 logs/deployment_audit.jsonl 追加一行 —— 单测不写真实文件系统。"""
    monkeypatch.setattr(admin_api, "_append_audit", lambda *a, **k: None)


class TestTenantsListContract:
    """GET /api/v1/admin/tenants。"""

    async def test_envelope_and_item_keys_are_exact(self, async_client):
        response = await async_client.get("/api/v1/admin/tenants", headers=HEADERS)
        assert response.status_code == 200
        body = response.json()

        assert set(body) == {"tenants"}, f"包封键应为 tenants，实际 {sorted(body)}"
        assert len(body["tenants"]) >= 2, "config/tenants.yaml 至少有 client_b / lianjia"

        for item in body["tenants"]:
            assert set(item) == TENANT_ITEM_KEYS, (
                f"条目键必须精确为 {sorted(TENANT_ITEM_KEYS)}，实际 {sorted(item)}"
            )
            assert isinstance(item["tenant_id"], str) and item["tenant_id"]
            assert isinstance(item["is_active"], bool), "状态键必须是 bool（前端按 is_active 渲染）"
            assert isinstance(item["display_name"], str) and item["display_name"], (
                "display_name 空 ⇒ 前端租户名列渲染空白（本缺陷的症状之一）"
            )

    async def test_display_name_comes_from_yaml_and_is_active_true(self, async_client):
        body = (await async_client.get("/api/v1/admin/tenants", headers=HEADERS)).json()
        by_id = {t["tenant_id"]: t for t in body["tenants"]}

        assert by_id["lianjia"]["display_name"] == "联佳丝网"
        assert by_id["client_b"]["display_name"] == "客户 B"
        # tenants.yaml 未写 enabled ⇒ 默认启用（不是恒"停用"）
        assert by_id["lianjia"]["is_active"] is True


class TestTenantsReloadContract:
    """POST /api/v1/admin/tenants/reload。"""

    async def test_returns_active_tenant_list(self, async_client):
        response = await async_client.post("/api/v1/admin/tenants/reload", headers=HEADERS)
        assert response.status_code == 200
        body = response.json()

        assert set(body) == RELOAD_ENVELOPE_KEYS, (
            f"包封键必须精确为 {sorted(RELOAD_ENVELOPE_KEYS)}，实际 {sorted(body)}"
        )
        assert isinstance(body["reloaded_count"], int)
        assert body["reloaded_count"] >= 2
        assert isinstance(body["active_tenants"], list) and body["active_tenants"], (
            "前端 reload-button.tsx:62 直接 active_tenants.map(...) —— 缺了就是线上崩"
        )

        for item in body["active_tenants"]:
            assert set(item) == RELOAD_ITEM_KEYS, (
                f"清单条目键必须精确为 {sorted(RELOAD_ITEM_KEYS)}，实际 {sorted(item)}"
            )
            assert isinstance(item["tenant_id"], str) and item["tenant_id"]
            assert isinstance(item["display_name"], str) and item["display_name"]
            assert isinstance(item["locale"], str)
            assert isinstance(item["region"], str)
            assert isinstance(item["is_active"], bool)

    async def test_locale_region_filled_from_config(self, async_client):
        body = (await async_client.post("/api/v1/admin/tenants/reload", headers=HEADERS)).json()
        by_id = {t["tenant_id"]: t for t in body["active_tenants"]}

        # tenants.yaml 里有 locale/region（不是空串）—— reload 后的表格要显示这两列
        assert by_id["lianjia"]["locale"] == "zh-CN"
        assert by_id["lianjia"]["region"] == "cn-east-1"
        assert by_id["lianjia"]["is_active"] is True


class TestFeatureFlagContract:
    """GET /api/v1/admin/feature_flag（与灰度页 use-feature-flags.ts:10-12 同形）。"""

    async def test_is_tenant_to_flags_map_keyed_by_tenant_id(self, async_client):
        response = await async_client.get("/api/v1/admin/feature_flag", headers=HEADERS)
        assert response.status_code == 200
        flags = response.json()

        assert isinstance(flags, dict) and flags
        assert set(flags) == set(get_all_tenants()), (
            "键必须与租户清单一致 —— 灰度页用 t.tenant_id 直接索引这个 map"
        )
        for tenant_id, tenant_flags in flags.items():
            assert isinstance(tenant_flags, dict), f"{tenant_id} 的 flags 应为映射"

        assert flags["lianjia"]["use_v2"] is True
        assert flags["client_b"]["use_v2"] is False

    async def test_every_listed_tenant_is_resolvable_in_the_map(self, async_client):
        """灰度页 map 的来源：`flags?.[t.tenant_id]?.["use_v2"] ?? false`。

        修复前 worker 版返回单值 `{flag_name, flag_value}` ⇒ 这里恒 undefined ⇒ 开关恒 OFF。
        """
        tenants = (await async_client.get("/api/v1/admin/tenants", headers=HEADERS)).json()
        flags = (await async_client.get("/api/v1/admin/feature_flag", headers=HEADERS)).json()

        for t in tenants["tenants"]:
            assert t["tenant_id"] in flags, f"{t['tenant_id']} 在 feature_flag map 里查不到"
