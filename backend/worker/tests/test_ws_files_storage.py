"""Worker 侧文件存储落点（S3 预签名 → R2 binding → inline）与回退顺序的单测。

为什么需要这个文件
------------------
生产 API 就是本 Worker（`kaas.powervoy.com` / `api.kaas.powervoy.com`），文件本体的
三段落点优先级写在 `src/ws_files.py`：

    ① S3 预签名（读**请求期**绑定 `S3_*`）→ ② R2 binding（`FILES`）→ ③ inline（写库）

orchestrator 侧的单测只覆盖了 `os.environ` 那条路径；而 Worker 这条「配置从
`request.scope["env"]` 经 `main._binding` 读」的链路此前没有任何测试。生产又无法用
登录跑端到端上传 —— 本文件就是「Worker 侧配置读取正确、回退顺序与落点标注正确」的
唯一证据。

怎么在 CPython 里测 Pyodide 代码
--------------------------------
`ws_files` 依赖 Pyodide 的 `from js import fetch / FILES / Uint8Array`。本文件**不真的
触发 Pyodide**：

* `_js_fetch_bytes` / `_r2_bucket` 一律 monkeypatch 成假实现（现有 worker 测试的同一
  路数：假连接、假依赖，不碰网络/数据库）；
* 只有「② binding 成功」那一条例外 —— `_store_bytes` 里 `from js import Uint8Array`
  在 CPython 下必然 ModuleNotFoundError，不往 `sys.modules` 塞一个最小假 `js` 模块就
  根本测不到 binding 分支（塞进去后 Pyodide 专属代码也不执行，只验证调用约定）。

不改被测代码；所有用例快、确定、无外网、无数据库。
"""
from __future__ import annotations

import asyncio
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

load_main()  # 先装好 `workers` stub 并保证 `main` 可导入，再 import ws_files

import ws_files as wsf  # noqa: E402

_REQUIRED_KEYS = ("S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY")
_OPTIONAL_KEYS = ("S3_BUCKET", "S3_REGION", "S3_PRESIGN_EXPIRES")
_ALL_S3_KEYS = _REQUIRED_KEYS + _OPTIONAL_KEYS

ENDPOINT = "https://acct123.r2.cloudflarestorage.com"
BUCKET = "kaas-files"
KEY = "default/product/7/product_photo/ab12cd34.png"
PNG_BYTES = b"\x89PNG-first"


# ── 假绑定 / 假请求 ─────────────────────────────────────────────────────────

class _Env:
    """`request.scope["env"]` 的替身：按**属性**读绑定（与 Pyodide 里的 env 一致）。"""

    def __init__(self, bindings: dict):
        self.__dict__.update(bindings)


class _FakeRequest:
    """只实现 `_binding` 需要的那一件事：`scope["env"]`。"""

    def __init__(self, bindings: dict | None = None, *, with_env: bool = True):
        self.scope: dict = {"env": _Env(bindings or {})} if with_env else {}


def _s3_request(**overrides):
    env = {
        "S3_ENDPOINT": ENDPOINT,
        "S3_ACCESS_KEY": "AKIA-EXAMPLE",
        "S3_SECRET_KEY": "secret-example",
        "S3_BUCKET": BUCKET,
        "S3_REGION": "auto",
    }
    env.update(overrides)
    return _FakeRequest(env)


@pytest.fixture(autouse=True)
def _no_ambient_s3_env(monkeypatch):
    """本机 / CI 的 os.environ 里可能就躺着 S3_*；一律清掉。

    否则「没配 S3」的用例会意外读到开发机的真实配置 —— 测试从此不可确定。
    """
    for key in _ALL_S3_KEYS:
        monkeypatch.delenv(key, raising=False)


def _run(coro):
    return asyncio.run(coro)


# ── 假 Pyodide 依赖 ─────────────────────────────────────────────────────────

