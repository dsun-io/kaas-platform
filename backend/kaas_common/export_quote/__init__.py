"""出口报价引擎（EXW / FCA / FOB / CFR / CIF）。

把「成本 → 进项税 → 退税让利 → 印花税 → 销项税 → 报价 → 贸易术语」
这条与产品无关的链路抽象出来，配合配置驱动的规格展开与公式引擎，
使换产品、换国家、换口径都不需要改引擎代码。

各层职责与依赖方向（单向，不循环）：

    products/     产品知识：规格轴、变体、公式、列、说明
    pricing.py    报价政策：价链、销项税、退税让利、印花税
    terms.py      贸易术语：EXW→CIF 阶梯、各档费用计价方式
    engine.py     组装：规格展开 → 派生 → 价链 → 术语 → 指标 → 列投影
    verify.py     三遍核验 + 关系式 + 阶梯
    report.py     输出：xlsx / csv / dict（内部与客户双投影）

用法::

    from kaas_common.export_quote import QuoteRequest, build, verify_all, product_keys

    req = QuoteRequest(
        product_key="field_fence",
        policy=policy,
        fx_rate="6.7019",
        orders=field_fence.order_specs((30000, 50000)),
    )
    result = build(req)
    report = verify_all(result)
    assert report.ok
"""
from .engine import (
    DEFAULT_VALIDITY_DAYS,
    EngineError,
    QuoteRequest,
    QuoteResult,
    Row,
    build,
    expand_specs,
    ladder_from_config,
    make_request_from_config,
    order_scopes,
    spec_from_partial,
)
from .importers import (
    ImportError_,
    ParsedTable,
    TemplateColumn,
    build_template_csv,
    build_template_xlsx,
    parse_table,
    read_table,
    template_columns,
    template_headers,
)
from .xlsx import read_xlsx
from .expr import ExpressionError, Formula, evaluate
from .formulas import (
    describe_calculations,
    describe_product,
    describe_space,
    worked_example,
)
from .models import (
    Axis,
    Column,
    FormulaSpec,
    Invariant,
    OrderSpec,
    ProductSpec,
    SpaceDeduction,
    VariantGroup,
)
from .numeric import DECIMAL, FRACTION, quantize, to_decimal
from .pricing import (
    DEFAULT_DECIMALS,
    ExtraFee,
    PricingError,
    PricingPolicy,
    Sensitivity,
    policy_from_dict,
)
from .products import get as get_product
from .products import has as has_product
from .products import keys as product_keys
from .report import (
    build_customer_view,
    build_internal_view,
    write_csv,
    write_xlsx,
)
from .terms import (
    FEE_MODES,
    FeeItem,
    TermLadder,
    TermRung,
    TermsError,
    ladder_from_dict,
)
from .verify import (
    Issue,
    VerificationReport,
    verify_all,
    verify_invariants,
    verify_precision,
    verify_roundtrip,
    verify_terms,
)

__all__ = [
    # 引擎
    "QuoteRequest", "QuoteResult", "Row", "build", "expand_specs", "order_scopes",
    "EngineError", "DEFAULT_VALIDITY_DAYS", "make_request_from_config",
    "ladder_from_config", "spec_from_partial",
    # 表格批量导入
    "parse_table", "read_table", "read_xlsx", "build_template_csv", "build_template_xlsx",
    "template_headers", "template_columns", "TemplateColumn",
    "ParsedTable", "ImportError_",
    # 表达式
    "Formula", "evaluate", "ExpressionError",
    # 计算逻辑说明
    "describe_product", "describe_space", "describe_calculations", "worked_example",
    # 模型
    "ProductSpec", "Axis", "VariantGroup", "FormulaSpec", "Column", "Invariant",
    "OrderSpec", "SpaceDeduction",
    # 数值
    "DECIMAL", "FRACTION", "quantize", "to_decimal",
    # 报价政策
    "PricingPolicy", "PricingError", "ExtraFee", "Sensitivity",
    "policy_from_dict", "DEFAULT_DECIMALS",
    # 产品
    "product_keys", "get_product", "has_product",
    # 贸易术语
    "TermLadder", "TermRung", "FeeItem", "TermsError", "FEE_MODES", "ladder_from_dict",
    # 核验
    "verify_all", "verify_precision", "verify_invariants", "verify_terms",
    "verify_roundtrip", "VerificationReport", "Issue",
    # 输出
    "write_xlsx", "write_csv", "build_internal_view", "build_customer_view",
]
