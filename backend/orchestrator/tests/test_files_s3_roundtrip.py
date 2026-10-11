"""S3 存储路径的**端到端回环**验证：本地 stub S3 + 独立（minio-py）重算签名。

为什么已有的 `tests/test_files_s3.py` 不够
-----------------------------------------
那条测试只证明 `kaas_common.files.s3.presign_url` 的**纯计算**结果与 minio 一致 ——
"URL 算对了"不等于"这条存储路径真的能跑"：
`app/api/files.py::_store_bytes` 有没有真把字节 PUT 出去、`_load_bytes` 有没有真 GET 回来、
httpx 有没有把 URL 改坏、配置有没有从环境变量读到，这些只有**真回环**能证明。

所以本文件：
1. 在 127.0.0.1 的**随机端口**起一个 stub S3（纯 `http.server`，不依赖外网 / Docker / MinIO）；
2. 真发 PUT/GET 字节，断言 stub 收到的路径 / 内容 / Content-Type 就是期望的；
3. 对 stub **实际收到**的请求，用 minio-py 的 `presign_v4`（独立实现）按
   `X-Amz-Date` / `X-Amz-Credential` 里的 scope 重算，与请求里的
   `X-Amz-Signature` **逐字符**比对（查询串整体也比对）；
4. 覆盖未配 S3 时的 inline 回退。

全程走回环、秒级、确定，因此标 `unit`。
"""
from __future__ import annotations

import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional
from urllib.parse import parse_qs, unquote, urlsplit

import httpx
import pytest
from minio.credentials import Credentials
from minio.signer import presign_v4

from app.api.files import _load_bytes, _store_bytes

pytestmark = pytest.mark.unit

# ── 测试固定输入（与真实调用形状一致）─────────────────────────────────────────

AK = "AKIAMINIOEXAMPLE0001"
SK = "minio-secret-example-0001"
BUCKET = "kaas-files"
REGION = "us-east-1"
EXPIRES = 900
KEY = "t/default/product/x/photo/size/abc.jpg"
CONTENT_TYPE = "image/png"
# 含 >0x7F 与 \x00/\xff：任何一次"按字符串搬运"都会在这里露馅
PAYLOAD = bytes(range(256)) * 3 + b"\x00\xff\x89PNG"

_S3_VARS = (
    "S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET", "S3_REGION",
    "S3_PRESIGN_EXPIRES",
)
_X_AMZ_PARAMS = (
    "X-Amz-Algorithm",
    "X-Amz-Credential",
    "X-Amz-Date",
    "X-Amz-Expires",
    "X-Amz-SignedHeaders",
)
_AMZ_DATE_FMT = "%Y%m%dT%H%M%SZ"


# ── stub S3（127.0.0.1 随机端口）─────────────────────────────────────────────


class _Received:
    """stub 收到的一条请求（原样保留 request-target / 头 / body）。"""

    def __init__(self, method: str, raw_target: str, headers: dict, body: bytes):
        self.method = method
        self.raw_target = raw_target  # path?query，逐字节原样
        self.headers = headers
        self.body = body

    @property
    def split(self):
        return urlsplit(self.raw_target)

    @property
    def query_params(self) -> dict:
        return {k: v[0] for k, v in parse_qs(self.split.query).items()}

    def header(self, name: str) -> Optional[str]:
        """大小写不敏感地取一个请求头（HTTP 头名大小写不保证）。"""
        target = name.lower()
        for k, v in self.headers.items():
            if k.lower() == target:
                return v
        return None


