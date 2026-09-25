"""出口报价 API 测试。

锁定的事实：
  · 客户视图接口不含成本/利润/税额列，内部视图要管理员权限
  · 报价有效期默认 7 天并回显 valid_until
  · 法定税率来自税务档案，请求可逐项覆盖
  · 退税率查不到时接口返回 found=false + 人工确认提示，不猜一个数
  · 术语阶梯按用户填写的数值生效，引擎不给默认运费
"""
from datetime import date

import pytest

pytestmark = pytest.mark.unit

BASE = "/api/v1/export-quote"

ADMIN = {"X-Test-Role": "admin"}


def payload(**kw) -> dict:
    body = {
        "product_key": "field_fence",
        "rate_set_code": "CN-2026-09",
        "fx_rate": 6.7019,
        "orders": [{"total": 30000, "unit": "m"}],
        "quote_date": "2026-09-24",
        "policy": {
            "input_vat_rate": 0.10,
            "output_vat_rate": 0.0,
            "profit_mode": "fixed",
            "profit_value": 0.1,
            "give_ratio": 0.8,
            # 退税率未核实，故显式给可退税比例（不让引擎猜）
            "refund_ratio": 1.0,
            "stamp_rate": 0.05,
            "stamp_base": "profit",
        },
    }
    body.update(kw)
    return body


class TestMeta:
    async def test_products(self, async_client):
        r = await async_client.get(f"{BASE}/products")
        assert r.status_code == 200
        data = r.json()
        keys = {p["key"] for p in data["products"]}
        assert {"field_fence", "welded_pipe"} <= keys
        fence = next(p for p in data["products"] if p["key"] == "field_fence")
        assert fence["combo_count"] == 48
        assert fence["hs_codes"]

    async def test_rate_sets_are_listed_with_warnings(self, async_client):
        r = await async_client.get(f"{BASE}/rate-sets")
        assert r.status_code == 200
        data = r.json()
        codes = {rs["code"] for rs in data["rate_sets"]}
        assert "CN-2026-09" in codes
        # 示例档案不得出现在生产档案列表里
        assert "CN-2027-01" not in codes
        rs = next(x for x in data["rate_sets"] if x["code"] == "CN-2026-09")
        assert rs["levy_rate"] == 0.13
        assert rs["stamp_duty"] == {"rate": 0.05, "base": "profit"}

    async def test_reload_requires_admin(self, async_client):
        assert (await async_client.post(f"{BASE}/rate-sets/reload")).status_code == 403
        r = await async_client.post(f"{BASE}/rate-sets/reload", headers=ADMIN)
        assert r.status_code == 200
        assert "CN-2026-09" in r.json()["codes"]