class _FakeUint8Array:
    """最小 `js.Uint8Array` 替身：只提供 `_store_bytes` 用到的 `.new(data)`。"""

    def __init__(self, data):
        self.data = bytes(data)

    @classmethod
    def new(cls, data):
        return cls(data)


def _install_fake_js(monkeypatch):
    """往 sys.modules 塞假 `js`，让 `from js import Uint8Array` 在 CPython 下可解析。

    monkeypatch 会在用例结束后自动移除，不会污染其它测试文件。
    """
    js = types.ModuleType("js")
    js.Uint8Array = _FakeUint8Array
    monkeypatch.setitem(sys.modules, "js", js)
    return js


class _FakeJSFetch:
    """假 `_js_fetch_bytes`：记录调用，按队列返回结果或抛异常。"""

    def __init__(self, *results):
        self.calls: list[dict] = []
        self._queue = list(results)

    async def __call__(self, url, method, data=None, content_type=""):
        self.calls.append({"url": url, "method": method,
                           "data": data, "content_type": content_type})
        result = self._queue.pop(0) if self._queue else None
        if isinstance(result, Exception):
            raise result
        return result


class _FakeR2Buffer:
    def __init__(self, data: bytes):
        self._data = bytes(data)

    def to_py(self):
        return bytearray(self._data)


class _FakeR2Object:
    def __init__(self, data: bytes):
        self._data = bytes(data)

    async def arrayBuffer(self):
        return _FakeR2Buffer(self._data)


class _FakeBucket:
    """假 R2 bucket：记录 `put` / `get`，可配置为成功、抛异常或返回 None。"""

    def __init__(self, *, put_error=None, get_result=None, get_error=None):
        self.puts: list[tuple] = []
        self.gets: list[str] = []
        self._put_error = put_error
        self._get_result = get_result
        self._get_error = get_error

    async def put(self, key, body, opts=None):
        self.puts.append((key, body, opts))
        if self._put_error is not None:
            raise self._put_error

    async def get(self, key):
        self.gets.append(key)
        if self._get_error is not None:
            raise self._get_error
        return self._get_result


def _patch_bucket(monkeypatch, bucket):
    # 2026-10-17：_r2_bucket 现在优先从 request.scope["env"].FILES 取，签名带 request
    monkeypatch.setattr(wsf, "_r2_bucket", lambda *a, **k: bucket)


def _bucket_must_not_be_used(monkeypatch):
    def _boom(*a, **k):
        raise AssertionError("不该走到 R2 binding 分支")

    monkeypatch.setattr(wsf, "_r2_bucket", _boom)


# ════════════════════════════════════════════════════════════════════════════
# 1. `_s3(request)` —— 经 main._binding 读请求期绑定，判定与共享内核一致
# ════════════════════════════════════════════════════════════════════════════

def test_s3_reads_all_bindings_from_request_scope_env():
    """配置齐全 → 返回 dict，字段逐个来自绑定（读的是 request.scope["env"]）。"""
    cfg = wsf._s3(_s3_request(S3_PRESIGN_EXPIRES="1200"))

    assert cfg is not None
    assert cfg["endpoint"] == ENDPOINT
    assert cfg["access_key"] == "AKIA-EXAMPLE"
    assert cfg["secret_key"] == "secret-example"
    assert cfg["bucket"] == BUCKET
    assert cfg["region"] == "auto"
    assert cfg["expires"] == 1200


def test_s3_optional_bindings_fall_back_to_kernel_defaults():
    """只配三个机密 → bucket/region/expires 走 `kaas_common.files.s3_config` 的默认。"""
    cfg = wsf._s3(_s3_request())

    assert cfg is not None
    assert cfg["bucket"] == "kaas-files"
    assert cfg["region"] == "auto"
    assert cfg["expires"] == 900


@pytest.mark.parametrize("missing", _REQUIRED_KEYS)
def test_s3_returns_none_when_a_required_binding_is_missing(missing):
    """缺任一机密 → None（调用方据此回退 binding / inline）。"""
    cfg = wsf._s3(_s3_request(**{missing: ""}))

    assert cfg is None


