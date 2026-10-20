"""单证共享内核 —— orchestrator / Worker 共用的纯业务逻辑（G1 一份代码）。

模块：
- rules     状态机 / 派生前置（仅 issued 源）/ 确认必填 / 金额勾稽
- payload   字段合成（手工>派生>主体>默认）/ 快照冻结 / 方案物化
- docno     单号格式 {TYPE}-{YYYYMM}-{SEQ:04d}
- png       PNG 校验与尺寸解析（替代 Pillow，图像处理已挪前端）
- translate 翻译 prompt / 响应解析
- product_defaults 产品基础信息 → 单据行项默认值（一次维护、重复使用）
- render_fingerprint 签发时冻结的渲染输入指纹（C 方案：可复现可追溯）
- facts     事实层（A7）：事实模型 / 键值归一 / 信任级闸门 / 不可改写 / 单源推导 / TBC
- equivalents 等价措辞白名单（A7）：只在表内判等价，绝不静默吞差异
- consistency 一致性引擎（A7）：跨单证事实矩阵（diff_facts）/ 基线承继核对（lint_pair）
- trigger   单证清单触发条件（A12）：受限安全求值（**无 eval/exec**）/ doc-set 标注
- clause_templates 条款模板库（A5-W1）：默认 6 类 + doc_types 校验 + 按单证类型挑选
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
from .render_fingerprint import (  # noqa: F401
    RENDER_CHECK_CARD_FIELDS,
    RENDER_CHECK_CARD_UNAVAILABLE,
    RENDER_CHECK_DECIDED_BUCKETS,
    RENDER_CHECK_DOC_IDS_INVALID,
    RENDER_CHECK_DOC_IDS_LIMIT,
    RENDER_CHECK_DOC_IDS_REQUIRED,
    RENDER_CHECK_MAX_DOCS,
    RENDER_CHECK_SUMMARY_FIELDS,
    RENDER_CHECK_VERDICTS,
    RENDER_DIGEST_IGNORED_FIELDS,
    RENDER_KEY,
    RENDER_VERSION,
    RenderCheckBatchError,
    canonical_render_input,
    parse_render_check_doc_ids,
    read_render_fingerprint,
    render_check_card,
    render_fingerprint,
    render_fingerprint_check,
    render_input_digest,
    summarize_render_checks,
)
from .facts import (  # noqa: F401
    FACT_CONFLICT,
    FACT_EQUIVALENT_WORDING,
    FACT_IMMUTABLE,
    FACT_LABELS,
    FACT_MANUAL_AMOUNT,
    FACT_MISSING,
    FACT_UNVERIFIED,
    IMMUTABLE_KEYS,
    PACKING_ORIGIN_NONE,
    PACKING_ORIGIN_PRODUCT_DEFAULT,
    PACKING_ORIGIN_ROW,
    PACKING_ORIGIN_SNAPSHOT,
    PACKING_TYPES,
    SOURCE_AI,
    SOURCE_INFERRED,
    SOURCE_KINDS,
    SOURCE_MANUAL,
    SOURCE_PI,
    SOURCE_UPSTREAM,
    TBC,
    TBC_EN,
    TBC_ZH,
    TRUST_CONFIRMED,
    TRUST_INFERRED,
    TRUST_LEVELS,
    TRUST_UNVERIFIED,
    Fact,
    PaymentTermPart,
    RuleViolation,
    amount_tolerance,
    assert_no_manual_amount,
    check_derived_amount,
    check_immutable,
    classify_packing_type,
    confirm_fact,
    decimal_text,
    derive_amount,
    derive_unit_price,
    extract_facts,
    fact_kind,
    fact_label,
    gate_trust,
    normalize_fact_key,
    normalize_fact_value,
    parse_payment_terms,
    render_tbc,
    values_equal,
)
from .equivalents import (  # noqa: F401
    EQUIVALENT_GROUPS,
    INCO_TERMS,
    TIMING_GROUPS,
    AmountParts,
    IncotermParts,
    amount_parts,
    canonical_phrase,
    date_parts,
    equivalent_text,
    incoterm_equivalent,
    incoterm_parts,
    normalize_text,
    timing_canonical,
    timing_match,
    payment_clause_signature,
)
from .consistency import (  # noqa: F401
    IDENTITY_KEYS,
    FactCheck,
    FactDiff,
    diff_facts,
    equivalent,
    lint_pair,
)
from .trigger import (  # noqa: F401
    MAX_DEPTH,
    MAX_EXPR_LENGTH,
    MAX_TOKENS,
    TRIGGER_SYNTAX,
    TRIGGER_TOO_COMPLEX,
    TRIGGER_TYPE,
    TRIGGER_UNKNOWN_KEY,
    TriggerError,
    evaluate_trigger,
    parse_trigger,
    resolve_doc_set,
    validate_trigger,
)
from .clause_templates import (  # noqa: F401
    CLAUSE_DOC_TYPE_SET,
    CLAUSE_NAME_MAX,
    CLAUSE_TEXT_MAX,
    DEFAULT_CLAUSE_CATEGORIES,
    DEFAULT_CLAUSE_TEMPLATES,
    ClauseTemplateError,
    default_seed_rows,
    is_valid_doc_type,
    normalize_doc_types,
    pick_for_doc_type,
    validate_clause_template,
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
    "RENDER_KEY", "RENDER_VERSION", "RENDER_DIGEST_IGNORED_FIELDS", "RENDER_CHECK_VERDICTS",
    "canonical_render_input", "render_input_digest", "render_fingerprint",
    "render_fingerprint_check", "read_render_fingerprint",
    "RENDER_CHECK_MAX_DOCS", "RENDER_CHECK_CARD_FIELDS", "RENDER_CHECK_CARD_UNAVAILABLE",
    "RENDER_CHECK_DECIDED_BUCKETS", "RENDER_CHECK_DOC_IDS_INVALID",
    "RENDER_CHECK_DOC_IDS_LIMIT", "RENDER_CHECK_DOC_IDS_REQUIRED",
    "RENDER_CHECK_SUMMARY_FIELDS", "RenderCheckBatchError",
    "parse_render_check_doc_ids", "render_check_card", "summarize_render_checks",
    # ── A7 事实层（facts）──
    "SOURCE_KINDS", "TRUST_LEVELS", "FACT_LABELS", "IMMUTABLE_KEYS",
    "SOURCE_PI", "SOURCE_UPSTREAM", "SOURCE_MANUAL", "SOURCE_AI", "SOURCE_INFERRED",
    "TRUST_CONFIRMED", "TRUST_UNVERIFIED", "TRUST_INFERRED",
    "FACT_CONFLICT", "FACT_UNVERIFIED", "FACT_IMMUTABLE", "FACT_MANUAL_AMOUNT",
    "FACT_MISSING", "FACT_EQUIVALENT_WORDING",
    "TBC", "TBC_ZH", "TBC_EN",
    "Fact", "RuleViolation", "PaymentTermPart",
    "normalize_fact_key", "normalize_fact_value", "fact_kind", "fact_label",
    "decimal_text", "values_equal", "amount_tolerance",
    "extract_facts", "parse_payment_terms", "confirm_fact",
    "gate_trust", "check_immutable",
    "derive_amount", "derive_unit_price", "assert_no_manual_amount", "check_derived_amount",
    "render_tbc",
    # ── A14 包装事实（packing_method/packing_type 归类）──
    "PACKING_TYPES", "PACKING_ORIGIN_ROW", "PACKING_ORIGIN_PRODUCT_DEFAULT",
    "PACKING_ORIGIN_SNAPSHOT", "PACKING_ORIGIN_NONE", "classify_packing_type",
    # ── A7 等价措辞白名单（equivalents）──
    "EQUIVALENT_GROUPS", "TIMING_GROUPS", "INCO_TERMS",
    "IncotermParts", "AmountParts",
    "normalize_text", "canonical_phrase", "timing_canonical",
    "timing_match", "payment_clause_signature",
    "incoterm_parts", "incoterm_equivalent", "amount_parts", "date_parts",
    "equivalent_text",
    # ── A7 一致性引擎（consistency）──
    "IDENTITY_KEYS", "FactDiff", "FactCheck",
    "diff_facts", "lint_pair", "equivalent",
    # ── A12 单证清单触发条件（trigger，受限求值）──
    "TriggerError", "TRIGGER_SYNTAX", "TRIGGER_UNKNOWN_KEY", "TRIGGER_TYPE",
    "TRIGGER_TOO_COMPLEX", "MAX_EXPR_LENGTH", "MAX_TOKENS", "MAX_DEPTH",
    "evaluate_trigger", "validate_trigger", "parse_trigger", "resolve_doc_set",
    # ── A5-W1 条款模板库（clause_templates）──
    "ClauseTemplateError", "DEFAULT_CLAUSE_TEMPLATES", "DEFAULT_CLAUSE_CATEGORIES",
    "CLAUSE_DOC_TYPE_SET", "CLAUSE_NAME_MAX", "CLAUSE_TEXT_MAX",
    "normalize_doc_types", "is_valid_doc_type", "validate_clause_template",
    "default_seed_rows", "pick_for_doc_type",
]