class TestCalculate:
    async def test_customer_view_succeeds_and_has_no_cost_columns(self, async_client):
        r = await async_client.post(f"{BASE}/calculate", json=payload())
        assert r.status_code == 200
        data = r.json()
        assert data["view"] == "customer"
        assert "internal" not in data
        header = data["customer"]["header"]
        assert header
        for label in ("税前成本", "含税采购价", "加工利润", "进项税额", "让利额"):
            assert not any(label in h for h in header), f"客户视图泄露「{label}」"

    async def test_internal_view_requires_admin(self, async_client):
        r = await async_client.post(f"{BASE}/calculate-internal", json=payload())
        assert r.status_code == 403

    async def test_internal_view_shows_cost_chain(self, async_client):
        r = await async_client.post(
            f"{BASE}/calculate-internal", json=payload(), headers=ADMIN
        )
        assert r.status_code == 200
        data = r.json()
        assert data["view"] == "internal"
        header = data["internal"]["header"]
        for label in ("税前成本", "加工利润", "进项税额", "自留可退税额", "印花税"):
            assert any(label in h for h in header), f"内部视图缺少「{label}」"

    async def test_validity_defaults_to_7_days(self, async_client):
        r = await async_client.post(f"{BASE}/calculate", json=payload())
        meta = r.json()["meta"]
        assert meta["validity_days"] == 7
        assert meta["quote_date"] == "2026-09-24"
        assert meta["valid_until"] == "2026-10-01"

    async def test_validity_can_be_extended(self, async_client):
        r = await async_client.post(f"{BASE}/calculate", json=payload(validity_days=30))
        assert r.json()["meta"]["valid_until"] == "2026-10-24"

    async def test_invalid_validity_rejected(self, async_client):
        for bad in (0, -1, 400):
            r = await async_client.post(f"{BASE}/calculate", json=payload(validity_days=bad))
            assert r.status_code == 422, bad

    async def test_unknown_rate_set_is_400(self, async_client):
        r = await async_client.post(
            f"{BASE}/calculate", json=payload(rate_set_code="NOPE")
        )
        assert r.status_code == 400
        assert r.json()["detail"]["error"] == "rate_set_error"

    async def test_unknown_product_is_400(self, async_client):
        r = await async_client.post(f"{BASE}/calculate", json=payload(product_key="nope"))
        assert r.status_code == 400
        assert r.json()["detail"]["error"] == "engine_error"

    async def test_policy_override_changes_price(self, async_client):
        """让利比例可调：让利越多，报价越低。"""
        low = await async_client.post(
            f"{BASE}/calculate", json=payload(policy={**payload()["policy"], "give_ratio": 0.0})
        )
        high = await async_client.post(
            f"{BASE}/calculate", json=payload(policy={**payload()["policy"], "give_ratio": 0.8})
        )
        assert low.status_code == high.status_code == 200
        # 取单卷人民币价所在列比较
        def price(data):
            header = data["customer"]["header"]
            idx = next(
                i for i, h in enumerate(header) if "单卷售价(元/卷)" == h
            )
            return [row[idx] for row in data["customer"]["rows"]]

        assert min(price(high.json())) < min(price(low.json())), "让利 80% 应比不让利更便宜"

    async def test_output_vat_makes_price_higher_when_not_zero(self, async_client):
        """销项税是价外税：税率非 0 时客户价必须变高。

        出口当前是零税率，但政策变化时可配 —— 逻辑必须对。
        """
        zero = await async_client.post(f"{BASE}/calculate", json=payload())
        taxed = await async_client.post(
            f"{BASE}/calculate",
            json=payload(policy={**payload()["policy"], "output_vat_rate": 0.13}),
        )
        assert zero.status_code == taxed.status_code == 200

        def sole_piece_price(data):
            header = data["customer"]["header"]
            idx = next(i for i, h in enumerate(header) if h == "单卷售价(元/卷)")
            return data["customer"]["rows"][0][idx]

        assert sole_piece_price(taxed.json()) > sole_piece_price(zero.json())

    async def test_verification_can_be_requested(self, async_client):
        r = await async_client.post(
            f"{BASE}/calculate", json=payload(with_verification=True)
        )
        assert r.status_code == 200
        v = r.json()["verification"]
        assert v["ok"] is True, v
        assert v["checks"] > 0

    async def test_multiple_orders(self, async_client):
        r = await async_client.post(
            f"{BASE}/calculate",
            json=payload(
                orders=[
                    {"total": 30000, "unit": "m", "label": "3万米"},
                    {"total": 50000, "unit": "m", "label": "5万米"},
                ]
            ),
        )
        assert r.status_code == 200
        names = [o["name"] for o in r.json()["meta"]["orders"]]
        assert len(names) == 2

    async def test_terms_ladder_uses_user_supplied_values(self, async_client):
        body = payload(
            terms={
                "quote_as": "FOB",
                "items": {
                    "inland": {"name": "内陆", "mode": "per_shipment", "value": "2000"},
                    "customs": {"name": "报关", "mode": "per_shipment", "value": "500"},
                },
                "ladder": [
                    {"code": "EXW"},
                    {"code": "FOB", "items": ["inland", "customs"]},
                ],
            }
        )
        r = await async_client.post(f"{BASE}/calculate", json=body)
        assert r.status_code == 200
        meta = r.json()["meta"]
        assert meta["quote_as"] == "FOB"
        assert meta["term_codes"] == ["EXW", "FOB"]

    async def test_terms_missing_value_is_400_not_silent_zero(self, async_client):
        """费用既没 value 也取不到 source 时必须报错，不能静默按 0 报价。"""
        body = payload(
            terms={
                "items": {"ocean": {"name": "海运", "mode": "per_shipment"}},
                "ladder": [{"code": "EXW"}, {"code": "FOB", "items": ["ocean"]}],
            }
        )
        r = await async_client.post(f"{BASE}/calculate", json=body)
        assert r.status_code == 400
        assert r.json()["detail"]["error"] in ("terms_error", "engine_error")


