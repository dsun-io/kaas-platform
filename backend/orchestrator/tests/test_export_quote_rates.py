"""税务档案与退税率查询测试。

锁定的事实：
  · 法定税率集中在版本化档案里，政策变化**新增**档案而不改旧档案
    ⇒ 历史报价可逐分复现
  · 档案按日期解析时取生效日最晚的一份
  · 退税率按 HS 编码查，查不到**报错而不猜**
  · Provider 链：HTTP → 本地档案库；缓存命中带 cached 标记，负缓存避免反复打失败接口
"""
from datetime import date, timedelta
import json
import pathlib

import pytest

from app.services.export_quote.rates import (
    RATE_SETS_DIR,
    CachedProvider,
    ChainProvider,
    HttpRebateProvider,
    LocalLibraryProvider,
    RateSet,
    RateSetError,
    RateSetRegistry,
    RebateRateNotFound,
    RebateResult,
    build_default_provider,
    normalize_hs,
    provider_enabled,
    provider_source_label,
    rate_set_from_dict,
)

pytestmark = pytest.mark.unit


def registry() -> RateSetRegistry:
    return RateSetRegistry(
        [
            rate_set_from_dict(
                {
                    "code": "CN-A",
                    "country": "CN",
                    "effective_from": "2026-01-01",
                    # 已被 CN-B 取代 → 有明确结束日，避免"新旧档案同时无限生效"
                    "effective_to": "2026-12-31",
                    "vat": {"output_rate_export": 0.0},
                    "stamp_duty": {"rate": 0.05, "base": "profit"},
                    "export_rebate": {"by_hs_code": {"7314410000": 0.13}},
                }
            ),
            rate_set_from_dict(
                {
                    "code": "CN-B",
                    "country": "CN",
                    "effective_from": "2027-01-01",
                    "vat": {"output_rate_export": 0.0},
                    # 印花税从 5% 提到 6%：只改新档案，不动旧档案
                    "stamp_duty": {"rate": 0.06, "base": "profit"},
                    "export_rebate": {"by_hs_code": {"7314410000": 0.12}},
                }
            ),
        ]
    )


# ─────────────────────────────────────────────────────────────────────────────
# 档案解析
# ─────────────────────────────────────────────────────────────────────────────
class TestRateSetRegistry:
    def test_resolve_by_code_is_exact(self):
        reg = registry()
        assert reg.get("CN-A").output_rate_export == 0.0
        assert reg.get("CN-B").stamp_duty.rate == 0.06

    def test_unknown_code_lists_available(self):
        with pytest.raises(RateSetError, match="CN-A"):
            registry().get("CN-ZZZ")

    def test_resolve_by_date_picks_latest_effective(self):
        reg = registry()
        assert reg.resolve(None, date(2026, 9, 24)).code == "CN-A"
        assert reg.resolve(None, date(2027, 3, 1)).code == "CN-B"
        # 生效日当天算生效
        assert reg.resolve(None, date(2027, 1, 1)).code == "CN-B"

    def test_no_effective_set_for_date_raises(self):
        reg = RateSetRegistry(
            [rate_set_from_dict({"code": "X", "effective_from": "2030-01-01"})]
        )
        with pytest.raises(RateSetError, match="没有生效"):
            reg.resolve(None, date(2026, 9, 24))

    def test_explicit_code_outside_its_window_raises(self):
        """按编号取档案但日期不在生效期 → 报错，避免误用旧税率。"""
        with pytest.raises(RateSetError, match="不覆盖"):
            registry().resolve("CN-A", date(2027, 6, 1))

    def test_policy_change_does_not_mutate_old_archive(self):
        """政策变化只加新档案；旧档案依旧给出旧税率（历史报价可复现）。"""
        reg = registry()
        old = reg.get("CN-A")
        assert old.stamp_duty.rate == 0.05
        # 解析 2027 的档案不会改动 2026 的
        reg.resolve(None, date(2027, 6, 1))
        assert reg.get("CN-A").stamp_duty.rate == 0.05

    def test_repo_rate_sets_load_and_are_authoritative(self):
        """仓库自带的档案必须能加载，且**不含**示例档案。

        示例档案放在 rate_sets/examples/ 下、不参与自动加载 —— 它带的是假税率，
        一旦被当成"当期生效档案"，从 2027-01-01 起的报价会静默用错税率。
        """
        reg = RateSetRegistry.from_dir()
        assert "CN-2026-09" in reg.codes
        assert "CN-2027-01" not in reg.codes, "示例档案不得进入自动解析范围"

    def test_example_archive_loads_only_when_explicitly_pointed_at(self):
        """显式指定 examples 目录时示例档案可用 —— 证明版本化机制，同时隔离风险。"""
        reg = RateSetRegistry.from_dir(RATE_SETS_DIR / "examples")
        assert "CN-2027-01" in reg.codes
        # 同一天两份档案都在生效期时，取生效日最晚的一份
        combined = RateSetRegistry(
            RateSetRegistry.from_dir().all() + reg.all()
        )
        assert combined.resolve(None, date(2026, 9, 24)).code == "CN-2026-09"
        assert combined.resolve(None, date(2027, 6, 1)).code == "CN-2027-01"

    def test_policy_change_adds_archive_without_touching_engine(self):
        """销项默认税率 13%→12%、印花税 5%→6% 的变化只体现在新档案里，旧档案原样不动。"""
        real = RateSetRegistry.from_dir().get("CN-2026-09")
        demo = RateSetRegistry.from_dir(RATE_SETS_DIR / "examples").get("CN-2027-01")
        assert real.output_rate_default == 0.13 and real.stamp_duty.rate == 0.05
        assert demo.output_rate_default == 0.12 and demo.stamp_duty.rate == 0.06
        assert demo.stamp_duty.base == "profit", "印花税基数仍按加工利润"

    def test_missing_code_rejected(self):
        with pytest.raises(RateSetError, match="缺少 code"):
            RateSetRegistry([rate_set_from_dict({})])


