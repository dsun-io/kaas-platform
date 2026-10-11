"""产品基础信息带入单据（行项 HS 编码）—— **纯单测**（无 DB、无 HTTP）。

`pytestmark = unit`：判定在共享内核 `kaas_common/trade_doc/product_defaults.py`，
两端只留取数壳，所以规则必须进 `-m unit` 门禁。

覆盖的语义：
1. 单据 `custom.product_key` 缺失 ⇒ 行为与旧版**逐字相同**（回归：data 一个键都不动）；
2. 产品不存在 / 档案没维护 / 档案里没有 `hs_code` ⇒ 完全不动 data（不塞空串、不猜）；
3. 单据类型没声明 HS 列（manifest + 渲染器 ITEM_COLUMNS）⇒ 不填；
4. 行项**已显式给过** `hs_code`（含空串 / None、含上游快照带出的）⇒ **不覆盖**；
5. 空着的行项 ⇒ 用产品档案的 HS 编码补上；数字型 HS 编码必须转字符串
   （否则会被渲染器按金额格式化：7314.41 → 7,314.41）。

两处契约守卫：
- `HS_ITEM_DOC_TYPES` 与 manifest 的 items 说明一致（改一端不改另一端会红）；
- **顶层字段一律不填**：拿全部 6 个产品信息键、遍历 manifest 的每个单据类型，
  断言 `apply_product_defaults` 绝不新增/改顶层键（这是保守口径的棘轮）。
"""
import copy
import json
from pathlib import Path

import pytest

from app.api import trade_docs as td
from kaas_common.trade_doc.product_defaults import (
    HS_ITEM_DOC_TYPES,
    PRODUCT_INFO_KEYS,
    PRODUCT_KEY_FIELD,
    apply_product_defaults,
    product_key_of,
)

pytestmark = pytest.mark.unit

MANIFEST = (
    Path(__file__).resolve().parents[3] / "frontend" / "src" / "lib" / "trade-doc" / "manifest.json"
)

INFO = {"material": "低碳钢丝", "surface": "热镀锌", "usage": "围栏",
        "hs_code": "7314.41.00", "packing": "编织袋 + 钢带", "origin": "河北安平"}


def _data(*items):
    return {"currency": "USD", "items": list(items)} if items else {"currency": "USD"}


def _custom(key="field_fence"):
    return {PRODUCT_KEY_FIELD: key} if key is not None else {}


# ─── product_key_of：什么算"显式关联" ───────────────────────────────────────

class TestProductKeyOf:
    def test_plain_key(self):
        assert product_key_of({"product_key": "field_fence"}) == "field_fence"

    def test_whitespace_stripped(self):
        assert product_key_of({"product_key": "  deer_net "}) == "deer_net"

    def test_missing_or_blank_is_none(self):
        assert product_key_of({}) is None
        assert product_key_of({"product_key": ""}) is None
        assert product_key_of({"product_key": "   "}) is None

    def test_non_string_is_none(self):
        """别的类型不是注册表里的 key —— 当"没关联"，不去做注定失败的查询。"""
        assert product_key_of({"product_key": 5}) is None
        assert product_key_of({"product_key": {"k": 1}}) is None

    def test_custom_not_dict(self):
        assert product_key_of(None) is None
        assert product_key_of(["product_key"]) is None


# ─── 回归：没关联产品 ⇒ 一个键都不动 ───────────────────────────────────────

class TestRegressionWithoutProductKey:
    @pytest.mark.parametrize("custom", [{}, None, ["product_key"], {"product_key": ""}])
    def test_data_untouched(self, custom):
        data = _data({"product_name": "勾花网"})
        before = copy.deepcopy(data)
        assert apply_product_defaults(data, custom, "ci", INFO) == before

    def test_no_top_level_or_item_key_added(self):
        data = _data({"product_name": "勾花网"})
        apply_product_defaults(data, {}, "ci", INFO)
        assert list(data) == ["currency", "items"]
        assert list(data["items"][0]) == ["product_name"]


# ─── 优先级：已给过的不覆盖（上游快照 > 产品基础信息）─────────────────────

class TestPriority:
    def test_upstream_item_hs_code_wins(self):
        data = _data({"product_name": "勾花网", "hs_code": "9999.99.99"})
        apply_product_defaults(data, _custom(), "ci", INFO)
        assert data["items"][0]["hs_code"] == "9999.99.99"

    def test_explicit_empty_string_is_not_overwritten(self):
        """空串也是"显式给过"——不许拿产品档案把它盖回去。"""
        data = _data({"product_name": "勾花网", "hs_code": ""})
        apply_product_defaults(data, _custom(), "ci", INFO)
        assert data["items"][0]["hs_code"] == ""

    def test_explicit_none_is_not_overwritten(self):
        data = _data({"product_name": "勾花网", "hs_code": None})
        apply_product_defaults(data, _custom(), "ci", INFO)
        assert data["items"][0]["hs_code"] is None

    def test_blank_items_are_filled(self):
        data = _data({"product_name": "勾花网"})
        apply_product_defaults(data, _custom(), "ci", INFO)
        assert data["items"][0]["hs_code"] == "7314.41.00"

    def test_only_blank_items_filled_in_a_mixed_doc(self):
        data = _data(
            {"product_name": "A", "hs_code": "1111.11.11"},
            {"product_name": "B"},
        )
        apply_product_defaults(data, _custom(), "ci", INFO)
        assert data["items"][0]["hs_code"] == "1111.11.11"
        assert data["items"][1]["hs_code"] == "7314.41.00"


