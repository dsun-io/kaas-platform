"""默认公章自动带入单据渲染 —— **纯单测**（无 DB、无 HTTP）。

`pytestmark = unit`：这是装配层纯函数的回归，必须进 `-m unit` 门禁 ——
否则"章存了但单据不带出来"这个 bug 只有连库的全量跑才看得见。

判定本身在**共享内核** `kaas_common/files/seal.py`（G1：两端一份，Worker 侧靠
`scripts/sync-shared.ps1` 镜像同一份文件），所以这里既测内核函数对象，
也守卫"端点没有偷偷留本地副本"。

覆盖的语义（orchestrator 与 Worker 逐条一致）：
1. 单据 `custom` **显式含** `company_stamp` 键（哪怕是空串）⇒ 以它为准，绝不覆盖；
2. 没给 ⇒ 租户默认公章（`tenant_company_seals.png_bytes` + `is_default`）转 data URI；
3. 没有默认章 / 章字节为空 ⇒ 原样返回（不伪造空图，渲染器本来就不盖章位）。

**没被本文件覆盖的部分**（见回报）：真正落到 PostgreSQL 的取默认章查询
（`.is_default IS true` 的过滤、部分唯一索引下的唯一性）、HTTP 端点端到端接线，
以及 **Worker 侧的取数壳**（`main._apply_default_seal` 的 `db.fetchrow` 分支）——
worker 测试目录里没有可挂载的 kernel 测试文件（写范围也未包含），
需要连库/worker 侧用例才能验证。
"""
import base64

import pytest

from app.api import trade_docs as td
from kaas_common.files import SEAL_FIELD, apply_default_seal, seal_data_uri, seal_field

pytestmark = pytest.mark.unit

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _seal_row(png_bytes=PNG_MAGIC + b"fake-body", mime="image/png", **over):
    row = {"id": 7, "name": "公章", "mime": mime, "png_bytes": png_bytes,
           "is_default": True, "tenant_id": "default"}
    row.update(over)
    return row


class _OrmLike:
    """模拟 SQLAlchemy ORM 实例：只走属性，不支持下标。"""

    def __init__(self, **kw):
        for key, value in kw.items():
            setattr(self, key, value)


class _FakeResult:
    def __init__(self, row):
        self._row = row

    def scalars(self):
        return self

    def first(self):
        return self._row


class _FakeDB:
    """记录下发过的 SQL（编译成字面量），并回一个固定行。"""

    def __init__(self, row=None):
        self.row = row
        self.calls: list[str] = []

    async def execute(self, stmt):
        try:
            self.calls.append(str(stmt.compile(compile_kwargs={"literal_binds": True})))
        except Exception:                       # pragma: no cover - 兜底不掩盖断言
            self.calls.append(str(stmt))
        return _FakeResult(self.row)


# ─── 共享内核单一真源（G1 守卫）──────────────────────────────────────────────

class TestKernelSingleSource:
    def test_orchestrator_reuses_the_kernel_function(self):
        """orchestrator 用的是**内核那个函数对象**，不是本地副本。"""
        assert td.apply_default_seal is apply_default_seal

    def test_orchestrator_has_no_local_pure_copy(self):
        """本地副本已删除：纯函数不应再挂在端点模块上（重新加回来就红）。"""
        assert not hasattr(td, "seal_data_uri")
        assert not hasattr(td, "_seal_field")

    def test_stamp_field_name_is_fixed_by_kernel(self):
        assert SEAL_FIELD == "company_stamp"
        out = apply_default_seal({}, {}, _seal_row(PNG_MAGIC + b"field"))
        assert list(out) == [SEAL_FIELD]


# ─── seal_field：取列兼容性（纯函数）────────────────────────────────────────

class TestSealField:
    def test_dict_row(self):
        assert seal_field({"png_bytes": b"x"}, "png_bytes") == b"x"

    def test_orm_like_row_uses_attributes(self):
        assert seal_field(_OrmLike(png_bytes=b"y"), "png_bytes") == b"y"

    def test_none_row_returns_none(self):
        assert seal_field(None, "png_bytes") is None

    def test_missing_key_returns_none(self):
        assert seal_field({}, "png_bytes") is None


# ─── seal_data_uri：公章行 → data URI（纯函数）───────────────────────────────

class TestSealDataUri:
    def test_dict_row_round_trips_bytes(self):
        uri = seal_data_uri(_seal_row(PNG_MAGIC + b"body-123"))
        assert uri is not None
        prefix, _, payload = uri.partition(",")
        assert prefix == "data:image/png;base64"
        assert base64.b64decode(payload) == PNG_MAGIC + b"body-123"

    def test_mime_falls_back_to_png_when_missing(self):
        row = _seal_row()
        row.pop("mime")
        assert seal_data_uri(row).startswith("data:image/png;base64,")

    def test_mime_is_honored_when_stored(self):
        assert seal_data_uri(_seal_row(mime="image/jpeg")).startswith(
            "data:image/jpeg;base64,")

    def test_memoryview_bytes_work(self):
        """asyncpg 的 bytea 往往回 memoryview（Worker 侧同款输入）。"""
        uri = seal_data_uri(_seal_row(memoryview(PNG_MAGIC + b"mv")))
        assert base64.b64decode(uri.partition(",")[2]) == PNG_MAGIC + b"mv"

    def test_orm_like_row_uses_attributes(self):
        uri = seal_data_uri(_OrmLike(png_bytes=PNG_MAGIC + b"orm", mime="image/png"))
        assert base64.b64decode(uri.partition(",")[2]) == PNG_MAGIC + b"orm"

    def test_row_none_returns_none(self):
        assert seal_data_uri(None) is None

    def test_empty_bytes_returns_none(self):
        """没有默认章（空字节）→ None，不能伪造一张空图。"""
        assert seal_data_uri(_seal_row(b"")) is None

    def test_missing_png_column_returns_none(self):
        assert seal_data_uri({"id": 3, "mime": "image/png"}) is None


