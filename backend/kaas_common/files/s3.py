"""S3 兼容对象存储签名（AWS SigV4 预签名）—— **纯标准库**。

为什么要自己实现
----------------
生产 Worker 跑在 Pyodide 里，装不了 boto3（C 扩展）；而"预签名"本质就是
**规范化请求 + HMAC-SHA256 链**，标准库完全够用。自己实现之后，**同一份代码**
同时服务三处，不再各写一套：

    · 生产 Cloudflare R2（S3 端点，region="auto"）
    · 本地 MinIO（Docker，region="us-east-1"）
    · 兜底 inline（不经过本模块）

为什么用**查询串签名**（而不是签名头）
--------------------------------------
预签名 PUT/GET 不需要任何鉴权头 ⇒ 调用方只要一个 HTTP 客户端就够了
（orchestrator 用 httpx、Worker 用 `from js import fetch`、浏览器可直传），
两侧的 HTTP 实现不参与签名逻辑，签名逻辑只有这一份。

正确性怎么保证
--------------
`tests/test_files_s3.py` 用本地 `minio` 包的 `presign_v4`（同样纯计算、不需要服务器）
**交叉比对签名**：同样的 host/bucket/key/密钥/region/时间/有效期，签名必须逐字符相同。
自己写的密码学必须拿独立实现对照，否则"看起来能跑"说明不了任何问题。
"""
from __future__ import annotations

import hashlib
import hmac
from datetime import datetime, timezone
from typing import Mapping, Optional
from urllib.parse import quote, urlparse

__all__ = [
    "AWS_ALGORITHM", "SigV4Error", "uri_encode", "signing_key",
    "presign_url", "presign_put_url", "presign_get_url", "s3_config",
]

AWS_ALGORITHM = "AWS4-HMAC-SHA256"
_UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD"


class SigV4Error(ValueError):
    """签名参数不合法（缺密钥、端点不是 http(s)、bucket/key 为空）。"""


def uri_encode(value: str, *, encode_slash: bool = True) -> str:
    """AWS 规范化编码：非 RFC3986 未保留字符一律百分号编码。

    `urllib.parse.quote` 天然保留 `A-Za-z0-9_.-~`（正是 AWS 的未保留集），
    所以只要控制 `/` 是否编码即可 —— 路径里 `/` 不编码、查询串里的值要编码。
    """
    return quote(str(value), safe="" if encode_slash else "/")


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def signing_key(secret_key: str, date: str, region: str, service: str = "s3") -> bytes:
    """SigV4 的派生签名密钥（`AWS4` + secret 起，逐级 HMAC）。"""
    key = ("AWS4" + secret_key).encode("utf-8")
    return _hmac(_hmac(_hmac(_hmac(key, date), region), service), "aws4_request")


def _amz_dates(now: Optional[datetime]) -> tuple[datetime, str, str]:
    moment = now or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    moment = moment.astimezone(timezone.utc)
    return moment, moment.strftime("%Y%m%dT%H%M%SZ"), moment.strftime("%Y%m%d")


def _split_endpoint(endpoint: str):
    if "://" not in endpoint:
        raise SigV4Error(f"端点必须带协议：{endpoint!r}")
    parsed = urlparse(endpoint)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise SigV4Error(f"端点不合法：{endpoint!r}")
    return parsed