class TestRateSetAudit:
    def test_warnings_flag_missing_stamp_and_rebate(self):
        rs = rate_set_from_dict({"code": "EMPTY"})
        joined = " ".join(rs.warnings())
        assert "印花税率" in joined
        assert "退税率" in joined

    def test_healthy_rate_set_is_quiet(self):
        rs = registry().get("CN-A")
        assert rs.warnings() == []


class TestHSLookup:
    def test_normalize_strips_non_digits(self):
        assert normalize_hs("7314.41.00.00") == "7314410000"
        assert normalize_hs(" 7314410000 ") == "7314410000"

    def test_lookup_by_hs(self):
        rs = registry().get("CN-A")
        assert rs.lookup_rebate("7314410000") == 0.13
        assert rs.lookup_rebate("7314.41.00.00") == 0.13

    def test_prefix_match_between_8_and_10_digit(self):
        rs = rate_set_from_dict(
            {"code": "P", "export_rebate": {"by_hs_code": {"73144100": 0.09}}}
        )
        assert rs.lookup_rebate("7314410000") == 0.09

    def test_unknown_hs_returns_none_not_guess(self):
        """档案只收录了部分编码时，未收录的要返回 None 而不是给个默认值。"""
        rs = registry().get("CN-A")
        assert rs.lookup_rebate("9999999999") is None

    def test_default_used_only_when_configured(self):
        rs = rate_set_from_dict(
            {"code": "D", "export_rebate": {"default": 0.05, "by_hs_code": {}}}
        )
        assert rs.lookup_rebate("9999999999") == 0.05


# ─────────────────────────────────────────────────────────────────────────────
# Provider
# ─────────────────────────────────────────────────────────────────────────────
class TestLocalLibraryProvider:
    async def test_hit(self):
        p = LocalLibraryProvider(registry().get("CN-A"))
        res = await p.lookup("7314410000")
        assert res.rebate_rate == 0.13
        assert res.source == "rate_set:CN-A"
        assert res.cached is False

    async def test_miss_raises_with_hs_in_message(self):
        p = LocalLibraryProvider(registry().get("CN-A"))
        with pytest.raises(RebateRateNotFound, match="9999999999"):
            await p.lookup("9999999999")

    async def test_null_in_table_is_a_miss_not_zero(self):
        """档案里把未确认的编码写成 null —— 必须当作查不到，不能当成 0% 退税。"""
        rs = rate_set_from_dict(
            {"code": "N", "export_rebate": {"by_hs_code": {"7314410000": None}}}
        )
        with pytest.raises(RebateRateNotFound):
            await LocalLibraryProvider(rs).lookup("7314410000")