@pytest.mark.parametrize("raw", ["", "not-a-number", "0", "-5", "604801", "99999999"])
def test_s3_invalid_expires_falls_back_to_kernel_default(raw):
    """有效期非法 → 900（与共享内核同一判定，不在这里另写一份）。"""
    cfg = wsf._s3(_s3_request(S3_PRESIGN_EXPIRES=raw))

    assert cfg is not None
    assert cfg["expires"] == 900


def test_s3_request_scope_env_wins_and_missing_key_falls_back_to_os_environ(monkeypatch):
    """`main._binding` 的优先级：request.scope["env"] → os.environ（按 key 回退）。"""
    monkeypatch.setenv("S3_ENDPOINT", "https://from-os-environ.example")
    monkeypatch.setenv("S3_BUCKET", "env-bucket")

    # ① scope env 有该 key → 用 scope 的值，而不是 os.environ 的
    cfg = wsf._s3(_s3_request())
    assert cfg is not None
    assert cfg["endpoint"] == ENDPOINT
    assert cfg["bucket"] == BUCKET

    # ② scope env 没有 S3_BUCKET（其余机密仍在）→ 该 key 落到 os.environ
    request = _s3_request()
    del request.scope["env"].S3_BUCKET
    cfg = wsf._s3(request)
    assert cfg is not None
    assert cfg["bucket"] == "env-bucket"


def test_s3_goes_through_main_binding_with_the_request(monkeypatch):
    """配置**必须**经 `main._binding(key, request)` 读 —— 这正是生产踩过的坑
    （import 期读 os.environ 恒为空）。这里钉死取值函数与请求透传。"""
    seen: list[tuple] = []
    values = {
        "S3_ENDPOINT": ENDPOINT,
        "S3_ACCESS_KEY": "AK",
        "S3_SECRET_KEY": "SK",
        "S3_BUCKET": "bkt",
        "S3_REGION": "us-east-1",
        "S3_PRESIGN_EXPIRES": "600",
    }

    def fake_binding(key, request=None):
        seen.append((key, request))
        return values.get(key, "")

    monkeypatch.setattr(wsf._main, "_binding", fake_binding)
    request = _FakeRequest(with_env=False)  # 不走 scope env，证明确实在调 _binding

    cfg = wsf._s3(request)

    assert cfg == {"endpoint": ENDPOINT, "access_key": "AK", "secret_key": "SK",
                   "bucket": "bkt", "region": "us-east-1", "expires": 600}
    assert set(_ALL_S3_KEYS) <= {key for key, _ in seen}
    assert all(passed is request for _, passed in seen)


# ════════════════════════════════════════════════════════════════════════════
# 2. `_store_bytes` —— 三段回退的顺序与落点标注
# ════════════════════════════════════════════════════════════════════════════

def test_store_bytes_s3_success_marks_s3_and_never_touches_binding(monkeypatch):
    fetch = _FakeJSFetch(None)
    monkeypatch.setattr(wsf, "_js_fetch_bytes", fetch)
    _bucket_must_not_be_used(monkeypatch)

    out = _run(wsf._store_bytes(_s3_request(), KEY, PNG_BYTES, "image/png"))

    assert out == ("s3", KEY, None)
    assert len(fetch.calls) == 1
    call = fetch.calls[0]
    assert call["method"] == "PUT"
    assert call["data"] == PNG_BYTES
    assert call["content_type"] == "image/png"
    assert call["url"].startswith(f"{ENDPOINT}/{BUCKET}/{KEY}?")
    assert "X-Amz-Signature=" in call["url"]


