"""文件域共享内核 —— orchestrator 与 Worker 共用**一份**（G1 原则）。

模块：
- `rules`  文件归属/用途校验、对象存储 key 规划、版本化（盖章回传覆盖旧件）

设计见 `docs/PRODUCT_MEDIA_STORAGE_PLAN.md`。
"""
from .rules import (  # noqa: F401
    FILE_KINDS,
    KIND_MIME,
    MAX_BYTES,
    MEDIA_KINDS,
    MEDIA_KIND_LABELS,
    OWNER_TYPES,
    FileRuleError,
    current_of,
    file_ext,
    is_file_ref,
    next_version,
    object_key,
    to_data_uri,
    validate_upload,
)
from .s3 import (  # noqa: F401
    SigV4Error,
    presign_get_url,
    presign_put_url,
    presign_url,
    s3_config,
)

__all__ = [
    "OWNER_TYPES", "FILE_KINDS", "MEDIA_KINDS", "MEDIA_KIND_LABELS",
    "KIND_MIME", "MAX_BYTES", "FileRuleError",
    "validate_upload", "object_key", "file_ext", "next_version", "current_of",
    "is_file_ref", "to_data_uri",
    "SigV4Error", "presign_url", "presign_put_url", "presign_get_url", "s3_config",
]