class TestHttpRebateProvider:
    async def test_disabled_without_url(self):
        p = HttpRebateProvider("")
        assert p.enabled is False
        with pytest.raises(RebateRateNotFound, match="未启用"):
            await p.lookup("7314410000")

    async def test_parses_top_level_and_wrapped_payload(self, monkeypatch):
        p = HttpRebateProvider("https://example.invalid/rebate", api_key="k")

        for payload in (
            {"rebate_rate": 0.13, "source": "vendor"},
            {"data": {"rebate_rate": 0.13, "source": "vendor"}},
            {"data": {"rebateRate": 0.13}},
        ):
            res = await _lookup_with_fake(p, payload, monkeypatch=monkeypatch)
            assert res.rebate_rate == 0.13

    async def test_payload_without_rate_raises(self, monkeypatch):
        p = HttpRebateProvider("https://example.invalid/rebate")
        with pytest.raises(RebateRateNotFound, match="rebate_rate"):
            await _lookup_with_fake(p, {"foo": "bar"}, monkeypatch=monkeypatch)

    async def test_http_error_raises(self, monkeypatch):
        p = HttpRebateProvider("https://example.invalid/rebate")
        with pytest.raises(RebateRateNotFound, match="500"):
            await _lookup_with_fake(p, None, status=500, monkeypatch=monkeypatch)

    async def test_sends_configured_api_key(self, monkeypatch):
        """回归：鉴权头必须真的带上配置的 key（曾被写成占位串，导致静默 401）。"""
        p = HttpRebateProvider("https://example.invalid/rebate", api_key="s3cr3t")
        seen = {}
        await _lookup_with_fake(p, {"rebate_rate": 0.1}, capture=seen,
                                monkeypatch=monkeypatch)
        assert seen["headers"].get("Authorization") == "Bearer s3cr3t"


class _Resp:
    def __init__(self, payload, status=200):
        self.status_code = status
        self._payload = payload
        self.content = b"x" if payload is not None else b""
        self.text = str(payload)

    def json(self):
        return self._payload


async def _lookup_with_fake(p, payload, status=200, capture=None, monkeypatch=None):
    """打桩 retry_request，避免真实网络；请求参数仍会真实构造。"""
    import app.services.http_utils as http_utils

    resp = _Resp(payload, status)

    async def _retry(client, method, url, **kw):
        if capture is not None:
            capture.update({"method": method, "url": url, **kw})
        return resp

    monkeypatch.setattr(http_utils, "retry_request", _retry, raising=False)
    return await p.lookup("7314410000")


class TestCachedProvider:
    async def test_second_call_is_cached(self):
        calls = {"n": 0}

        class Inner:
            name = "inner"

            async def lookup(self, hs_code):
                calls["n"] += 1
                return RebateResult(hs_code, 0.13, "inner")

        p = CachedProvider(Inner(), ttl_seconds=3600)
        a = await p.lookup("7314410000")
        b = await p.lookup("7314410000")
        assert calls["n"] == 1
        assert a.cached is False and b.cached is True
        assert b.rebate_rate == 0.13

    async def test_negative_cache_avoids_repeated_failures(self):
        calls = {"n": 0}

        class Inner:
            name = "inner"

            async def lookup(self, hs_code):
                calls["n"] += 1
                raise RebateRateNotFound("nope")

        p = CachedProvider(Inner(), ttl_seconds=3600)
        for _ in range(3):
            with pytest.raises(RebateRateNotFound):
                await p.lookup("7314410000")
        assert calls["n"] == 1, "负缓存应拦住重复查询"

    async def test_expired_entry_refetches(self):
        calls = {"n": 0}

        class Inner:
            name = "inner"

            async def lookup(self, hs_code):
                calls["n"] += 1
                return RebateResult(hs_code, 0.13, "inner")

        p = CachedProvider(Inner(), ttl_seconds=0)
        await p.lookup("7314410000")
        await p.lookup("7314410000")
        assert calls["n"] == 2

    async def test_clear_resets_both_caches(self):
        class Inner:
            name = "inner"

            async def lookup(self, hs_code):
                return RebateResult(hs_code, 0.13, "inner")

        p = CachedProvider(Inner())
        await p.lookup("7314410000")
        p.clear()
        assert p._cache == {} and p._misses == {}


class TestChainProvider:
    async def test_falls_through_to_next(self):
        class Fail:
            name = "fail"

            async def lookup(self, hs_code):
                raise RebateRateNotFound("down")

        class Good:
            name = "good"

            async def lookup(self, hs_code):
                return RebateResult(hs_code, 0.09, "good")

        res = await ChainProvider([Fail(), Good()]).lookup("7314410000")
        assert res.source == "good"

    async def test_all_failed_raises_with_details(self):
        class Fail:
            name = "fail"

            async def lookup(self, hs_code):
                raise RebateRateNotFound("down")

        with pytest.raises(RebateRateNotFound, match="人工确认"):
            await ChainProvider([Fail(), Fail()]).lookup("7314410000")

    async def test_unexpected_exception_does_not_break_chain(self):
        """外部服务抛非预期异常时，仍要能走完兜底链。"""

        class Boom:
            name = "boom"

            async def lookup(self, hs_code):
                raise RuntimeError("connection reset")

        class Good:
            name = "good"

            async def lookup(self, hs_code):
                return RebateResult(hs_code, 0.1, "good")

        assert (await ChainProvider([Boom(), Good()]).lookup("7314410000")).source == "good"

    async def test_empty_chain_raises(self):
        with pytest.raises(RebateRateNotFound):
            await ChainProvider([]).lookup("7314410000")


