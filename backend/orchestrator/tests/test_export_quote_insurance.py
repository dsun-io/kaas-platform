"""整单保险（insurance_of_exw）的后端 API 行为锁定。

背景（2026-10-18）：整单保险是**前端两轮计算**：

  第一轮：保险按 0 算，拿到 `meta.term_totals[EXW][order]` 的整单 EXW 货值
          （报价币种、不含税，即 `total_excl_fx`，它也带 `total_excl` 人民币值）；
  第二轮：按 `max(15, EXW 货值 × 1.1 ÷ 1000)` 算出**美元**保险金额，
          作为 `insurance.mode=per_shipment / currency=USD` 的金额下发，
          由 CIF 档（在 CFR 之后）把它加进去。

后端不算这个公式（`formula=insurance_of_exw` 只是声明，供界面识别），
但后端必须保证两件事，否则前端的第二轮机算对不上：

  1. `term_totals` 提供 EXW / FOB / CFR（以及 CIF）**整单**金额，
     其中 EXW 的 `total_excl_fx` 就是「报价币种 EXW 货值」，且 > 0；
  2. 美元 `per_shipment` 费用按**本报价汇率**折成人民币后，
     CIF 相对 CFR 的整单人民币差额 == 保险美元金额 × 汇率
     （允许分摊到单件时的 4 位小数落定误差）。

本文件只补测试，不改生产代码；一律走 `/calculate` 公开接口（不依赖 UI）。
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.unit

BASE = "/api/v1/export-quote"

# 与 tests/test_export_quote_api.py 的 payload 同源：fx 6.7019、出口零税率。
FX = 6.7019

# 整单保险公式（业务口径，前端实现；这里作为独立参照系写一遍）
INSURANCE_MIN_USD = 15.0
INSURANCE_RATE = 1.1 / 1000  # 投保加成 110% / 费率 1‰ 的合并系数


def insurance_usd_of(exw_value_in_quote_currency: float) -> float:
    """整单保险美元金额 = max(15, EXW 货值(报价币种) × 1.1 ÷ 1000)。"""
    return max(INSURANCE_MIN_USD, exw_value_in_quote_currency * INSURANCE_RATE)


@pytest.fixture(autouse=True)
def _no_customer_pricing_data():
    """与 test_export_quote_api.py 同口径：单测里「客户还没配过定价数据」。

    计算接口会按客户 + 定价键查客户成本表；单测不依赖真实数据库，
    用返回空结果集的会话替身 ⇒ 引擎回退到产品定义里的内联成本。
    注意不能换成「查库失败就当没配」——那会把数据库故障静默变成兜底报价。
    """
    from app.db.session import get_db_session
    from app.main import app

    class _EmptyScalars:
        def all(self):
            return []

    class _EmptyResult:
        def scalars(self):
            return _EmptyScalars()

    class _StubSession:
        async def execute(self, *_args, **_kwargs):
            return _EmptyResult()

        async def commit(self):
            return None

        async def rollback(self):
            return None

    async def _override():
        yield _StubSession()

    app.dependency_overrides[get_db_session] = _override
    try:
        yield
    finally:
        app.dependency_overrides.pop(get_db_session, None)


def payload(**kw) -> dict:
    """与 test_export_quote_api.py 的基本 payload 一致（只是订单量由用例覆盖）。"""
    body = {
        "product_key": "field_fence",
        "fx_rate": FX,
        "orders": [{"total": 300000, "unit": "m"}],
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


def terms_with(insurance_usd: float | None = None) -> dict:
    """用**平台默认模板**构造阶梯，只填本用例需要的金额。

    · 第一轮：EXW / FOB / CFR 三档（保险 0，不参与）；
    · 第二轮：模板原样保留前四档 EXW / FOB / CFR / CIF，
      把算好的美元保险金额填进保险项（形态即前端下发的形态）。

    默认模板的币种口径必须被验证到：国内费用人民币，
    海运费/保险/目的港/进口税费一律美元（2026-10-18 用户口径）。
    """
    from app.services.export_quote.terms_template import default_terms_template

    tpl = default_terms_template()

    # 平台模板自身的保险口径：per_shipment 美元金额 + insurance_of_exw 声明
    insurance = tpl["items"]["insurance"]
    assert insurance["mode"] == "per_shipment"
    assert insurance["currency"] == "USD"
    assert insurance["formula"] == "insurance_of_exw"

    # 第一轮/第二轮共用的已填金额（国内费用人民币；海运费美元/吨）
    tpl["items"]["domestic_charges"]["value"] = 2000
    tpl["items"]["ocean_freight"]["value"] = 120

    # 默认阶梯前四档正是 EXW / FOB / CFR / CIF（CIF 只新增保险）
    ladder = tpl["ladder"]
    assert [r["code"] for r in ladder[:4]] == ["EXW", "FOB", "CFR", "CIF"]
    if insurance_usd is None:
        tpl["ladder"] = ladder[:3]
        tpl["quote_as"] = "CFR"
    else:
        tpl["ladder"] = ladder[:4]
        insurance["value"] = insurance_usd
        tpl["quote_as"] = "CIF"
    return tpl


def first_order(meta: dict) -> str:
    """整单金额按订单名索引；用例只下一个订单，取它的键即可。"""
    return next(iter(meta["term_totals"]["EXW"]))


async def calculate(async_client, **kw):
    r = await async_client.post(f"{BASE}/calculate", json=payload(**kw))
    assert r.status_code == 200, r.text
    return r.json()


class TestTermTotalsExposesExwValue:
    """第一轮：`term_totals` 必须能给出「报价币种 EXW 整单货值」。"""

    async def test_term_totals_has_exw_fob_cfr_and_exw_value_positive(self, async_client):
        data = await calculate(async_client, terms=terms_with())
        meta = data["meta"]
        assert meta["term_codes"] == ["EXW", "FOB", "CFR"]

        totals = meta["term_totals"]
        assert set(totals) == {"EXW", "FOB", "CFR"}

        order = first_order(meta)
        exw, fob, cfr = (totals[code][order] for code in ("EXW", "FOB", "CFR"))

        # 每一项都带齐前端要用的字段
        for entry in (exw, fob, cfr):
            for key in ("total_excl", "total_excl_fx", "total_incl", "total_fx", "price_incl"):
                assert key in entry, key

        # EXW 整单货值（报价币种）> 0，且等于人民币整单金额 ÷ 本报价汇率
        assert exw["total_excl_fx"] > 0
        assert exw["total_excl"] > 0
        assert exw["total_excl_fx"] == pytest.approx(exw["total_excl"] / FX, rel=1e-9, abs=1e-9)

        # 阶梯的累加单调性：EXW < FOB < CFR（整单人民币与外币口径都要成立）
        assert fob["total_excl"] > exw["total_excl"]
        assert cfr["total_excl"] > fob["total_excl"]
        assert fob["total_excl_fx"] > exw["total_excl_fx"]
        assert cfr["total_excl_fx"] > fob["total_excl_fx"]

    async def test_exw_value_is_order_level_not_per_piece(self, async_client):
        """同一规格下订单量翻倍，EXW 整单货值应约翻倍（验证它是整单口径）。"""
        small = await calculate(
            async_client,
            orders=[{"total": 300000, "unit": "m"}],
            terms=terms_with(),
        )
        large = await calculate(
            async_client,
            orders=[{"total": 600000, "unit": "m"}],
            terms=terms_with(),
        )

        def exw_fx(data):
            meta = data["meta"]
            return meta["term_totals"]["EXW"][first_order(meta)]["total_excl_fx"]

        ratio = exw_fx(large) / exw_fx(small)
        assert ratio == pytest.approx(2.0, rel=1e-6)


class TestTwoPassInsurance:
    """第二轮：把美元保险金额下发后，CIF − CFR（人民币）== 保险美元 × 汇率。"""

    async def test_proportional_branch_matches_cif_minus_cfr(self, async_client):
        """走「按 EXW 货值比例」分支（保险 > 15 美元）。"""
        orders = [{"total": 300000, "unit": "m"}]

        first = await calculate(async_client, orders=orders, terms=terms_with())
        order = first_order(first["meta"])
        exw_fx = first["meta"]["term_totals"]["EXW"][order]["total_excl_fx"]

        usd = insurance_usd_of(exw_fx)
        # 证明本用例确实走到了「货值比例」分支，而不是 15 美元兜底
        assert usd > INSURANCE_MIN_USD, f"订单量过小，未进入比例分支（usd={usd}）"

        second = await calculate(
            async_client, orders=orders, terms=terms_with(insurance_usd=usd)
        )
        meta = second["meta"]
        assert meta["term_codes"] == ["EXW", "FOB", "CFR", "CIF"]
        totals = meta["term_totals"]

        # 第二轮只增加 CIF 档，不得改变 EXW / FOB / CFR（前端两轮复算是同一张单）
        for code in ("EXW", "FOB", "CFR"):
            assert totals[code][order]["total_excl"] == pytest.approx(
                first["meta"]["term_totals"][code][order]["total_excl"], abs=1e-9
            )

        cfr = totals["CFR"][order]["total_excl"]
        cif = totals["CIF"][order]["total_excl"]
        gap_cny = cif - cfr

        # CIF 相对 CFR 的差额 == 保险美元金额 × 本报价汇率
        # 允许 4 位小数单件落定 × 件数带来的累计误差（3000 件约 0.15 元）+ 整单 2 位落定
        assert gap_cny > 0
        assert gap_cny == pytest.approx(usd * FX, abs=0.5)

        # 外币口径同样成立（total_fx 为含税整单美元，零税率时等于不含税）
        gap_usd = totals["CIF"][order]["total_fx"] - totals["CFR"][order]["total_fx"]
        assert gap_usd == pytest.approx(usd, abs=0.02)

    async def test_floor_branch_uses_15_usd(self, async_client):
        """走「最低 15 美元」分支：小单的保险金额被托底为 15 美元。"""
        orders = [{"total": 3000, "unit": "m"}]

        first = await calculate(async_client, orders=orders, terms=terms_with())
        order = first_order(first["meta"])
        exw_fx = first["meta"]["term_totals"]["EXW"][order]["total_excl_fx"]

        formula = max(INSURANCE_MIN_USD, exw_fx * INSURANCE_RATE)
        assert formula == INSURANCE_MIN_USD, (
            f"该订单量下按货值算出的保险已超过 15 美元（{formula}），"
            "无法用本用例锁定兜底分支"
        )

        second = await calculate(
            async_client, orders=orders, terms=terms_with(insurance_usd=INSURANCE_MIN_USD)
        )
        totals = second["meta"]["term_totals"]
        gap_cny = totals["CIF"][order]["total_excl"] - totals["CFR"][order]["total_excl"]
        # 30 件小单：单件 4 位落定累计误差 < 0.01
        assert gap_cny == pytest.approx(INSURANCE_MIN_USD * FX, abs=0.05)

    async def test_insurance_is_usd_amount_not_cny(self, async_client):
        """保险项是美元金额：若被当成人民币，差额会差一个汇率倍数。"""
        orders = [{"total": 300000, "unit": "m"}]
        first = await calculate(async_client, orders=orders, terms=terms_with())
        order = first_order(first["meta"])
        exw_fx = first["meta"]["term_totals"]["EXW"][order]["total_excl_fx"]
        usd = insurance_usd_of(exw_fx)

        second = await calculate(async_client, orders=orders, terms=terms_with(insurance_usd=usd))
        totals = second["meta"]["term_totals"]
        gap_cny = totals["CIF"][order]["total_excl"] - totals["CFR"][order]["total_excl"]

        # 正解差一个汇率（USD → CNY）；若把美元当人民币直接加，差额会接近 usd 本身
        assert gap_cny == pytest.approx(usd * FX, abs=0.5)
        assert abs(gap_cny - usd) > usd * (FX - 1) / 2