def test_store_bytes_without_s3_config_goes_straight_to_binding(monkeypatch):
    """没配 S3（`_s3` 为 None）→ 不发预签名请求，直接 binding。"""
    fetch = _FakeJSFetch()
    monkeypatch.setattr(wsf, "_js_fetch_bytes", fetch)
    _install_fake_js(monkeypatch)
    bucket = _FakeBucket()
    _patch_bucket(monkeypatch, bucket)

    out = _run(wsf._store_bytes(_FakeRequest(), KEY, PNG_BYTES, "image/png"))

    assert out == ("s3", KEY, None)
    assert fetch.calls == []
    assert len(bucket.puts) == 1
    put_key, put_body, put_opts = bucket.puts[0]
    assert put_key == KEY
    assert bytes(put_body.data) == PNG_BYTES
    assert put_opts == {"httpMetadata": {"contentType": "image/png"}}


def test_store_bytes_falls_back_to_binding_when_s3_put_fails(monkeypatch):
    """S3 抛异常 → binding 成功，落点仍记为 s3（因为字节确实在对象存储里）。"""
    fetch = _FakeJSFetch(RuntimeError("S3 PUT 503"))
    monkeypatch.setattr(wsf, "_js_fetch_bytes", fetch)
    _install_fake_js(monkeypatch)
    bucket = _FakeBucket()
    _patch_bucket(monkeypatch, bucket)

    out = _run(wsf._store_bytes(_s3_request(), KEY, PNG_BYTES, "image/png"))

    assert out == ("s3", KEY, None)
    assert len(fetch.calls) == 1 and fetch.calls[0]["method"] == "PUT"
    assert len(bucket.puts) == 1 and bucket.puts[0][0] == KEY


def test_store_bytes_inline_when_s3_fails_and_no_binding(monkeypatch):
    """S3 抛异常 + 没有 binding → inline，且返回的字节**就是**输入字节。"""
    monkeypatch.setattr(wsf, "_js_fetch_bytes",
                        _FakeJSFetch(RuntimeError("S3 PUT 403")))
    _patch_bucket(monkeypatch, None)

    out = _run(wsf._store_bytes(_s3_request(), KEY, PNG_BYTES, "image/png"))

    assert out == ("inline", KEY, PNG_BYTES)
    assert out[2] is PNG_BYTES  # 不复制、不改写，原样写库


def test_store_bytes_inline_when_binding_put_fails(monkeypatch):
    """S3 抛异常 + binding 也抛异常 → inline（上传是用户显式动作，不能 500）。"""
    monkeypatch.setattr(wsf, "_js_fetch_bytes",
                        _FakeJSFetch(RuntimeError("S3 PUT 500")))
    _install_fake_js(monkeypatch)
    _patch_bucket(monkeypatch, _FakeBucket(put_error=RuntimeError("R2 put 挂了")))

    out = _run(wsf._store_bytes(_s3_request(), KEY, PNG_BYTES, "image/png"))

    assert out == ("inline", KEY, PNG_BYTES)
    assert out[2] is PNG_BYTES


# ════════════════════════════════════════════════════════════════════════════
# 3. `_load_bytes` —— 读取顺序：inline content → S3 → binding → None
# ════════════════════════════════════════════════════════════════════════════

def test_load_bytes_prefers_inline_content(monkeypatch):
    """row 有 content → 直接返回，碰都不碰对象存储。"""
    fetch = _FakeJSFetch(b"from-s3")
    monkeypatch.setattr(wsf, "_js_fetch_bytes", fetch)
    _bucket_must_not_be_used(monkeypatch)

    out = _run(wsf._load_bytes(_s3_request(),
                               {"content": b"inline-bytes", "object_key": KEY}))

    assert out == b"inline-bytes"
    assert fetch.calls == []


def test_load_bytes_reads_from_s3_with_presigned_get(monkeypatch):
    """content 为空 + 有 object_key + 配了 S3 → 预签名 GET 拿字节。"""
    fetch = _FakeJSFetch(b"from-s3")
    monkeypatch.setattr(wsf, "_js_fetch_bytes", fetch)
    _bucket_must_not_be_used(monkeypatch)

    out = _run(wsf._load_bytes(_s3_request(),
                               {"content": None, "object_key": KEY}))

    assert out == b"from-s3"
    assert len(fetch.calls) == 1
    call = fetch.calls[0]
    assert call["method"] == "GET"
    assert call["url"].startswith(f"{ENDPOINT}/{BUCKET}/{KEY}?")
    assert "X-Amz-Signature=" in call["url"]


