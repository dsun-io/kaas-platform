"""客户税率档案 API 测试（「税务档案」下拉里的客户那一层）。

锁定的事实：
  · 存进去什么、取出来还是什么 —— 这是档案的全部价值；
  · **0 与「没填」是两件事**：0 会把销项税那一环定死，没填则取法定值。
    JSON 里两者长得很像，被吞掉也不会报错，只会让报价偏高或偏低；
  · 打错的键名要**报错**，不能静默存下（否则界面显示「保存成功」、下次取出少一项）；
  · 按百分数填的税率（10 而非 0.1）要拦下 —— 差一个数量级且不会有任何提示；
  · 列表按创建时间倒序 —— 界面「默认选最新」靠这个顺序；
  · 跨客户改不到别人的档案。

⚠️ 本文件**需要 PostgreSQL**（数据真的写进表、再读回来，用桩替代就只是在测桩）。
   本机没起测试库时会整体 skip（理由见 conftest 的 `_probe_test_db`），
   所以「本机跑出来的全绿」**不能**当作这几个用例通过。
   本机可复现的功能证据是 `scripts/verify/verify_quote_profiles.py`
   与 `scripts/verify/verify_profile_e2e.py`（对着开发库走真实 HTTP，逐项断言）。
"""
import pytest

pytestmark = pytest.mark.db

BASE = "/api/v1/quote-profiles"
ADMIN = {"X-Test-Role": "admin"}
PRODUCT = "field_fence"


def body(**kw) -> dict:
    b = {
        "product_key": PRODUCT,
        "profile_name": "美国线-普票",
        "rate_set_code": "CN-2026-09",
        "tax_overrides": {"input_vat_rate": 0.13, "rebate_rate": 0.13},
    }
    b.update(kw)
    return b


async def _save(client, **kw):
    r = await client.post(BASE, json=body(**kw))
    assert r.status_code == 201, r.text
    return r.json()


class TestSaveAndReadBack:
    async def test_values_round_trip(self, client):
        created = await _save(
            client,
            tax_overrides={
                "input_vat_rate": 0.13,
                "output_vat_rate": 0.0,
                "rebate_rate": 0.13,
                "stamp_rate": 0.05,
                "stamp_base": "profit",
            },
        )
        r = await client.get(BASE, params={"product_key": PRODUCT})
        assert r.status_code == 200
        row = next(p for p in r.json()["profiles"] if p["id"] == created["id"])
        assert row["tax_overrides"]["input_vat_rate"] == 0.13
        assert row["tax_overrides"]["rebate_rate"] == 0.13
        assert row["tax_overrides"]["stamp_base"] == "profit"

    async def test_zero_is_kept_and_missing_stays_missing(self, client):
        """0 与「没填」必须分得开。

        销项税率 0（出口零税率）是**一个有效的政策值**；而「没填」表示取法定值。
        两者在 JSON 里很容易被混成同一个东西，混掉之后报价会系统性偏移，
        且没有任何报错。
        """
        created = await _save(
            client,
            tax_overrides={"input_vat_rate": 0.1, "output_vat_rate": 0.0},
        )
        overrides = created["tax_overrides"]
        assert overrides["output_vat_rate"] == 0.0
        # 没填的项不应该被塞成 null —— 那会变成「档案里有一项叫 null」
        assert "stamp_rate" not in overrides
        assert "stamp_base" not in overrides

    async def test_rate_set_code_is_remembered(self, client):
        """必须记住法定档案：两层在同一个下拉里，缺了它档案就不可复现。"""
        created = await _save(client, rate_set_code="CN-2026-09")
        assert created["rate_set_code"] == "CN-2026-09"


class TestValidation:
    async def test_unknown_tax_key_is_rejected(self, client):
        """键名打错必须报错，不能静默存下。"""
        r = await client.post(BASE, json=body(tax_overrides={"input_vat_rates": 0.1}))
        assert r.status_code == 422

    async def test_percent_scale_value_is_rejected(self, client):
        """按百分数填（10 而非 0.1）要拦下：差一个数量级且不会报错。"""
        r = await client.post(BASE, json=body(tax_overrides={"input_vat_rate": 10}))
        assert r.status_code == 422

    async def test_empty_archive_is_rejected(self, client):
        """空档案套用后什么都不会变，是误操作。"""
        r = await client.post(BASE, json=body(tax_overrides={}))
        assert r.status_code == 422

    async def test_blank_name_is_rejected(self, client):
        r = await client.post(BASE, json=body(profile_name="   "))
        assert r.status_code == 422

    async def test_missing_rate_set_code_is_rejected(self, client):
        r = await client.post(BASE, json=body(rate_set_code=""))
        assert r.status_code == 422

    async def test_unknown_product_is_404(self, client):
        r = await client.post(BASE, json=body(product_key="not_a_product"))
        assert r.status_code == 404


