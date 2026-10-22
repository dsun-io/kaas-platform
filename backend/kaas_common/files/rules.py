"""文件域规则（共享内核）—— orchestrator 与 Worker **共用一份**，纯标准库。

背景（用户裁决）：
  「数据持久化保存在它自己的位置，特别是业务数据」
  ⇒ **业务行**留业务表；**文件元数据**进 `file_objects`；**文件本体**进对象存储
    （生产 Cloudflare R2 / 本地 MinIO，S3 兼容同一套代码），库里只存 `object_key`。
  「产品图片……单证直接调用产品管理页面的图片，一次维护重复使用」
  ⇒ 产品图**引用而非复制**（`trade_doc_files.file_id`）。
  「客户盖章回传以后要覆盖没有盖章的旧文件」+「要留档」
  ⇒ **版本化**：新版本上位（`is_current`），旧版本用 `supersedes_id` 串成版本链留档。

为什么这些判定必须在共享内核
  两端（orchestrator / Worker）都要做同一套校验与 key 规划；各写一份必然漂移
  （历史上 80 个接口漂移就是这么来的）。纯函数、零三方依赖 ⇒ Pyodide 也能加载。
"""
from __future__ import annotations

import re
from typing import Any, Optional

__all__ = [
    "OWNER_TYPES", "FILE_KINDS", "MEDIA_KINDS", "KIND_MIME", "MAX_BYTES",
    "FileRuleError", "validate_upload", "object_key", "file_ext",
    "next_version", "current_of", "MEDIA_KIND_LABELS",
    "is_file_ref", "to_data_uri", "coerce_file_ref_id",
]

# 归属类型（file_objects.owner_type）：
#   product 产品图 / trade_doc 单证 / customer 客户 / company 公司
#   order 订单随单附件（合同/PO/信用证扫描件，kind=other）
#   payment_receipt 到账截图（kind=other，PNG/JPG/PDF，16MB 上限）
# 2026-10-22（设计 §13.3）：新增 order / payment_receipt，复用 other 的大小与类型限制。
OWNER_TYPES = ("product", "trade_doc", "customer", "company", "order", "payment_receipt")
FILE_KINDS = ("product_photo", "stamp_scan", "render_pdf", "other")
MEDIA_KINDS = ("production", "size", "weight", "finished", "other")
STORAGE_BACKENDS = ("s3", "inline")

# 产品图的类型（用户要的：生产图片 / 尺寸图片 / 重量图片 / 成品图片）
MEDIA_KIND_LABELS = {
    "production": "生产图片",
    "size": "尺寸图片",
    "weight": "重量图片",
    "finished": "成品图片",
    "other": "其它",
}

_ALL_IMAGE = ("image/png", "image/jpeg", "image/webp")
KIND_MIME = {
    "product_photo": set(_ALL_IMAGE),
    "stamp_scan": set(_ALL_IMAGE) | {"application/pdf"},
    "render_pdf": {"application/pdf"},
    "other": set(_ALL_IMAGE) | {"application/pdf"},
}

MAX_BYTES = {
    "product_photo": 8 * 1024 * 1024,
    "stamp_scan": 16 * 1024 * 1024,
    "render_pdf": 32 * 1024 * 1024,
    "other": 16 * 1024 * 1024,
}

_EXT_BY_MIME = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
}
_SAFE_SEGMENT = re.compile(r"[^0-9A-Za-z._-]+")


class FileRuleError(ValueError):
    """文件规则不满足。`code` 与两端 API 的错误码一一对应（不要另造字符串）。"""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def file_ext(content_type: Optional[str], file_name: Optional[str] = None) -> str:
    """扩展名：以 content_type 为准（可信），文件名只作兜底。

    注意 content_type 可能带参数（`image/jpeg; charset=binary`）——先切掉参数再比对，
    否则会一路掉到文件名兜底，甚至返回空扩展名（对象存储里的 key 就没有后缀了）。
    """
    if content_type:
        mime = content_type.split(";")[0].strip().lower()
        if mime in _EXT_BY_MIME:
            return _EXT_BY_MIME[mime]
    if file_name and "." in file_name:
        ext = "." + file_name.rsplit(".", 1)[1].lower()
        if ext in set(_EXT_BY_MIME.values()):
            return ext
    return ""


def validate_upload(
    *,
    owner_type: str,
    kind: str,
    media_kind: Optional[str] = None,
    name: str,
    content_type: Optional[str],
    size: Optional[int],
) -> None:
    """上传前校验。任何一条不满足都抛 `FileRuleError`（**不静默兜底**）。

    为什么校验在服务端：前端能伪造 mime/大小；而"文件进了错的 kind / 超限"这类问题
    事后很难发现（图能显示，但归类错了、占满了存储）。
    """
    if owner_type not in OWNER_TYPES:
        raise FileRuleError("BAD_OWNER_TYPE", f"归属类型非法：{owner_type}")
    if kind not in FILE_KINDS:
        raise FileRuleError("BAD_FILE_KIND", f"文件用途非法：{kind}")

    if kind == "product_photo":
        if not media_kind:
            raise FileRuleError("MEDIA_KIND_REQUIRED", "产品图片必须选类型（生产/尺寸/重量/成品）")
        if media_kind not in MEDIA_KINDS:
            raise FileRuleError("BAD_MEDIA_KIND", f"产品图类型非法：{media_kind}")
    elif media_kind and media_kind not in MEDIA_KINDS:
        raise FileRuleError("BAD_MEDIA_KIND", f"产品图类型非法：{media_kind}")

    label = (name or "").strip()
    if not label:
        raise FileRuleError("NAME_REQUIRED", "图片必须命名（用户要求：上传后给图片起名）")
    if len(label) > 80:
        raise FileRuleError("NAME_TOO_LONG", "名称最长 80 个字符")

    mime = (content_type or "").split(";")[0].strip().lower()
    allowed = KIND_MIME[kind]
    if mime not in allowed:
        raise FileRuleError(
            "BAD_CONTENT_TYPE",
            f"{kind} 只接受 {'/'.join(sorted(allowed))}，收到 {mime or '(空)'}",
        )

    limit = MAX_BYTES[kind]
    if size is None or size <= 0:
        raise FileRuleError("BAD_SIZE", "文件大小缺失或为 0")
    if size > limit:
        raise FileRuleError(
            "FILE_TOO_LARGE", f"超过上限 {limit // (1024 * 1024)}MB（实际 {size} 字节）"
        )