class TestDefaultProviderFactory:
    def test_offline_when_no_api_configured(self):
        rs = registry().get("CN-A")
        p = build_default_provider(rs, api_url="", api_key="", ttl_seconds=60)
        # 未配置 API 时，HTTP 那一段不参与，只剩本地档案库
        assert provider_source_label(p) == "http → rate_set"
        assert provider_enabled(p) is True, "本地档案库仍可用"
        assert p.inner.providers[0].enabled is False
        assert provider_enabled(p.inner.providers[1]) is True

    def test_http_becomes_enabled_when_configured(self):
        rs = registry().get("CN-A")
        p = build_default_provider(
            rs, api_url="https://example.invalid/r", api_key="k", ttl_seconds=60
        )
        assert p.enabled is True

    async def test_local_only_still_serves_known_hs(self):
        rs = registry().get("CN-A")
        p = build_default_provider(rs, api_url="", api_key="", ttl_seconds=60)
        assert (await p.lookup("7314410000")).rebate_rate == 0.13

    async def test_unknown_hs_fails_closed_without_api(self):
        rs = registry().get("CN-A")
        p = build_default_provider(rs, api_url="", api_key="", ttl_seconds=60)
        with pytest.raises(RebateRateNotFound):
            await p.lookup("9999999999")


class TestProviderIntrospection:
    def test_labels(self):
        assert provider_source_label(LocalLibraryProvider(registry().get("CN-A"))) == "rate_set"
        assert provider_source_label(HttpRebateProvider("")) == "http"
        # 空链没有成员可拼，回落到类名，便于日志里辨认
        assert provider_source_label(ChainProvider([])) == "chain"

    def test_enabled_defaults_true_for_plain_providers(self):
        assert provider_enabled(LocalLibraryProvider(registry().get("CN-A"))) is True
        assert provider_enabled(ChainProvider([HttpRebateProvider("")])) is False


class TestRepoArchives:
    def test_every_archive_has_stamp(self):
        for rs in RateSetRegistry.from_dir().all():
            assert rs.stamp_duty.rate is not None, f"{rs.code} 缺印花税率"
            assert rs.stamp_duty.base == "profit", f"{rs.code} 印花税基数应为加工利润"

    def test_field_fence_hs_covered_or_explicitly_pending(self):
        """牛栏网 HS 编码要么有明确退税率，要么两份档案都留空等人工确认。

        留空是有意的：没有权威来源时宁可不报价，也不猜一个退税率。
        """
        reg = RateSetRegistry.from_dir()
        values = [rs.lookup_rebate("7314410000") for rs in reg.all()]
        assert all(v is None for v in values) or all(v is not None for v in values)


class TestRateSetFileDiscovery:
    """线上（Pyodide）没有目录列举能力时的兜底（2026-10-17 线上 500 事故）。"""

    def _write(self, tmp_path, code="CN-X"):
        (tmp_path / f"{code}.json").write_text(
            json.dumps({"code": code, "vat": {}}), encoding="utf-8"
        )
        (tmp_path / "_manifest.json").write_text(
            json.dumps([f"{code}.json"]), encoding="utf-8"
        )

    def test_from_dir_ignores_manifest_json(self, tmp_path):
        self._write(tmp_path)
        # 目录列举可用时，_manifest.json 不能被当成税务档案（否则 500）
        reg = RateSetRegistry.from_dir(tmp_path)
        assert reg.codes == ["CN-X"]

    def test_from_dir_falls_back_to_manifest(self, tmp_path, monkeypatch):
        self._write(tmp_path)
        original = pathlib.Path.iterdir

        def _no_listing(self, *args, **kwargs):
            raise NotImplementedError("no dir listing in pyodide")

        monkeypatch.setattr(pathlib.Path, "iterdir", _no_listing)
        try:
            reg = RateSetRegistry.from_dir(tmp_path)
        finally:
            monkeypatch.setattr(pathlib.Path, "iterdir", original)
        assert reg.codes == ["CN-X"]

    def test_from_dir_reports_clear_error_when_nothing_found(self, tmp_path):
        with pytest.raises(RateSetError):
            RateSetRegistry.from_dir(tmp_path)

    def test_from_dir_uses_embedded_when_no_files(self, tmp_path, monkeypatch):
        """数据文件没进 bundle 时，退回构建期内嵌的 Python 常量。"""
        import app.services.export_quote.rates as rates_module

        monkeypatch.setattr(
            rates_module,
            "_embedded_rate_sets",
            lambda: [{"code": "CN-E", "vat": {}}],
        )
        reg = RateSetRegistry.from_dir(tmp_path)
        assert reg.codes == ["CN-E"]