def test_load_bytes_falls_back_to_binding_when_s3_fails(monkeypatch):
    monkeypatch.setattr(wsf, "_js_fetch_bytes",
                        _FakeJSFetch(RuntimeError("S3 GET 404")))
    bucket = _FakeBucket(get_result=_FakeR2Object(b"from-binding"))
    _patch_bucket(monkeypatch, bucket)

    out = _run(wsf._load_bytes(_s3_request(),
                               {"content": None, "object_key": KEY}))

    assert out == b"from-binding"
    assert bucket.gets == [KEY]


def test_load_bytes_returns_none_without_s3_and_without_binding(monkeypatch):
    fetch = _FakeJSFetch(b"never-used")
    monkeypatch.setattr(wsf, "_js_fetch_bytes", fetch)
    _patch_bucket(monkeypatch, None)

    out = _run(wsf._load_bytes(_FakeRequest(),
                               {"content": None, "object_key": KEY}))

    assert out is None
    assert fetch.calls == []


def test_load_bytes_returns_none_when_binding_returns_no_object(monkeypatch):
    monkeypatch.setattr(wsf, "_js_fetch_bytes",
                        _FakeJSFetch(RuntimeError("S3 GET 断网")))
    _patch_bucket(monkeypatch, _FakeBucket(get_result=None))

    out = _run(wsf._load_bytes(_s3_request(),
                               {"content": None, "object_key": KEY}))

    assert out is None


def test_load_bytes_returns_none_not_the_error_text_when_binding_raises(monkeypatch):
    """binding 读失败 → None（上层据此 404），**不能**把异常文本当内容返回。"""
    monkeypatch.setattr(wsf, "_js_fetch_bytes",
                        _FakeJSFetch(RuntimeError("S3 GET 500")))
    _patch_bucket(monkeypatch, _FakeBucket(get_error=RuntimeError("R2 get 挂了")))

    out = _run(wsf._load_bytes(_s3_request(),
                               {"content": None, "object_key": KEY}))

    assert out is None


def test_load_bytes_without_content_and_object_key_is_none(monkeypatch):
    fetch = _FakeJSFetch(b"never-used")
    monkeypatch.setattr(wsf, "_js_fetch_bytes", fetch)
    _bucket_must_not_be_used(monkeypatch)

    out = _run(wsf._load_bytes(_s3_request(), {"content": None, "object_key": None}))

    assert out is None
    assert fetch.calls == []


# ════════════════════════════════════════════════════════════════════════════
# 4. `resolve_photo_refs` —— {file_id} → data URI，坏条目跳过而不是印坏图
# ════════════════════════════════════════════════════════════════════════════

class _FakeDB:
    """假 `ws_files.db`：按顺序吐预设行，并记录 SQL / 参数。"""

    def __init__(self, *rows):
        self.rows = list(rows)
        self.calls: list[dict] = []

    async def fetchrow(self, request, sql, *params, table=None):
        self.calls.append({"sql": sql, "params": params, "table": table})
        if not self.rows:
            return None
        item = self.rows.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _install_db(monkeypatch, db):
    monkeypatch.setattr(wsf, "db", db)
    return db


def test_resolve_photo_refs_turns_file_id_into_data_uri(monkeypatch):
    db = _install_db(monkeypatch, _FakeDB(
        {"name": "产品图 A", "content_type": "image/png", "file_name": "p7.png",
         "content": None, "object_key": "media/7.png", "storage": "s3"},
    ))
    monkeypatch.setattr(wsf, "_js_fetch_bytes", _FakeJSFetch(PNG_BYTES))
    data = {"product_photos": [{"file_id": 7, "caption": "盖章"}]}

    out = _run(wsf.resolve_photo_refs(_s3_request(), data))

    assert out["product_photos"] == [
        {"image": "data:image/png;base64,iVBORy1maXJzdA==", "caption": "盖章"},
    ]
    assert len(db.calls) == 1
    assert "is_current" in db.calls[0]["sql"]
    assert db.calls[0]["params"] == ("default", 7)