class TestDuplicates:
    async def test_same_name_rejected(self, client):
        """重名要拦：两份同名档案摆在下拉里，选哪个都一样 —— 那等于没有档案。"""
        await _save(client, profile_name="重名测试")
        r = await client.post(BASE, json=body(profile_name="重名测试"))
        assert r.status_code == 409

    async def test_rename_to_existing_name_rejected(self, client):
        a = await _save(client, profile_name="甲")
        await _save(client, profile_name="乙")
        r = await client.patch(f"{BASE}/{a['id']}", json={"profile_name": "乙"})
        assert r.status_code == 409


class TestOrdering:
    async def test_newest_first(self, client):
        """按创建时间倒序 —— 界面「默认选最新创建的」直接取第一条。"""
        first = await _save(client, profile_name="先建的")
        second = await _save(client, profile_name="后建的")
        r = await client.get(BASE, params={"product_key": PRODUCT})
        ids = [p["id"] for p in r.json()["profiles"]]
        assert ids.index(second["id"]) < ids.index(first["id"])


class TestUpdate:
    async def test_rename_keeps_content(self, client):
        created = await _save(client)
        r = await client.patch(f"{BASE}/{created['id']}", json={"profile_name": "改过的名字"})
        assert r.status_code == 200
        assert r.json()["profile_name"] == "改过的名字"
        # 改名不该动内容
        assert r.json()["tax_overrides"]["input_vat_rate"] == 0.13

    async def test_patch_unknown_id_is_404(self, client):
        r = await client.patch(f"{BASE}/999999", json={"profile_name": "x"})
        assert r.status_code == 404


class TestDelete:
    async def test_delete_removes_from_list(self, client):
        created = await _save(client)
        r = await client.delete(f"{BASE}/{created['id']}")
        assert r.status_code == 200
        r = await client.get(BASE, params={"product_key": PRODUCT})
        assert all(p["id"] != created["id"] for p in r.json()["profiles"])

    async def test_delete_is_soft(self, db_session):
        """软删：历史报价要能回答「当时用的是哪套税率」。

        直接查库确认行还在、只是 status 变了 —— 只看接口是看不出「删了还是停用了」的。
        """
        from sqlalchemy import select

        from app.db.models import CustomerQuoteProfile
        from app.repositories.quote_profiles_repo import create_profile

        p = await create_profile(
            db_session, tenant_id="lianjia", customer_id="1",
            product_key=PRODUCT, profile_name="软删检查",
            rate_set_code="CN-2026-09", tax_overrides={"input_vat_rate": 0.1},
        )
        await db_session.flush()
        pid = p.id

        from app.repositories.quote_profiles_repo import deactivate_profile

        await deactivate_profile(db_session, p)
        await db_session.flush()

        row = (
            await db_session.execute(
                select(CustomerQuoteProfile).where(CustomerQuoteProfile.id == pid)
            )
        ).scalar_one()
        assert row.status == "inactive"


class TestPermissions:
    async def test_scope_all_requires_admin(self, client):
        r = await client.get(BASE, params={"product_key": PRODUCT, "scope": "all"})
        assert r.status_code == 403

    async def test_scope_all_ok_for_admin(self, client):
        await _save(client)
        r = await client.get(
            BASE, params={"product_key": PRODUCT, "scope": "all"}, headers=ADMIN
        )
        assert r.status_code == 200
        assert r.json()["scope"] == "all"

    async def test_bad_scope_is_422(self, client):
        r = await client.get(BASE, params={"product_key": PRODUCT, "scope": "everyone"})
        assert r.status_code == 422

    async def test_product_key_required(self, client):
        r = await client.get(BASE)
        assert r.status_code == 422

    async def test_identity_in_body_is_rejected(self, client):
        """身份一律从 AuthContext 取，body 里夹带要拦。"""
        r = await client.post(BASE, json=body(tenant_id="other-tenant"))
        assert r.status_code == 403