# ─── 声明门禁：字段未声明 ⇒ 不填 ────────────────────────────────────────────

class TestDeclaredFieldsOnly:
    @pytest.mark.parametrize("doc_type", ["pi", "quotation", "pl", "contract", "bl", "other"])
    def test_doc_type_without_hs_column_is_untouched(self, doc_type):
        data = _data({"product_name": "勾花网"})
        before = copy.deepcopy(data)
        assert apply_product_defaults(data, _custom(), doc_type, INFO) == before

    @pytest.mark.parametrize("doc_type", HS_ITEM_DOC_TYPES)
    def test_doc_types_with_hs_column_are_filled(self, doc_type):
        data = _data({"product_name": "勾花网"})
        apply_product_defaults(data, _custom(), doc_type, INFO)
        assert data["items"][0]["hs_code"] == "7314.41.00"

    def test_no_items_means_nothing_to_fill(self):
        data = {"currency": "USD"}
        assert apply_product_defaults(data, _custom(), "ci", INFO) == {"currency": "USD"}

    def test_empty_items_list(self):
        data = {"currency": "USD", "items": []}
        assert apply_product_defaults(data, _custom(), "ci", INFO) == {
            "currency": "USD", "items": []}

    def test_items_not_a_list(self):
        data = {"currency": "USD", "items": {"product_name": "x"}}
        assert apply_product_defaults(data, _custom(), "ci", INFO) == {
            "currency": "USD", "items": {"product_name": "x"}}

    def test_non_dict_item_entries_are_skipped(self):
        data = {"currency": "USD", "items": ["?", None, {"product_name": "ok"}]}
        apply_product_defaults(data, _custom(), "ci", INFO)
        assert data["items"][0] == "?"
        assert data["items"][1] is None
        assert data["items"][2]["hs_code"] == "7314.41.00"


# ─── 空值处理：没有可用信息 ⇒ 不动 data ─────────────────────────────────────

class TestMissingProductInfo:
    @pytest.mark.parametrize("info", [None, {}, [], "info", 0])
    def test_no_info_untouched(self, info):
        data = _data({"product_name": "勾花网"})
        before = copy.deepcopy(data)
        assert apply_product_defaults(data, _custom(), "ci", info) == before

    def test_info_without_hs_code(self):
        data = _data({"product_name": "勾花网"})
        before = copy.deepcopy(data)
        assert apply_product_defaults(data, _custom(), "ci", {"material": "低碳钢丝"}) == before

    @pytest.mark.parametrize("blank", ["", "   ", None, {"a": 1}, ["7314"]])
    def test_blank_or_non_scalar_hs_code_is_not_written(self, blank):
        """空串/空白/容器一律当"没有"——不塞空串，也不把对象写进单据。"""
        data = _data({"product_name": "勾花网"})
        before = copy.deepcopy(data)
        assert apply_product_defaults(data, _custom(), "ci", {"hs_code": blank}) == before

    def test_numeric_hs_code_becomes_text(self):
        """数字型 HS 编码必须转字符串，否则渲染器会按金额格式化（7314.41）。"""
        data = _data({"product_name": "勾花网"})
        apply_product_defaults(data, _custom(), "ci", {"hs_code": 7314410000})
        assert data["items"][0]["hs_code"] == "7314410000"

    def test_hs_code_whitespace_trimmed(self):
        data = _data({"product_name": "勾花网"})
        apply_product_defaults(data, _custom(), "ci", {"hs_code": "  7314.41.00  "})
        assert data["items"][0]["hs_code"] == "7314.41.00"

    def test_other_data_fields_preserved(self):
        data = {"currency": "USD", "total_amount": 12.5, "items": [{"product_name": "勾花网"}]}
        apply_product_defaults(data, _custom(), "ci", INFO)
        assert data["currency"] == "USD"
        assert data["total_amount"] == 12.5
        assert data["items"][0]["product_name"] == "勾花网"


# ─── 契约守卫 ───────────────────────────────────────────────────────────────

def _manifest():
    if not MANIFEST.exists():                       # 只 checkout 后端的环境：跳过而非误报
        pytest.skip(f"manifest 不在本检出中: {MANIFEST}")
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