def object_key(
    *,
    tenant_id: str,
    owner_type: str,
    owner_id: Optional[str],
    kind: str,
    media_kind: Optional[str],
    sha256: str,
    content_type: Optional[str] = None,
    file_name: Optional[str] = None,
) -> str:
    """对象存储里的 key（**确定性**：同一份内容 + 同一归属 ⇒ 同一个 key，天然去重）。

    形如 `t/{租户}/{归属}/{归属id}/{用途}/{图片类型}/{sha256前16}{ext}`。
    为什么把 sha256 放进路径：同图重复上传不会产生第二份字节；且 key 可读、可审计。
    """
    def seg(value: Any, fallback: str = "-") -> str:
        text = _SAFE_SEGMENT.sub("_", str(value or "").strip())
        return text or fallback

    digest = (sha256 or "").strip().lower()[:16] or "nohash"
    parts = [
        "t", seg(tenant_id, "default"), seg(owner_type), seg(owner_id, "-"),
        seg(kind), seg(media_kind, "-"),
    ]
    return "/".join(parts) + f"/{digest}{file_ext(content_type, file_name)}"


def current_of(rows: list) -> Optional[dict]:
    """从一组同归属同用途的行里挑出"当前版本"（`is_current` 为真；没有则取版本号最大）。"""
    if not rows:
        return None
    for row in rows:
        if row.get("is_current"):
            return row
    return max(rows, key=lambda r: r.get("version") or 0)


def next_version(current: Optional[dict]) -> tuple[int, Optional[int]]:
    """盖章回传的"覆盖"语义：返回 `(新版本号, 被它取代的行 id)`。

    - 没有旧件 → `(1, None)`
    - 有旧件 → `(旧版本号 + 1, 旧行 id)`：旧行保留（`is_current=false`）留档，
      新行上位。**不是物理删除** —— 用户要求"留档"，出争议时要能拿出当时那一版。
    """
    if not current:
        return 1, None
    return int(current.get("version") or 1) + 1, current.get("id")


# ── 单证引用产品图：把 `{file_id}` 解析成图片源 ─────────────────────────────
#
# 口径：单证的 `product_photos` 允许两种条目混排 ——
#   1) 已是图片源：`{"image": "data:..." | "https://...", "caption": ...}`（原样透传，
#      向后兼容：老数据、离线 payload 都还能用）
#   2) **引用产品图库**：`{"file_id": 12, "caption": ...}` → 由装配层取字节转 data URI
#
# 为什么在装配层解析而不是渲染器：渲染器的图片白名单只认 `data:` 与 `http(s)`
# （那是防注入的设计，不放开），而 `{file_id}` 不是图片源 —— 解析放在喂给渲染器之前，
# 渲染器一行都不用改。

def coerce_file_ref_id(entry: Any) -> Optional[int]:
    """从 `{file_id: ...}` 取出**可信的正整数 id**；取不出来返回 `None`。

    为什么必须容错（实测缺陷）：`product_photos` 是**用户可写的 custom 字段**
    （`PROTECTED_CUSTOM_FIELDS` 只挡 `items`/`total_amount`）。库里写进一个非数字的
    `file_id`（如 `"abc"`）时，`int(entry["file_id"])` 会抛 `ValueError`，
    把 `/trade-docs/{id}/render-data` 直接打成 **500** —— 而设计意图是
    「取不到字节就跳过该条，不印坏图」，不是让整张单据的预览挂掉。

    布尔值必须挡掉：`True` 是 `int` 的子类，`int(True) == 1` 会被当成"第 1 个文件"。
    """
    if not isinstance(entry, dict):
        return None
    raw = entry.get("file_id")
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw if raw > 0 else None
    if isinstance(raw, str):
        text = raw.strip()
        if text.isdigit():
            value = int(text)
            return value if value > 0 else None
    return None


def is_file_ref(entry: Any) -> bool:
    """是不是"引用产品图库"的条目（有**可用**的 `file_id` 且没有直接给图源）。

    "可用"由 `coerce_file_ref_id` 定义 —— 同一个判定只此一处，
    避免「这里认为它是引用、那里 int() 又转不出来」的分叉。
    """
    if coerce_file_ref_id(entry) is None:
        return False
    return not entry.get("image") and not entry.get("src")


def to_data_uri(content_type: Optional[str], data: bytes, file_name: Optional[str] = None) -> str:
    """字节 → `data:` URI（渲染器把内联图片当作合法图源）。

    mime 缺失时按扩展名兜底；实在认不出就用 `application/octet-stream`
    （渲染器会因白名单把它丢掉 —— 这是有意的：宁可不显示，也不放来路不明的类型）。
    """
    import base64

    mime = ""
    if content_type:
        mime = content_type.split(";")[0].strip().lower()
    if not mime:
        ext = file_ext(None, file_name)
        mime = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp",
                "pdf": "application/pdf"}.get(ext.lstrip("."), "application/octet-stream")
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