class TestFormulasEndpoints:
    """产品的规格空间与计算逻辑，必须能被业务读到并自证。"""

    async def test_formulas_expose_space_and_logic(self, async_client):
        r = await async_client.get(f"{BASE}/products/field_fence/formulas")
        assert r.status_code == 200
        d = r.json()
        assert d["space"]["combo_count"] == 48
        calc = d["calculations"]
        assert calc["derived"] and calc["piece"] and calc["order"]
        # 每条都要有单位与口径说明，否则业务看不懂
        for stage in ("derived", "piece", "order"):
            for f in calc[stage]:
                assert f["unit"], f
                assert f["note"], f
        assert d["space_deduction"]["range"] == [2, 3]
        assert "实际占用体积" in d["space_deduction"]["note"]

    async def test_wave_and_volume_formulas_are_documented(self, async_client):
        d = (await async_client.get(
            f"{BASE}/products/field_fence/formulas")).json()
        by_code = {f["code"]: f for stage in d["calculations"]
                   for f in d["calculations"][stage]}
        assert "100 米" in by_code["wave_add_kg"]["note"]
        assert "3" in by_code["wave_add_kg"]["note"]
        assert "卷径" in by_code["volume_per_piece_m3"]["note"]
        assert "长方体总体积" in by_code["volume_effective_m3"]["note"]

    async def test_formulas_unknown_product_is_404(self, async_client):
        r = await async_client.get(f"{BASE}/products/nope/formulas")
        assert r.status_code == 404
        assert r.json()["detail"]["error"] == "unknown_product"

    async def test_explain_step_by_step_reproduces_baseline(self, async_client):
        r = await async_client.post(
            f"{BASE}/products/field_fence/explain",
            json={"spec": {"height_m": 1.2, "mesh_mm": 100, "wire": "全丝2.0",
                           "coating": "普锌40g/㎡", "wave": "无波款"},
                  "total": 30000},
        )
        assert r.status_code == 200, r.text
        j = r.json()
        got = {s["code"]: s["value"] for s in j["steps"]}
        assert got["weight_per_piece_kg"] == "65.4020"
        # 圆柱体净体积 vs 长方体体积，两个口径都要能读到
        assert got["volume_per_piece_m3"] == "0.0848"
        assert got["volume_box_per_piece_m3"] == "0.1080"
        assert got["volume_box_m3"] == "32.4000"
        assert got["volume_effective_m3"] == "29.9000"
        assert got["pieces"] == "300"

    async def test_explain_wave_adds_three_kg_on_100m_roll(self, async_client):
        r = await async_client.post(
            f"{BASE}/products/field_fence/explain",
            json={"spec": {"height_m": 1.2, "mesh_mm": 100, "wire": "全丝2.0",
                           "coating": "普锌40g/㎡", "wave": "波弯款"},
                  "total": 30000},
        )
        got = {s["code"]: s["value"] for s in r.json()["steps"]}
        assert got["wave_add_kg"] == "3"
        assert got["weight_per_piece_kg"] == "68.4020"

    async def test_explain_wave_adds_only_1_5kg_on_50m_roll(self, async_client):
        r = await async_client.post(
            f"{BASE}/products/field_fence/explain",
            json={"spec": {"height_m": 1.2, "mesh_mm": 100, "wire": "全丝2.5",
                           "coating": "普锌40g/㎡", "wave": "波弯款"},
                  "total": 30000},
        )
        got = {s["code"]: s["value"] for s in r.json()["steps"]}
        assert got["wave_add_kg"] == "1.5"
        assert got["pieces"] == "600"

    async def test_explain_metric_filter_keeps_dependencies(self, async_client):
        """只取几个量时，依赖项仍须求值，否则下游是空。"""
        r = await async_client.post(
            f"{BASE}/products/field_fence/explain",
            json={"spec": {"height_m": 1.2, "mesh_mm": 100, "wire": "全丝2.0",
                           "coating": "普锌40g/㎡", "wave": "无波款"},
                  "total": 30000,
                  "metrics": ["volume_effective_m3", "wave_add_kg"]},
        )
        steps = r.json()["steps"]
        assert {s["code"] for s in steps} == {"volume_effective_m3", "wave_add_kg"}
        vals = {s["code"]: s["value"] for s in steps}
        assert vals["volume_effective_m3"] == "29.9000"

    async def test_explain_omits_price_metrics_with_hint(self, async_client):
        """价格类量不在本接口算 —— 给 0 会让人误以为价格是 0。"""
        r = await async_client.post(
            f"{BASE}/products/field_fence/explain",
            json={"spec": {"height_m": 1.2, "mesh_mm": 100, "wire": "全丝2.0",
                           "coating": "普锌40g/㎡", "wave": "无波款"}},
        )
        j = r.json()
        codes = {s["code"] for s in j["steps"]}
        assert "total_price" not in codes
        assert "price_per_piece" not in codes
        assert j["price_metrics_omitted"]
        assert "/calculate" in j["price_hint"]

    async def test_explain_missing_axis_is_400(self, async_client):
        r = await async_client.post(
            f"{BASE}/products/field_fence/explain",
            json={"spec": {"height_m": 1.2}},
        )
        assert r.status_code == 400
        assert r.json()["detail"]["error"] == "missing_axis"

    async def test_explain_unknown_variant_is_400(self, async_client):
        r = await async_client.post(
            f"{BASE}/products/field_fence/explain",
            json={"spec": {"height_m": 1.2, "mesh_mm": 100, "wire": "不存在",
                           "coating": "普锌40g/㎡", "wave": "无波款"}},
        )
        assert r.status_code == 400
        assert r.json()["detail"]["error"] == "unknown_variant"

    async def test_explain_needs_only_login_not_admin(self, async_client):
        """解释口径不涉及成本利润，普通用户即可调用。"""
        r = await async_client.post(
            f"{BASE}/products/field_fence/explain",
            json={"spec": {"height_m": 1.2, "mesh_mm": 100, "wire": "全丝2.0",
                           "coating": "普锌40g/㎡", "wave": "无波款"}},
        )
        assert r.status_code == 200
        # 不得泄露任何成本/利润字样
        blob = str(r.json())
        for word in ("cost_pretax", "profit", "税前成本", "加工利润"):
            assert word not in blob, f"explain 接口泄露了 {word}"