class TestManifestContract:
    def test_hs_doc_types_match_manifest_items_description(self):
        """`HS_ITEM_DOC_TYPES` 必须与 manifest 里 items 说明写了「HS编码」的类型一致。

        这是"字段确实声明了"这件事的唯一可执行依据：内核清单与 manifest 漂移会红。
        """
        manifest = _manifest()
        declared = {
            doc_type
            for doc_type, spec in manifest.items()
            if "HS编码" in ((spec.get("fields", {}).get("items") or {}).get("description") or "")
        }
        assert declared == set(HS_ITEM_DOC_TYPES)

    def test_no_top_level_field_filled_for_any_doc_type(self):
        """棘轮：**顶层字段一律不填**（当前 manifest 没有与产品基础信息同名的顶层字段）。

        拿全部 6 个信息键、遍历 manifest 的每个单据类型：data 的顶层键集合必须一动不动。
        以后若 manifest 真的新增了同名字段（该功能才谈得上启用），这条会红 ——
        那时要**有意识地**把映射补进 product_defaults，而不是让症状（模板空白）悄悄存在。
        """
        manifest = _manifest()
        info = {key: f"值-{key}" for key in PRODUCT_INFO_KEYS}
        for doc_type in manifest:
            data = {"currency": "USD", "items": [{"product_name": "x"}]}
            apply_product_defaults(data, _custom(), doc_type, info)
            assert set(data) == {"currency", "items"}, doc_type


# ─── 取数壳（异步、假 DB，不连库）───────────────────────────────────────────

class _FakeMappings:
    def __init__(self, row):
        self._row = row

    def first(self):
        return self._row


class _FakeResult:
    def __init__(self, row):
        self._row = row

    def mappings(self):
        return _FakeMappings(self._row)


class _FakeDB:
    def __init__(self, row=None):
        self.row = row
        self.calls: list[tuple[str, dict]] = []

    async def execute(self, stmt, params=None):
        self.calls.append((str(stmt), params or {}))
        return _FakeResult(self.row)


class TestApplyProductDefaultsShell:
    """壳层只管取数：没关联产品不查库、产品不在注册表不查库、查到的 info 交给内核判定。"""

    async def test_no_product_key_skips_query(self):
        fake = _FakeDB({"info": {"hs_code": "7314.41.00"}})
        data = {"currency": "USD", "items": [{"product_name": "x"}]}
        out = await td._apply_product_defaults(fake, "lianjia", "ci", data, {})
        assert out == data
        assert fake.calls == []                     # 一次查询都不发（回归旧行为）
        assert "hs_code" not in data["items"][0]

    async def test_unknown_product_skips_query(self):
        fake = _FakeDB({"info": {"hs_code": "7314.41.00"}})
        data = {"currency": "USD", "items": [{"product_name": "x"}]}
        await td._apply_product_defaults(
            fake, "lianjia", "ci", data, {"product_key": "no_such_product_xyz"})
        assert fake.calls == []                     # 不在注册表 → 直接放弃
        assert "hs_code" not in data["items"][0]

    async def test_known_product_queries_and_fills(self):
        fake = _FakeDB({"info": {"hs_code": "7314.41.00"}})
        data = {"currency": "USD", "items": [{"product_name": "x"}]}
        await td._apply_product_defaults(fake, "lianjia", "ci", data, _custom("field_fence"))
        assert data["items"][0]["hs_code"] == "7314.41.00"
        (sql, params), = fake.calls
        assert "product_profiles" in sql
        assert params == {"t": "lianjia", "k": "field_fence"}

    async def test_profile_row_without_dict_info_is_ignored(self):
        fake = _FakeDB({"info": "[1,2,3]"})         # 形状不对的历史数据不该炸装配链
        data = {"currency": "USD", "items": [{"product_name": "x"}]}
        before = copy.deepcopy(data)
        assert await td._apply_product_defaults(
            fake, "lianjia", "ci", data, _custom("field_fence")) == before

    async def test_no_profile_row_is_ignored(self):
        fake = _FakeDB(None)                        # 注册表里有产品，但没维护过档案
        data = {"currency": "USD", "items": [{"product_name": "x"}]}
        before = copy.deepcopy(data)
        assert await td._apply_product_defaults(
            fake, "lianjia", "ci", data, _custom("field_fence")) == before
        assert len(fake.calls) == 1

    async def test_json_text_info_is_decoded(self):
        """jsonb 以文本回来（Worker 侧 asyncpg 的典型形状）时也要能用。"""
        fake = _FakeDB({"info": '{"hs_code": "7314.41.00"}'})
        data = {"currency": "USD", "items": [{"product_name": "x"}]}
        await td._apply_product_defaults(fake, "lianjia", "ci", data, _custom("field_fence"))
        assert data["items"][0]["hs_code"] == "7314.41.00"

    async def test_broken_json_text_info_is_ignored(self):
        fake = _FakeDB({"info": "{not json"})
        data = {"currency": "USD", "items": [{"product_name": "x"}]}
        before = copy.deepcopy(data)
        assert await td._apply_product_defaults(
            fake, "lianjia", "ci", data, _custom("field_fence")) == before
