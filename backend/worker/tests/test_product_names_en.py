"""产品英文名（多值 / 主名 / 系统产品可改）—— 2026-10-24 验收回归。

用户诉求（生产验收）
====================
1. 产品基本信息里英文名改完**必须真落库**（旧版：界面能改，请求体里根本没有英文名）；
2. 鹿网 / 牛栏网这类**代码注册表系统产品**也要能改英文名（生产 `tenant_products`
   只有团队自定义的两行，系统产品没有 DB 行）；
3. 一个产品支持**多个英文名**（不同地区叫法不同），第一个是主英文名；
   报价 / 订单 / 单证自动用主名。

本文件钉死三层口径
==================
- **归一化**（共享内核 `export_quote/product_names.py`）：主名在前、去重、空值丢弃、
  历史单值 `name_en` 兼容（旧数据不能当成"没配"）。
- **写/读**（`ws_files.put_profile` / `list_products` / `get_profile`）：
  PUT 落 `name_en_list` + `name_en_primary`，并同步 `tenant_products.product_name_en`
  （既有读侧字段）；`/products` 回主名 + 地区别名。
- **下游消费**（`quote_api._quotable_specs`）：/export-quote/products 的 `name_en`
  用主名覆盖，报价行 `product_name = name_en || name` 才拿得到用户改的名字。

风格照 `test_ws_files_team_scope.py`：假库直连端点 + TestClient 走 HTTP，不碰 Hyperdrive。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import ws_files  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from kaas_common.export_quote.product_names import (  # noqa: E402
    apply_name_en_info,
    name_en_list_from_info,
    normalize_names,
    normalized_info,
    primary_name_en_from_info,
)

client = TestClient(worker_main.app, raise_server_exceptions=True)

TEAM = 2
OTHER_TEAM = 9


def _user(role: str = "owner", team_id=TEAM) -> dict:
    return {
        "id": 11, "email": "u11@kaas.local", "display_name": "用户11",
        "account_type": "customer", "role": role, "status": "active",
        "team_id": team_id,
    }


# ── 假库：只实现产品资料这几条 SQL（其余表回空）──────────────────────────────

class _FakeDb:
    """`product_profiles` 行存在内存里；`tenant_products` 只记录被同步的参数。

    行里带 `team_id`（与真表一致），这样 visibility 用例可以按真实形状断言。
    """

    def __init__(self, profiles=None):
        #: product_key -> {"info": dict, "team_id": int | None}
        self.profiles: dict[str, dict] = dict(profiles or {})
        self.tenant_product_updates: list[tuple] = []
        self.calls: list[tuple[str, tuple, object]] = []

    async def fetchrow(self, request, sql, *args, table=None):
        self.calls.append((sql, args, table))
        if "FROM product_profiles" in sql:
            key = args[1]
            row = self.profiles.get(key)
            if row is None:
                return None
            return {
                "product_key": key,
                "info": row["info"],
                "updated_at": None,
                "team_id": row.get("team_id"),
            }
        return None

    async def fetch(self, request, sql, *args, table=None):
        self.calls.append((sql, args, table))
        if "FROM file_objects" in sql:
            return []
        if "FROM product_profiles" in sql:
            return [
                {"product_key": key, "info": row["info"], "team_id": row.get("team_id")}
                for key, row in self.profiles.items()
            ]
        return []

    async def execute(self, request, sql, *args, **kwargs):
        self.calls.append((sql, args, kwargs.get("table")))
        if "INSERT INTO product_profiles" in sql:
            _tenant, team_id, product_key, raw_info = args[0], args[1], args[2], args[3]
            self.profiles[product_key] = {
                "info": json.loads(raw_info), "team_id": team_id,
            }
        elif "UPDATE tenant_products" in sql:
            self.tenant_product_updates.append(args)
        return "OK"


def _install(monkeypatch, db):
    """把 main.db 对象上的三个方法换成假库。

    注意：`ws_files.db` 与 `quote_api._db` 都是 `main.db` 这**同一个对象**的别名
    （导入期快照），所以必须 patch 对象上的方法 —— 替换模块名 `main.db` 不会改到别名
    （踩过：只换名字 ⇒ 端点仍然走 Hyperdrive 报 KeyError 'env'）。
    """
    for name in ("fetch", "fetchrow", "execute"):
        monkeypatch.setattr(worker_main.db, name, getattr(db, name))
    return db


def _as(user):
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user


def _clear():
    worker_main.app.dependency_overrides.clear()


def _put_profile(key, info, user=None):
    _as(user or _user())
    try:
        return client.put(f"/api/v1/products/{key}/profile", json={"info": info})
    finally:
        _clear()


def _products(user=None):
    _as(user or _user())
    try:
        return client.get("/api/v1/products")
    finally:
        _clear()


# ════════════════════════════════════════════════════════════════════════════
# 1. 归一化（共享内核，纯函数）
# ════════════════════════════════════════════════════════════════════════════

class TestNormalize:
    def test_去空白_丢空串_大小写不敏感去重且保留首次写法(self):
        assert normalize_names([" Chain Link ", "chain link", "", "  ", None]) == [
            "Chain Link"]
        assert normalize_names("Deer Net") == ["Deer Net"]
        assert normalize_names(None) == []
        assert normalize_names({"not": "a list"}) == []

    def test_只有列表时主名取第一个(self):
        info = {"name_en_list": ["Cattle Fence", "Field Fence EU"]}
        assert primary_name_en_from_info(info) == "Cattle Fence"
        assert name_en_list_from_info(info) == ["Cattle Fence", "Field Fence EU"]

    def test_只写主名时插到最前(self):
        info = {"name_en_primary": "Pasture Fence", "name_en_list": ["Cattle Fence"]}
        assert name_en_list_from_info(info) == ["Pasture Fence", "Cattle Fence"]

    def test_主名在列表里时挪到最前并去重复(self):
        info = {
            "name_en_list": ["Field Fence EU", "Field Fence", "Cattle Fence"],
            "name_en_primary": "cattle fence",  # 大小写不同也算同一个名字
        }
        assert name_en_list_from_info(info) == [
            "Cattle Fence", "Field Fence EU", "Field Fence"]
        # 不允许出现大小写不同的两条同名
        assert len(name_en_list_from_info(info)) == 3

    def test_历史单值name_en当成唯一英文名_不能当成没配(self):
        info = {"name_en": " Deer Net "}
        assert name_en_list_from_info(info) == ["Deer Net"]
        assert primary_name_en_from_info(info) == "Deer Net"
        # 读投影会补出规范形状，但其它键原样保留
        out = normalized_info({**info, "usage": "围栏"})
        assert out["name_en_list"] == ["Deer Net"]
        assert out["name_en_primary"] == "Deer Net"
        assert out["usage"] == "围栏"

    def test_apply_保留其它键_历史单值跟随主名_清空后两键一致(self):
        info = {"usage": "围栏", "name_en": "Old Name"}
        out = apply_name_en_info(
            info, names=["New One", "New Two"], primary="New Two")
        assert out["name_en_list"] == ["New Two", "New One"]
        assert out["name_en_primary"] == "New Two"
        assert out["usage"] == "围栏"
        assert out["name_en"] == "New Two"  # 历史单值读者不能看到旧名

        cleared = apply_name_en_info({}, names=[])
        assert cleared == {"name_en_list": [], "name_en_primary": ""}

    def test_没配英文名时读投影一个键都不加(self):
        """旧响应必须逐字不变（product_profiles 里只有用途/产地）。"""
        assert normalized_info({"usage": "围栏"}) == {"usage": "围栏"}
        assert normalized_info(None) == {}
        assert normalized_info("not a dict") == {}


# ════════════════════════════════════════════════════════════════════════════
# 2. 写：PUT /products/{key}/profile 真落库 + 同步 tenant_products
# ════════════════════════════════════════════════════════════════════════════

class TestPutProfile:
    def test_系统产品改英文名真落库_且回读主名在前(self, monkeypatch):
        db = _install(monkeypatch, _FakeDb())
        resp = _put_profile("deer_net", {
            "name_en_list": ["Deer Fence EU", "Deer Net", ""],
            "usage": "果园围栏",
        })
        assert resp.status_code == 200, resp.text
        info = resp.json()["info"]
        assert info["name_en_list"] == ["Deer Fence EU", "Deer Net"]
        assert info["name_en_primary"] == "Deer Fence EU"
        assert info["usage"] == "果园围栏"
        # 落库值就是归一化值（不是前端原样搬运的脏数据）
        assert db.profiles["deer_net"]["info"] == {
            "name_en_list": ["Deer Fence EU", "Deer Net"],
            "name_en_primary": "Deer Fence EU",
            "usage": "果园围栏",
        }
        # 系统产品在 tenant_products 没有行 ⇒ 不会 INSERT；只做一次无害的 UPDATE 同步
        assert "INSERT INTO tenant_products" not in "\n".join(
            sql for sql, _args, _t in db.calls)
        assert db.tenant_product_updates[-1][0] == "Deer Fence EU"

    def test_主名可切换_第二个变主名后顺序与同步都跟着变(self, monkeypatch):
        db = _install(monkeypatch, _FakeDb())
        _put_profile("field_fence", {"name_en_list": ["Field Fence EU", "Cattle Fence"]})
        resp = _put_profile("field_fence", {
            "name_en_list": ["Field Fence EU", "Cattle Fence"],
            "name_en_primary": "Cattle Fence",
        })
        assert resp.status_code == 200
        assert resp.json()["info"]["name_en_list"] == ["Cattle Fence", "Field Fence EU"]
        assert db.profiles["field_fence"]["info"]["name_en_primary"] == "Cattle Fence"
        assert db.tenant_product_updates[-1][0] == "Cattle Fence"

    def test_没有英文名时不写tenant_products(self, monkeypatch):
        db = _install(monkeypatch, _FakeDb())
        resp = _put_profile("field_fence", {"usage": "边坡防护"})
        assert resp.status_code == 200
        assert resp.json()["info"] == {"usage": "边坡防护"}
        assert db.tenant_product_updates == []

    def test_同步UPDATE带团队谓词(self, monkeypatch):
        db = _install(monkeypatch, _FakeDb())
        _put_profile("chain_link", {"name_en_list": ["Chain Link Fence"]},
                     user=_user(team_id=OTHER_TEAM))
        args = db.tenant_product_updates[-1]
        # (primary, tenant_id, product_key, team_id) —— team 必须来自**调用者**，不能猜
        assert args[0] == "Chain Link Fence"
        assert args[-1] == OTHER_TEAM
        sql = next(sql for sql, _a, _t in db.calls if "UPDATE tenant_products" in sql)
        assert "team_id IS NOT DISTINCT FROM" in sql


# ════════════════════════════════════════════════════════════════════════════
# 3. 读：GET /products 回主名 + 地区别名
# ════════════════════════════════════════════════════════════════════════════

class TestListProducts:
    def test_改过英文名的产品回主名与别名_没改的回落注册表(self, monkeypatch):
        _install(monkeypatch, _FakeDb({
            "deer_net": {"info": {
                "name_en_list": ["Deer Fence EU", "Deer Net"],
                "name_en_primary": "Deer Fence EU",
            }, "team_id": TEAM},
        }))
        body = _products().json()
        by_key = {p["product_key"]: p for p in body["items"]}
        deer = by_key["deer_net"]
        assert deer["name_en"] == "Deer Fence EU"
        assert deer["name_en_aliases"] == ["Deer Net"]
        assert deer["name_en_list"] == ["Deer Fence EU", "Deer Net"]
        # 没配团队资料的产品：注册表英文名原样（旧口径不变）
        fence = by_key["field_fence"]
        assert fence["name_en"] == "Field Fence"
        assert fence["name_en_aliases"] == []
        assert fence["name_en_list"] == ["Field Fence"]

    def test_历史单值name_en也能被列表读到(self, monkeypatch):
        _install(monkeypatch, _FakeDb({
            "field_fence": {"info": {"name_en": "Cattle Fence"}, "team_id": TEAM},
        }))
        by_key = {p["product_key"]: p for p in _products().json()["items"]}
        assert by_key["field_fence"]["name_en"] == "Cattle Fence"
        assert by_key["field_fence"]["name_en_aliases"] == []

    def test_产品资料查询带团队谓词(self, monkeypatch):
        db = _install(monkeypatch, _FakeDb())
        _products(user=_user(team_id=OTHER_TEAM))
        sql, args, _table = next(
            c for c in db.calls if "FROM product_profiles" in c[0])
        assert "team_id=$2" in sql, sql
        assert OTHER_TEAM in args

    def test_管理员不加团队谓词(self, monkeypatch):
        db = _install(monkeypatch, _FakeDb())
        _products(user=_user(role="system_admin", team_id=None))
        sql, _args, _table = next(
            c for c in db.calls if "FROM product_profiles" in c[0])
        assert "team_id=" not in sql, sql


# ════════════════════════════════════════════════════════════════════════════
# 4. 下游：/export-quote/products 用主英文名（报价/订单/单证才拿得到）
# ════════════════════════════════════════════════════════════════════════════

class TestQuoteProductsPrimaryName:
    def _quote_products(self, monkeypatch, profiles, user=None):
        _install(monkeypatch, _FakeDb(profiles))
        _as(user or _user())
        try:
            return client.get("/api/v1/export-quote/products")
        finally:
            _clear()

    def test_主英文名覆盖注册表name_en(self, monkeypatch):
        resp = self._quote_products(monkeypatch, {
            "field_fence": {"info": {
                "name_en_list": ["Cattle Fence", "Field Fence EU"],
            }, "team_id": TEAM},
        })
        assert resp.status_code == 200, resp.text
        by_key = {p["key"]: p for p in resp.json()["products"]}
        assert by_key["field_fence"]["name_en"] == "Cattle Fence"
        # 其余英文名（不含主名）一并回给前端/导入解析 —— 任何一个都要能匹配到产品
        assert by_key["field_fence"]["name_en_aliases"] == ["Field Fence EU"]
        # 没配的产品原样（注册表英文名，没有别名 = 空表，不是缺键）
        assert by_key["deer_net"]["name_en"] == "Deer Net"
        assert by_key["deer_net"]["name_en_aliases"] == []

    def test_响应键集只多name_en_aliases(self, monkeypatch):
        """键集 = 原 12 键 + name_en_aliases（可选字段，不改已有必填项）。"""
        resp = self._quote_products(monkeypatch, {
            "field_fence": {"info": {"name_en_list": ["Cattle Fence"]},
                            "team_id": TEAM},
        })
        assert set(resp.json()["products"][0]) == {
            "key", "name", "name_en", "name_en_aliases", "category_code",
            "combo_count", "spec_summary", "hs_codes", "cost_basis",
            "cost_unit", "params", "metric_count", "invariant_count",
        }

    def test_普通成员查资料带团队谓词_管理员不带(self, monkeypatch):
        db = _install(monkeypatch, _FakeDb())
        _as(_user(team_id=OTHER_TEAM))
        try:
            client.get("/api/v1/export-quote/products")
        finally:
            _clear()
        sql, args, _table = next(c for c in db.calls if "FROM product_profiles" in c[0])
        assert "team_id=$2" in sql
        assert OTHER_TEAM in args

        db2 = _FakeDb()
        for name in ("fetch", "fetchrow", "execute"):
            monkeypatch.setattr(worker_main.db, name, getattr(db2, name))
        _as(_user(role="system_admin", team_id=None))
        try:
            client.get("/api/v1/export-quote/products")
        finally:
            _clear()
        sql2 = next(c for c in db2.calls if "FROM product_profiles" in c[0])[0]
        assert "team_id=" not in sql2, sql2


# ════════════════════════════════════════════════════════════════════════════
# 5. 共享内核模型：ProductSpec.name_en_aliases 是**可选**字段（旧 spec dict 照常加载）
# ════════════════════════════════════════════════════════════════════════════

class TestProductSpecEnglishAliases:
    def test_默认空表_旧spec_dict缺键也能加载(self):
        from kaas_common.export_quote.models import ProductSpec
        from kaas_common.export_quote.tenant_products import spec_from_dict
        from kaas_common.export_quote.tenant_products import spec_to_dict

        assert ProductSpec(key="x").name_en_aliases == []

        old_dict = {"key": "field_fence", "name": "牛栏网", "name_en": "Field Fence"}
        spec = spec_from_dict(old_dict)
        assert spec.name_en_aliases == []
        # 回环也不炸（新键只是多一个空列表，旧读者忽略即可）
        assert spec_from_dict(spec_to_dict(spec)).name_en_aliases == []

    def test_别名随spec_dict加载并回环(self):
        from kaas_common.export_quote.tenant_products import spec_from_dict
        from kaas_common.export_quote.tenant_products import spec_to_dict

        spec = spec_from_dict({
            "key": "field_fence", "name": "牛栏网", "name_en": "Cattle Fence",
            "name_en_aliases": ["Field Fence", "Pasture Fence"],
        })
        assert spec.name_en_aliases == ["Field Fence", "Pasture Fence"]
        assert spec_to_dict(spec)["name_en_aliases"] == [
            "Field Fence", "Pasture Fence"]
