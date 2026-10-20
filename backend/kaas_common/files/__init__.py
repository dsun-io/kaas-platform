"""文件域共享内核 —— orchestrator 与 Worker 共用**一份**（G1 原则）。

模块：
- `rules`       文件归属/用途校验、对象存储 key 规划、版本化（盖章回传覆盖旧件）
- `seal`        公司默认公章的渲染回落判定（单据没显式给章时用租户默认章）
- `render_pdf`  自动出 PDF（Browser Rendering）的共享判定：配置解析、入参 HTML 安全校验、PDF 魔数

设计见 `docs/PRODUCT_MEDIA_STORAGE_PLAN.md` 与 `docs/TRADE_DOC_PDF_ARCHIVAL.md`。
"""
from .rules import (  # noqa: F401
    FILE_KINDS,
    KIND_MIME,
    MAX_BYTES,
    MEDIA_KINDS,
    MEDIA_KIND_LABELS,
    OWNER_TYPES,
    FileRuleError,
    coerce_file_ref_id,
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
from .seal import (  # noqa: F401
    SEAL_FIELD,
    apply_default_seal,
    seal_data_uri,
    seal_field,
)
from .render_pdf import (  # noqa: F401
    ALLOWED_HOSTS_ENV_KEY,
    BROWSER_RENDERING_QUICK_ACTION_PATH,
    CLOUDFLARE_API_ORIGIN,
    DEFAULT_ALLOWED_HOSTS,
    MAX_RENDER_HTML_BYTES,
    MAX_RENDER_PDF_BYTES,
    PDF_MAGIC,
    RENDERER_NOT_CONFIGURED_DETAIL,
    RENDER_PDF_KIND,
    allowed_html_hosts,
    host_allowed,
    looks_like_pdf,
    render_pdf_rest_config,
    render_pdf_rest_url,
    validate_render_html,
)

from .token import (  # noqa: F401
    DEFAULT_ASSET_TTL,
    make_asset_token,
    verify_asset_token,
)

__all__ = [
    "OWNER_TYPES", "FILE_KINDS", "MEDIA_KINDS", "MEDIA_KIND_LABELS",
    "KIND_MIME", "MAX_BYTES", "FileRuleError",
    "validate_upload", "object_key", "file_ext", "next_version", "current_of",
    "is_file_ref", "to_data_uri", "coerce_file_ref_id",
    "SEAL_FIELD", "seal_field", "seal_data_uri", "apply_default_seal",
    "SigV4Error", "presign_url", "presign_put_url", "presign_get_url", "s3_config",
    "RENDER_PDF_KIND", "MAX_RENDER_PDF_BYTES", "MAX_RENDER_HTML_BYTES", "PDF_MAGIC",
    "CLOUDFLARE_API_ORIGIN", "BROWSER_RENDERING_QUICK_ACTION_PATH",
    "RENDERER_NOT_CONFIGURED_DETAIL",
    "ALLOWED_HOSTS_ENV_KEY", "DEFAULT_ALLOWED_HOSTS",
    "allowed_html_hosts", "host_allowed",
    "validate_render_html", "looks_like_pdf",
    "render_pdf_rest_config", "render_pdf_rest_url",
    "DEFAULT_ASSET_TTL", "make_asset_token", "verify_asset_token",
]
