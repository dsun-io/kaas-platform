"""S3 SigV4 预签名：与本地 `minio` 包**交叉比对**（纯计算，不需要任何服务器）。

为什么必须交叉比对：自己实现的签名"看起来能跑"说明不了任何问题 —— 签名错了只会
表现为线上 `403 SignatureDoesNotMatch`，那是运行时现象、离现场很远。
拿一个**独立实现**（minio-py）算同样的输入、比逐字符相同的签名，才是证据。

（minio-py 的 `presign_v4` 允许注入 `date` ⇒ 结果确定、可复现。）
"""
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit

import pytest
from minio.credentials import Credentials
from minio.signer import presign_v4

from kaas_common.files.s3 import (
    SigV4Error,
    presign_get_url,
    presign_put_url,
    presign_url,
    uri_encode,
)

pytestmark = pytest.mark.unit

MOMENT = datetime(2026, 1, 1, 12, 34, 56, tzinfo=timezone.utc)
ENDPOINT = "https://ep-small-brook.r2.cloudflarestorage.com"
BUCKET = "kaas-files"
KEY = "t/default/product/chain_link/product_photo/size/ab12cd34ef56.jpg"
AK = "AKIAEXAMPLEEXAMPLE"
SK = "s3cr3t-example-key"
REGION = "auto"  # R2 的约定值
_AMZ_KEYS = (
    "X-Amz-Algorithm",
    "X-Amz-Credential",
    "X-Amz-Date",
    "X-Amz-Expires",
    "X-Amz-SignedHeaders",
)


def _minio_presign(method: str, expires: int = 900) -> tuple[dict, str]:
    url = urlsplit(f"{ENDPOINT}/{BUCKET}/{KEY}")
    signed = presign_v4(
        method=method,
        url=url,
        region=REGION,
        credentials=Credentials(AK, SK),
        date=MOMENT,
        expires=expires,
    )
    query = {k: v[0] for k, v in parse_qs(signed.query).items()}
    return query, f"{signed.scheme}://{signed.netloc}{signed.path}"


def _mine(method: str, expires: int = 900) -> tuple[dict, str]:
    url = presign_url(
        method, ENDPOINT, BUCKET, KEY,
        access_key=AK, secret_key=SK, region=REGION, expires=expires, now=MOMENT,
    )
    parts = urlsplit(url)
    query = {k: v[0] for k, v in parse_qs(parts.query).items()}
    return query, f"{parts.scheme}://{parts.netloc}{parts.path}"


class TestCrossCheckWithMinio:
    """独立实现对照 —— 签名不一致就说明我的规范化请求/派生密钥有错。"""

    @pytest.mark.parametrize("method", ["GET", "PUT"])
    def test_signature_matches_minio(self, method: str):
        expected, expected_base = _minio_presign(method)
        got, got_base = _mine(method)
        assert got_base == expected_base, "规范化后的 URL 路径不对（bucket/key 编码）"
        for key in _AMZ_KEYS:
            assert got[key] == expected[key], f"{key} 不一致"
        assert got["X-Amz-Signature"] == expected["X-Amz-Signature"], "签名与独立实现不一致"

    def test_expires_is_signed(self):
        expected, _ = _minio_presign("GET", expires=60)
        got, _ = _mine("GET", expires=60)
        assert got["X-Amz-Expires"] == expected["X-Amz-Expires"] == "60"
        assert got["X-Amz-Signature"] == expected["X-Amz-Signature"]


class TestPresignBehaviour:
    def test_deterministic(self):
        a = presign_get_url(ENDPOINT, BUCKET, KEY, access_key=AK, secret_key=SK,
                            region=REGION, now=MOMENT)
        b = presign_get_url(ENDPOINT, BUCKET, KEY, access_key=AK, secret_key=SK,
                            region=REGION, now=MOMENT)
        assert a == b

    def test_put_and_get_differ(self):
        get = presign_get_url(ENDPOINT, BUCKET, KEY, access_key=AK, secret_key=SK,
                              region=REGION, now=MOMENT)
        put = presign_put_url(ENDPOINT, BUCKET, KEY, access_key=AK, secret_key=SK,
                              region=REGION, now=MOMENT)
        assert get != put, "GET 与 PUT 的签名必须不同（方法进规范化请求）"

    def test_extra_query_params_are_signed(self):
        url = presign_get_url(ENDPOINT, BUCKET, KEY, access_key=AK, secret_key=SK,
                              region=REGION, now=MOMENT,
                              extra_query={"response-content-disposition": 'attachment; filename="a b.pdf"'})
        query = {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
        assert "response-content-disposition" in query
        assert query["response-content-disposition"] == 'attachment; filename="a b.pdf"'

    def test_rejects_bad_input(self):
        with pytest.raises(SigV4Error):
            presign_url("GET", ENDPOINT, BUCKET, KEY, access_key="", secret_key=SK)
        with pytest.raises(SigV4Error):
            presign_url("GET", ENDPOINT, BUCKET, KEY, access_key=AK, secret_key="")
        with pytest.raises(SigV4Error):
            presign_url("GET", ENDPOINT, "", KEY, access_key=AK, secret_key=SK)
        with pytest.raises(SigV4Error):
            presign_url("GET", "ep.example.com", BUCKET, KEY, access_key=AK, secret_key=SK)
        with pytest.raises(SigV4Error):
            presign_url("GET", ENDPOINT, BUCKET, KEY, access_key=AK, secret_key=SK, expires=0)
        with pytest.raises(SigV4Error):
            presign_url("GET", ENDPOINT, BUCKET, KEY, access_key=AK, secret_key=SK, expires=604801)


class TestUriEncode:
    def test_unreserved_kept_and_rest_encoded(self):
        assert uri_encode("a-b_c.d~e") == "a-b_c.d~e"  # AWS 未保留集原样保留（含 ~）
        assert uri_encode("a b") == "a%20b"
        assert uri_encode("a/b") == "a%2Fb"
        assert uri_encode("a/b", encode_slash=False) == "a/b"
        assert uri_encode("中文.jpg") == "%E4%B8%AD%E6%96%87.jpg"
        assert uri_encode("a+b") == "a%2Bb", "加号必须编码，否则会被当成空格"