def test_resolve_photo_refs_passes_through_entries_that_are_already_sources(monkeypatch):
    db = _install_db(monkeypatch, _FakeDB())
    already = {"image": "https://cdn.example/x.png", "caption": "原样透传"}
    src_only = {"src": "data:image/png;base64,AAAA", "caption": "src 也算图源"}
    data = {"product_photos": [already, src_only]}

    out = _run(wsf.resolve_photo_refs(_s3_request(), data))

    assert out["product_photos"] == [already, src_only]
    assert db.calls == []  # 不需要查库


def test_resolve_photo_refs_skips_missing_rows_and_unreadable_bytes(monkeypatch):
    """三条引用：查不到行 / 拿到行但字节取不到 / 能取到 → 只保留最后一条。"""
    db = _install_db(monkeypatch, _FakeDB(
        None,  # 行不存在（已下线 / 非本租户）
        {"name": "读不到", "content_type": "image/png", "file_name": "x.png",
         "content": None, "object_key": "media/9.png", "storage": "s3"},
        {"name": "好图", "content_type": "image/png", "file_name": "ok.png",
         "content": b"PNGDATA", "object_key": None, "storage": "inline"},
    ))
    # 第 2 条引用的 GET 返回 None → 取不到字节 → 跳过（第 3 条走 inline，不发请求）
    monkeypatch.setattr(wsf, "_js_fetch_bytes", _FakeJSFetch(None))
    data = {"product_photos": [
        {"file_id": 8, "caption": "没了"},
        {"file_id": 9, "caption": "读不到"},
        {"file_id": 10, "caption": "好图"},
    ]}

    out = _run(wsf.resolve_photo_refs(_s3_request(), data))

    assert out["product_photos"] == [
        {"image": "data:image/png;base64,UE5HREFUQQ==", "caption": "好图"},
    ]
    assert len(db.calls) == 3  # 三次都查了，只是坏条目没进结果


def test_resolve_photo_refs_caption_falls_back_to_file_name(monkeypatch):
    _install_db(monkeypatch, _FakeDB(
        {"name": "产品图 A", "content_type": "image/png", "file_name": "p7.png",
         "content": b"PNGDATA", "object_key": None, "storage": "inline"},
    ))
    data = {"product_photos": [{"file_id": 7}]}

    out = _run(wsf.resolve_photo_refs(_s3_request(), data))

    assert out["product_photos"][0]["caption"] == "产品图 A"


def test_resolve_photo_refs_keeps_entry_order_and_mixes_resolved_and_passthrough(monkeypatch):
    _install_db(monkeypatch, _FakeDB(
        {"name": "A", "content_type": "image/png", "file_name": "a.png",
         "content": b"PNGDATA", "object_key": None, "storage": "inline"},
    ))
    data = {"product_photos": [
        {"file_id": 1, "caption": "第一"},
        {"image": "https://cdn.example/b.png", "caption": "第二"},
    ]}

    out = _run(wsf.resolve_photo_refs(_s3_request(), data))

    photos = out["product_photos"]
    assert len(photos) == 2
    assert photos[0]["caption"] == "第一"
    assert photos[0]["image"] == "data:image/png;base64,UE5HREFUQQ=="
    assert photos[1] == {"image": "https://cdn.example/b.png", "caption": "第二"}


@pytest.mark.parametrize("data", [
    {},
    {"product_photos": []},
    {"product_photos": None},
    {"other": "无关字段"},
])
def test_resolve_photo_refs_is_a_noop_without_refs(monkeypatch, data):
    db = _install_db(monkeypatch, _FakeDB())

    out = _run(wsf.resolve_photo_refs(_s3_request(), data))

    assert out is data  # 原对象原样返回
    assert db.calls == []