class _StubS3:
    """极简 S3：PUT /{bucket}/{key...} 存 body，GET /{bucket}/{key...} 回 body。"""

    def __init__(self, bucket: str):
        self.bucket = bucket
        self.port: int = 0  # 由 fixture 在 bind 之后写入
        self.objects: dict[str, bytes] = {}
        self.requests: list[_Received] = []
        self._lock = threading.Lock()

    @property
    def endpoint(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    # — 服务端回调 —
    def _record(self, method: str, raw_target: str, headers: dict, body: bytes) -> _Received:
        rec = _Received(method, raw_target, headers, body)
        with self._lock:
            self.requests.append(rec)
        return rec

    def _key_of(self, raw_target: str) -> Optional[str]:
        path = urlsplit(raw_target).path
        prefix = "/" + self.bucket + "/"
        if not path.startswith(prefix):
            return None
        return unquote(path[len(prefix):])

    def put_object(self, raw_target: str, body: bytes) -> bool:
        key = self._key_of(raw_target)
        if key is None:
            return False
        with self._lock:
            self.objects[key] = body
        return True

    def get_object(self, raw_target: str) -> Optional[bytes]:
        key = self._key_of(raw_target)
        if key is None:
            return None
        with self._lock:
            return self.objects.get(key)

    # — 测试侧查询 —
    def of(self, method: str) -> list[_Received]:
        return [r for r in self.requests if r.method == method]

    def only(self, method: str) -> _Received:
        got = self.of(method)
        assert len(got) == 1, f"期望恰好 1 条 {method}，实际 {len(got)} 条：{[r.raw_target for r in got]}"
        return got[0]


class _StubHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 静音 stub 日志，别污染 pytest 输出
        pass

    @property
    def stub(self) -> _StubS3:
        return self.server.stub  # type: ignore[attr-defined]

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _reply(self, code: int, body: bytes, content_type: str = "application/octet-stream") -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_PUT(self):
        raw_target = self.path
        body = self._read_body()
        self.stub._record("PUT", raw_target, dict(self.headers.items()), body)
        self._reply(200 if self.stub.put_object(raw_target, body) else 404, b"")

    def do_GET(self):
        raw_target = self.path
        self.stub._record("GET", raw_target, dict(self.headers.items()), b"")
        data = self.stub.get_object(raw_target)
        if data is None:
            self._reply(404, b"no such key")
        else:
            self._reply(200, data)


@pytest.fixture
def stub_s3():
    """127.0.0.1 随机端口上的 stub S3；退出时干净关停。"""
    stub = _StubS3(BUCKET)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _StubHandler)
    httpd.stub = stub  # type: ignore[attr-defined]
    stub.port = httpd.server_address[1]
    thread = threading.Thread(
        target=httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    try:
        yield stub
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


@pytest.fixture
def s3_env(monkeypatch, stub_s3):
    """把 S3_* 环境变量指向 stub —— 走 `kaas_common.files.s3_config` 的正式判定。"""
    for name in _S3_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("S3_ENDPOINT", stub_s3.endpoint)
    monkeypatch.setenv("S3_ACCESS_KEY", AK)
    monkeypatch.setenv("S3_SECRET_KEY", SK)
    monkeypatch.setenv("S3_BUCKET", BUCKET)
    monkeypatch.setenv("S3_REGION", REGION)
    monkeypatch.setenv("S3_PRESIGN_EXPIRES", str(EXPIRES))
    # 回环请求绝不能被环境里的代理截走（httpx 默认 trust_env=True）
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    return stub_s3.endpoint


# ── 独立验签（minio-py 重算 + 逐字符比对）─────────────────────────────────────


def _first_diff(got: str, expected: str) -> str:
    for i, (a, b) in enumerate(zip(got, expected)):
        if a != b:
            return (f"第 {i} 个字符起不同：实收 {a!r} vs 重算 {b!r}\n"
                    f"  实收={got}\n  重算={expected}")
    return f"长度不同：实收 {len(got)} vs 重算 {len(expected)}\n  实收={got}\n  重算={expected}"


def _verify_sigv4(rec: _Received, *, method: str) -> str:
    """用 minio-py 独立重算 `rec` 的 SigV4 预签名，逐字符比对；返回签名。"""
    assert rec.method == method, f"stub 收到的是 {rec.method}，期望 {method}"
    target = rec.split
    q = rec.query_params

    # 1) 请求里只应有 5 个标准 X-Amz-* + 签名本身（杜绝"签名没覆盖的参数"）
    assert set(q) == set(_X_AMZ_PARAMS) | {"X-Amz-Signature"}, (
        f"查询串参数集合不符合预签名 PUT/GET 的形状：{sorted(q)}")
    assert q["X-Amz-Algorithm"] == "AWS4-HMAC-SHA256"
    assert q["X-Amz-Expires"] == str(EXPIRES)

    # 2) 从 X-Amz-Credential 解析 access key 与 scope（region/service 由签名方声明）
    access_key, scope = q["X-Amz-Credential"].split("/", 1)
    date_part, region, service, terminator = scope.split("/")
    assert access_key == AK, "签名用的 access key 不是配置里的那个"
    assert (service, terminator) == ("s3", "aws4_request"), f"scope 不对：{scope!r}"
    assert region == REGION, f"签名 region 与配置不一致：{region!r}"
    assert date_part == q["X-Amz-Date"][:8], "scope 的日期与 X-Amz-Date 不是同一天"

    amz_date = datetime.strptime(q["X-Amz-Date"], _AMZ_DATE_FMT).replace(tzinfo=timezone.utc)

    # 3) 独立实现重算：把 X-Amz-* 交给 minio 自己生成（用解析出的 date/region/expires），
    #    再与 stub **实收**的查询串整体逐字符比对 —— 规范化路径/编码/排序全在里面。
    #
    #    注意：SignV4 的 canonical headers 用的是 `host:{url.netloc}`，所以必须拿实收请求的
    #    Host 头拼回**绝对 URL**；stub 侧只有 request-target（相对），直接喂给 minio 会把
    #    canonical headers 变成 "host:"，算出来的签名当然对不上。
    authority = rec.header("host")
    assert authority, "stub 没收到 Host 头，无法重算签名"
    absolute = f"http://{authority}{target.path}"
    signed = presign_v4(
        method=method,
        url=urlsplit(absolute),
        region=region,
        credentials=Credentials(access_key, SK),
        date=amz_date,
        expires=int(q["X-Amz-Expires"]),
    )
    assert signed.path == target.path, (
        f"规范化路径不一致：实收 {target.path!r} vs 重算 {signed.path!r}")
    assert signed.netloc == authority, f"重算用的 host 不对：{signed.netloc!r} vs {authority!r}"
    assert signed.query == target.query, "minio 独立重算的查询串与实收不一致：" + _first_diff(
        target.query, signed.query)

    # 4) 签名单独再比一次（要的就是"逐字符相同"这句话）
    got_sig = target.query.rsplit("X-Amz-Signature=", 1)[1]
    exp_sig = signed.query.rsplit("X-Amz-Signature=", 1)[1]
    assert len(got_sig) == 64 and all(c in "0123456789abcdef" for c in got_sig), (
        f"签名不是 64 位十六进制：{got_sig!r}")
    assert got_sig == exp_sig, "签名与独立实现不一致：" + _first_diff(got_sig, exp_sig)
    assert q["X-Amz-Signature"] == got_sig
    return got_sig


# ── 1/2/3/4 验收 ─────────────────────────────────────────────────────────────


class TestStoreBytesOverRealHttp:
    """配好 S3 ⇒ 字节真的落到对象存储。"""

    async def test_store_puts_bytes_to_stub(self, stub_s3, s3_env):
        storage, object_key, inline = await _store_bytes(KEY, PAYLOAD, CONTENT_TYPE)

        assert storage == "s3"
        assert object_key == KEY
        assert inline is None, "走 S3 时不应把字节留在库里（inline_content 必须是 None）"

        # stub 真收到了这些字节（不是 mock 记账）
        rec = stub_s3.only("PUT")
        assert rec.split.path == f"/{BUCKET}/{KEY}"
        assert rec.body == PAYLOAD
        assert rec.headers.get("Content-Type") == CONTENT_TYPE
        assert stub_s3.objects[KEY] == PAYLOAD

    async def test_store_put_signature_is_independently_verifiable(self, stub_s3, s3_env):
        await _store_bytes(KEY, PAYLOAD, CONTENT_TYPE)
        _verify_sigv4(stub_s3.only("PUT"), method="PUT")

    async def test_store_raises_when_stub_rejects(self, monkeypatch, stub_s3, s3_env):
        """上传失败必须抛，不能"假装存成功了"（storage='s3' 却不能回读）。"""
        monkeypatch.setenv("S3_BUCKET", "not-served-by-stub")
        with pytest.raises(httpx.HTTPStatusError) as ei:
            await _store_bytes(KEY, PAYLOAD, CONTENT_TYPE)
        assert ei.value.response.status_code == 404
        assert not stub_s3.objects, "被拒的上传不该在对象存储里留下东西"


class TestLoadBytesRoundTrip:
    """写进去的字节，从预签名 GET 真能原样拿回来。"""

    async def test_roundtrip_returns_same_bytes(self, stub_s3, s3_env):
        await _store_bytes(KEY, PAYLOAD, CONTENT_TYPE)
        row = {"content": None, "object_key": KEY, "storage": "s3"}

        got = await _load_bytes(row)

        assert got == PAYLOAD, "回环拿到的字节与写入不一致"
        assert got is not None and len(got) == len(PAYLOAD)

    async def test_get_signature_is_independently_verifiable(self, stub_s3, s3_env):
        await _store_bytes(KEY, PAYLOAD, CONTENT_TYPE)
        await _load_bytes({"content": None, "object_key": KEY, "storage": "s3"})
        _verify_sigv4(stub_s3.only("GET"), method="GET")

    async def test_put_and_get_signatures_differ(self, stub_s3, s3_env):
        await _store_bytes(KEY, PAYLOAD, CONTENT_TYPE)
        await _load_bytes({"content": None, "object_key": KEY, "storage": "s3"})
        put_sig = _verify_sigv4(stub_s3.only("PUT"), method="PUT")
        get_sig = _verify_sigv4(stub_s3.only("GET"), method="GET")
        assert put_sig != get_sig, "PUT 与 GET 的签名必须不同（方法要进规范化请求）"

    async def test_missing_object_returns_none(self, stub_s3, s3_env):
        got = await _load_bytes({"content": None, "object_key": KEY, "storage": "s3"})
        assert got is None, "对象不存在时应当返回 None，而不是把错误页当内容"
        assert stub_s3.only("GET").split.path == f"/{BUCKET}/{KEY}"

    async def test_inline_content_wins_without_any_http(self, stub_s3, s3_env):
        """inline 行（content 非空）不该去打对象存储 —— 多一次网络就是多一次故障面。"""
        got = await _load_bytes({"content": PAYLOAD, "object_key": KEY, "storage": "inline"})
        assert got == PAYLOAD
        assert stub_s3.requests == [], "inline 行不应发起任何对象存储请求"


class TestInlineFallback:
    """没配 S3（完全没配 / 配一半）⇒ 字节留在库里，功能不缺。"""

    @pytest.mark.parametrize("partial_env", [
        {},  # 一个都没配
        {"S3_ENDPOINT": "http://127.0.0.1:1"},  # 只有 endpoint
        {"S3_ACCESS_KEY": AK, "S3_SECRET_KEY": SK},  # 只有密钥
        {"S3_ENDPOINT": "http://127.0.0.1:1", "S3_ACCESS_KEY": AK},  # 少 secret
        {"S3_ENDPOINT": "   ", "S3_ACCESS_KEY": AK, "S3_SECRET_KEY": SK},  # 空白 endpoint
    ])
    async def test_store_falls_back_to_inline(self, monkeypatch, partial_env):
        for name in _S3_VARS:
            monkeypatch.delenv(name, raising=False)
        for k, v in partial_env.items():
            monkeypatch.setenv(k, v)

        storage, object_key, inline = await _store_bytes(KEY, PAYLOAD, CONTENT_TYPE)

        assert storage == "inline"
        assert object_key == KEY
        assert inline == PAYLOAD, "回退 inline 时必须把字节交回调用方"

    async def test_inline_row_loads_without_s3_config(self, monkeypatch):
        for name in _S3_VARS:
            monkeypatch.delenv(name, raising=False)
        row = {"content": PAYLOAD, "object_key": KEY, "storage": "inline"}
        assert await _load_bytes(row) == PAYLOAD

    async def test_s3_row_is_unreadable_without_config(self, monkeypatch):
        """配了 S3 时写的对象，在没配 S3 的进程里读不到 —— 明确返回 None，而不是假装读到。"""
        for name in _S3_VARS:
            monkeypatch.delenv(name, raising=False)
        row = {"content": None, "object_key": KEY, "storage": "s3"}
        assert await _load_bytes(row) is None