class TestRebateLookup:
    async def test_unconfirmed_hs_reports_not_found_with_hint(self, async_client):
        """牛栏网 HS 的退税率尚未核实 → 明确返回未找到 + 人工确认提示。"""
        r = await async_client.post(
            f"{BASE}/rebate-rate/lookup",
            json={"hs_code": "7314410000", "rate_set_code": "CN-2026-09"},
        )
        assert r.status_code == 200
        data = r.json()
        assert data["found"] is False
        assert data["hs_code"] == "7314410000"
        assert "核实" in data["hint"]
        assert "message" in data

    async def test_hs_code_is_normalized(self, async_client):
        r = await async_client.post(
            f"{BASE}/rebate-rate/lookup", json={"hs_code": "7314.41.00.00"}
        )
        assert r.json()["hs_code"] == "7314410000"

    async def test_bad_rate_set_is_400(self, async_client):
        r = await async_client.post(
            f"{BASE}/rebate-rate/lookup",
            json={"hs_code": "7314410000", "rate_set_code": "NOPE"},
        )
        assert r.status_code == 400

    async def test_missing_hs_code_is_422(self, async_client):
        r = await async_client.post(f"{BASE}/rebate-rate/lookup", json={})
        assert r.status_code == 422


class TestVerifyEndpoint:
    async def test_verify_requires_admin(self, async_client):
        assert (await async_client.post(f"{BASE}/verify", json=payload())).status_code == 403

    async def test_verify_reports_ok(self, async_client):
        r = await async_client.post(f"{BASE}/verify", json=payload(), headers=ADMIN)
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is True, data["errors"]
        assert data["checks"] > 0
        assert data["errors"] == []


class TestAuthAndTenancy:
    async def test_endpoints_require_auth_context(self, async_client):
        """接口都挂了鉴权依赖；默认测试身份为普通用户，仅管理员接口返回 403。"""
        assert (await async_client.post(f"{BASE}/calculate", json=payload())).status_code == 200
        assert (
            await async_client.post(f"{BASE}/calculate-internal", json=payload())
        ).status_code == 403
        assert (await async_client.post(f"{BASE}/verify", json=payload())).status_code == 403
        assert (await async_client.post(f"{BASE}/rate-sets/reload")).status_code == 403

    async def test_tenant_header_is_accepted(self, async_client):
        r = await async_client.post(
            f"{BASE}/calculate",
            json=payload(),
            headers={"X-Tenant-Id": "acme"},
        )
        assert r.status_code == 200


class TestRateSetVersusRepo:
    async def test_quote_date_drives_archive_selection(self, async_client):
        """不指定档案时按报价日解析；2026-09-24 落在 CN-2026-09 生效期内。"""
        body = payload(rate_set_code=None, quote_date="2026-09-24")
        r = await async_client.post(f"{BASE}/calculate", json=body)
        assert r.status_code == 200
        assert r.json()["meta"]["rate_set_code"] == "CN-2026-09"

    async def test_date_before_any_archive_is_400(self, async_client):
        r = await async_client.post(
            f"{BASE}/calculate", json=payload(rate_set_code=None, quote_date="2019-01-01")
        )
        assert r.status_code == 400
        assert r.json()["detail"]["error"] == "rate_set_error"