# ════════════════════════════════════════════════════════════════════════════
# 5. A4 渲染图片直链：{file_id} → 短期签名 URL（回退 data URI）
# ════════════════════════════════════════════════════════════════════════════


class _Url:
    def __init__(self, scheme: str):
        self.scheme = scheme


class _AssetRequest:
    """带 headers/url 的假请求（`_public_base` 需要真实 Host 才能拼绝对地址）。"""

    def __init__(self, bindings: dict | None = None, *, host: str = "kaas.example.com",
                 scheme: str = "https", proto: str | None = None):
        self.scope = {"env": _Env(bindings or {})}
        self.headers = {"host": host} if host else {}
        if proto:
            self.headers["x-forwarded-proto"] = proto
        self.url = _Url(scheme)


def test_public_base_builds_absolute_origin():
    assert wsf._public_base(_AssetRequest()) == "https://kaas.example.com"
    assert wsf._public_base(_AssetRequest(proto="http")) == "http://kaas.example.com"
    assert wsf._public_base(_AssetRequest(scheme="http")) == "http://kaas.example.com"
    assert wsf._public_base(_AssetRequest(host="")) == ""


def test_asset_url_requires_host_and_secret(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    assert wsf._asset_url(_AssetRequest(host=""), "file", 7) == ""
    # 有 host 但没 JWT_SECRET（测试/无密钥环境）⇒ 回退 data URI
    assert wsf._asset_url(_AssetRequest({"JWT_SECRET": ""}), "file", 7) == ""
    assert wsf._asset_url(_AssetRequest({"JWT_SECRET": "s3cret"}), "unknown", 7) == ""


def test_asset_url_binds_file_id_purpose_and_verifies():
    from kaas_common.files import verify_asset_token

    req = _AssetRequest({"JWT_SECRET": "s3cret"})
    url = wsf._asset_url(req, "file", 7)
    assert url.startswith("https://kaas.example.com/api/v1/file-objects/7/render-content?t=")
    token = url.split("t=", 1)[1]
    assert verify_asset_token("s3cret", "file", 7, token)
    assert not verify_asset_token("s3cret", "file", 8, token)
    assert not verify_asset_token("s3cret", "seal", 7, token)


def test_resolve_photo_refs_prefers_signed_url_and_skips_byte_loading(monkeypatch):
    _install_db(monkeypatch, _FakeDB({
        "name": "产品图 A", "content_type": "image/png", "file_name": "p7.png",
        "content": None, "object_key": "media/7.png", "storage": "s3",
    }))
    req = _AssetRequest({"JWT_SECRET": "s3cret"})
    data = {"product_photos": [{"file_id": 7, "caption": "盖章"}]}

    out = _run(wsf.resolve_photo_refs(req, data))

    assert out["product_photos"] == [{
        "image": wsf._asset_url(req, "file", 7),
        "caption": "盖章",
    }]
    assert out["product_photos"][0]["image"].startswith("https://")


def test_file_render_content_rejects_bad_or_expired_token():
    req = _AssetRequest({"JWT_SECRET": "s3cret"})
    for bad in ("", "1.2", "9999999999." + "0" * 64):
        with pytest.raises(Exception) as exc:
            _run(wsf.get_file_render_content(7, req, t=bad))
        assert getattr(exc.value, "status_code", 0) == 401


def test_file_render_content_serves_bytes_with_valid_token(monkeypatch):
    _install_db(monkeypatch, _FakeDB({
        "content_type": "image/png", "file_name": "p7.png",
        "content": PNG_BYTES, "object_key": None, "storage": "inline",
    }))
    req = _AssetRequest({"JWT_SECRET": "s3cret"})
    token = wsf._asset_url(req, "file", 7).split("t=", 1)[1]

    resp = _run(wsf.get_file_render_content(7, req, t=token))

    assert resp.status_code == 200
    assert resp.body == PNG_BYTES
    assert resp.headers["content-type"] == "image/png"