def _signed_url(
    method: str,
    endpoint: str,
    bucket: str,
    key: str,
    *,
    access_key: str,
    secret_key: str,
    region: str = "auto",
    expires: int = 900,
    now: Optional[datetime] = None,
    extra_query: Optional[Mapping[str, str]] = None,
) -> str:
    """签名核心。`key` 允许为空串 ⇒ 桶级操作（如 ListObjectsV2）。"""
    if not access_key or not secret_key:
        raise SigV4Error("缺少 S3 访问密钥（access_key / secret_key）")
    if not bucket:
        raise SigV4Error("bucket 不能为空")
    if expires <= 0 or expires > 604800:
        raise SigV4Error(f"有效期必须在 1..604800 秒之间，收到 {expires}")

    parsed = _split_endpoint(endpoint)
    host = parsed.netloc
    base_path = parsed.path.rstrip("/")
    object_path = f"{base_path}/{uri_encode(bucket)}/{uri_encode(key, encode_slash=False)}"

    _, amz_date, date = _amz_dates(now)
    scope = f"{date}/{region}/s3/aws4_request"

    params: dict[str, str] = {
        "X-Amz-Algorithm": AWS_ALGORITHM,
        "X-Amz-Credential": f"{access_key}/{scope}",
        "X-Amz-Date": amz_date,
        "X-Amz-Expires": str(int(expires)),
        "X-Amz-SignedHeaders": "host",
    }
    for k, v in (extra_query or {}).items():
        params[str(k)] = str(v)

    canonical_query = "&".join(
        f"{uri_encode(k)}={uri_encode(params[k])}" for k in sorted(params)
    )
    canonical_request = "\n".join([
        method.upper(),
        object_path,
        canonical_query,
        f"host:{host}\n",
        "host",
        _UNSIGNED_PAYLOAD,
    ])
    string_to_sign = "\n".join([
        AWS_ALGORITHM, amz_date, scope, _sha256_hex(canonical_request.encode("utf-8")),
    ])
    signature = hmac.new(
        signing_key(secret_key, date, region), string_to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    return f"{parsed.scheme}://{host}{object_path}?{canonical_query}&X-Amz-Signature={signature}"


def presign_url(
    method: str,
    endpoint: str,
    bucket: str,
    key: str,
    *,
    access_key: str,
    secret_key: str,
    region: str = "auto",
    expires: int = 900,
    now: Optional[datetime] = None,
    extra_query: Optional[Mapping[str, str]] = None,
) -> str:
    """生成**预签名 URL**（path-style：`{endpoint}/{bucket}/{key}`）。

    `region`：R2 用 `auto`；MinIO/AWS 用真实区域（如 `us-east-1`）。
    `expires`：有效期秒数（AWS 上限 604800 = 7 天）；用短时效，别把长期凭证能力泄露出去。
    """
    if not key:
        raise SigV4Error("key 不能为空（桶级操作用 presign_bucket_url）")
    return _signed_url(method, endpoint, bucket, key, access_key=access_key,
                       secret_key=secret_key, region=region, expires=expires,
                       now=now, extra_query=extra_query)


def presign_bucket_url(
    method: str,
    endpoint: str,
    bucket: str,
    *,
    access_key: str,
    secret_key: str,
    region: str = "auto",
    expires: int = 900,
    now: Optional[datetime] = None,
    extra_query: Optional[Mapping[str, str]] = None,
) -> str:
    """**桶级**操作的预签名 URL（key 为空，如 ListObjectsV2 按前缀清点/删除前枚举）。

    S5 预览 teardown 用：R2 没有"按前缀删"的 Cloudflare REST 端点，只能走
    S3 兼容 ListObjectsV2；签名复用本模块这同一段（两端交叉验签过的代码）。
    """
    return _signed_url(method, endpoint, bucket, "", access_key=access_key,
                       secret_key=secret_key, region=region, expires=expires,
                       now=now, extra_query=extra_query)


def presign_put_url(endpoint: str, bucket: str, key: str, **kwargs) -> str:
    """上传用的预签名 URL（PUT）。"""
    return presign_url("PUT", endpoint, bucket, key, **kwargs)


def presign_get_url(endpoint: str, bucket: str, key: str, **kwargs) -> str:
    """下载用的预签名 URL（GET）。"""
    return presign_url("GET", endpoint, bucket, key, **kwargs)


def s3_config(get) -> Optional[dict]:
    """读出 S3 配置；**不完整就返回 None**（调用方据此回退 binding/inline）。

    `get` 是一个 `key -> str` 的取值函数：orchestrator 传 `os.environ.get`，
    Worker 传请求期的 `main._binding`（Python Workers 在 import 期读不到绑定）。

    为什么"什么算配好"必须只有这一条规则：两端各自判断必然漂移，
    症状是"本地传进了对象存储、线上悄悄落库"这种无声的分叉。
    """
    endpoint = (get("S3_ENDPOINT") or "").strip()
    access_key = (get("S3_ACCESS_KEY") or "").strip()
    secret_key = (get("S3_SECRET_KEY") or "").strip()
    if not (endpoint and access_key and secret_key):
        return None
    raw_expires = (get("S3_PRESIGN_EXPIRES") or "").strip()
    try:
        expires = int(raw_expires) if raw_expires else 900
    except ValueError:
        expires = 900
    return {
        "endpoint": endpoint,
        "access_key": access_key,
        "secret_key": secret_key,
        "bucket": (get("S3_BUCKET") or "kaas-files").strip() or "kaas-files",
        "region": (get("S3_REGION") or "auto").strip() or "auto",
        "expires": expires if 0 < expires <= 604800 else 900,
    }
