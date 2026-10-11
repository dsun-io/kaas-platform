"""单证共享内核 —— orchestrator / Worker 共用的纯业务逻辑（G1 一份代码）。

模块：
- rules     状态机 / 派生前置（仅 issued 源）/ 确认必填 / 金额勾稽
- payload   字段合成（手工>派生>主体>默认）/ 快照冻结 / 方案物化
- docno     单号格式 {TYPE}-{YYYYMM}-{SEQ:04d}
- png       PNG 校验与尺寸解析（替代 Pillow，图像处理已挪前端）
- translate 翻译 prompt / 响应解析
- product_defaults 产品基础信息 → 单据行项默认值（一次维护、重复使用）
"""
from .rules import (  # noqa: F401
    DOC_STATUS,
    DOC_NEXT,
    RuleError,
    ItemCheck,
    assert_draft,
    assert_derivable,
    assert_transition,
    can_transition,
    check_line_amount,
    line_amount,
    to_decimal,
    validate_confirm,
    validate_items,
)
from .payload import (  # noqa: F401
    apply_scheme,
    compose_fields,
    deep_merge,
    derive_payload,
    freeze_snapshot,
    normalize_items,
    resolve_scheme,
    scheme_names,
)
from .docno import doc_no_prefix, format_doc_no, month_of, DOC_TYPE_PREFIX  # noqa: F401
from .payload_shared import (  # noqa: F401
    AUDIT_KEY,
    PROTECTED_CUSTOM_FIELDS,
    append_audit,
    diff_custom,
    protected_custom_fields,
)
from .png import PngError, is_png, png_size, validate_seal_image, MAX_SEAL_BYTES  # noqa: F401
from .translate import SYSTEM_PROMPT, build_messages, parse_translation  # noqa: F401
from .product_defaults import (  # noqa: F401
    HS_ITEM_DOC_TYPES,
    PRODUCT_INFO_KEYS,
    PRODUCT_KEY_FIELD,
    apply_product_defaults,
    product_key_of,
)

__all__ = [
    "DOC_STATUS", "DOC_NEXT", "DOC_TYPE_PREFIX", "MAX_SEAL_BYTES", "SYSTEM_PROMPT",
    "RuleError", "ItemCheck", "PngError",
    "assert_draft", "assert_derivable", "assert_transition", "can_transition",
    "check_line_amount", "line_amount", "to_decimal", "validate_confirm", "validate_items",
    "apply_scheme", "compose_fields", "deep_merge", "derive_payload",
    "freeze_snapshot", "normalize_items", "resolve_scheme", "scheme_names",
    "doc_no_prefix", "format_doc_no", "month_of",
    "is_png", "png_size", "validate_seal_image",
    "build_messages", "parse_translation",
    "PRODUCT_KEY_FIELD", "PRODUCT_INFO_KEYS", "HS_ITEM_DOC_TYPES",
    "product_key_of", "apply_product_defaults",
]