# ─── apply_default_seal：覆盖优先级（纯函数）────────────────────────────────

class TestApplyDefaultSeal:
    def test_explicit_custom_wins_over_default_seal(self):
        data = {"currency": "USD", "company_stamp": "data:image/png;base64,USER"}
        out = apply_default_seal(dict(data), {"company_stamp": "data:image/png;base64,USER"},
                                 _seal_row())
        assert out["company_stamp"] == "data:image/png;base64,USER"

    def test_explicit_empty_string_is_respected(self):
        """显式空串也是"用户说了算"——不能拿默认章把它盖回去。"""
        data = {"company_stamp": ""}
        out = apply_default_seal(dict(data), {"company_stamp": ""}, _seal_row())
        assert out["company_stamp"] == ""

    def test_explicit_key_wins_even_when_seal_image_empty(self):
        data = {"company_stamp": "https://cdn.example.com/seal.png"}
        out = apply_default_seal(dict(data), {"company_stamp": "https://cdn.example.com/seal.png"},
                                 _seal_row(b""))
        assert out["company_stamp"] == "https://cdn.example.com/seal.png"

    def test_explicit_custom_with_unmerged_data_does_not_inject_default(self):
        """调用顺序异常（custom 有值但没合并进 data）→ 也**不塞**默认章。

        纯函数只负责"不覆盖"；把 custom 合并进 data 是 `build_render_data` 的职责
        （真实管线上 data 里一定已有该键）。这里钉住契约，避免以后顺手改成"合并"。
        """
        assert apply_default_seal({}, {"company_stamp": "data:image/png;base64,USER"},
                                  _seal_row()) == {}

    def test_missing_key_uses_default_seal(self):
        out = apply_default_seal({}, {"subject": "PI"}, _seal_row(PNG_MAGIC + b"def"))
        assert base64.b64decode(out["company_stamp"].partition(",")[2]) == PNG_MAGIC + b"def"

    def test_custom_none_uses_default_seal(self):
        out = apply_default_seal({}, None, _seal_row(PNG_MAGIC + b"none"))
        assert out["company_stamp"].startswith("data:image/png;base64,")

    def test_non_dict_custom_is_treated_as_absent(self):
        """历史脏数据（custom 不是对象）不该让整条装配链炸掉。"""
        out = apply_default_seal({}, ["company_stamp"], _seal_row(PNG_MAGIC + b"list"))
        assert out["company_stamp"].startswith("data:image/png;base64,")

    def test_no_seal_row_keeps_data_untouched(self):
        data = {"currency": "USD"}
        assert apply_default_seal(data, {}, None) == {"currency": "USD"}
        assert "company_stamp" not in data

    def test_empty_seal_bytes_keeps_data_untouched(self):
        data = {"currency": "USD"}
        assert apply_default_seal(data, {}, _seal_row(b"")) == {"currency": "USD"}
        assert "company_stamp" not in data

    def test_other_fields_are_preserved(self):
        data = {"currency": "USD", "seller": {"company": "ACME"}}
        out = apply_default_seal(data, {}, _seal_row(PNG_MAGIC + b"keep"))
        assert out["currency"] == "USD"
        assert out["seller"] == {"company": "ACME"}


# ─── _apply_default_seal：装配层接线（异步、假 DB，不连库）───────────────────

class TestApplyDefaultSealWithDb:
    async def test_explicit_stamp_skips_query(self):
        fake = _FakeDB(_seal_row())
        data = {"company_stamp": "data:image/png;base64,USER"}
        out = await td._apply_default_seal(fake, "lianjia", data, {"company_stamp": "x"})
        assert out["company_stamp"] == "data:image/png;base64,USER"
        assert fake.calls == []                 # 显式给了就不查库

    async def test_query_filters_tenant_and_default_flag(self):
        fake = _FakeDB(_seal_row(PNG_MAGIC + b"row"))
        out = await td._apply_default_seal(fake, "lianjia", {}, {})
        assert base64.b64decode(out["company_stamp"].partition(",")[2]) == PNG_MAGIC + b"row"
        (sql,) = fake.calls
        assert "tenant_company_seals" in sql     # 表名以 company_seals.py 为准
        assert "is_default IS true" in sql       # 只认默认章
        assert "'lianjia'" in sql                # 租户过滤（不取别家的章）

    async def test_no_default_row_keeps_data_untouched(self):
        fake = _FakeDB(None)
        data = {"currency": "USD"}
        out = await td._apply_default_seal(fake, "lianjia", data, {})
        assert out == {"currency": "USD"}
        assert len(fake.calls) == 1
