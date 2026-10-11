"""严格解析「草稿 ProductSpec」—— 结构出错**报错**，合法但缺字段**如实回报**（不静默）。

为什么要单独一层，而不是直接用 `spec_from_dict`
================================================

`spec_from_dict`（`tenant_products.py:19-44`）是**宽松构造**，三处"静默"：

1. **缺字段静默取默认** —— `data.get("name", "")`、`cost_field` 默认 `raw_price`、`profit_value` 默认 `0.06` …；
2. **顶层未知字段被忽略** —— 它只挑自己认识的键 ⇒ 把 `derived` 打成 `derivd`，公式**一条都不会算**，
   而响应看起来"正常"（只有默认字段），**没有任何信号**；
3. **列表 `null` 与缺失等价** —— `data.get("axes") or []`。

对"数据库里读出来的行"用宽松构造没问题（那份数据是我们自己写的）；
但**编辑器传来的草稿**是"人正在敲的半成品" ⇒ 静默会把**打错字段名/写坏公式**变成
"一份看起来正常的试算结果"，比报错危险得多（这正是 `spec_delta` 要消灭的那类问题）。

本模块的契约
============

- **结构错 ⇒ 抛 `SpecOverrideError`**（未知字段 / `null` / 类型不对 / `key` 与路径不符 / 嵌套结构不符）；
- **合法但缺字段 ⇒ 允许**（那确实等于"用默认值"），但把**被默认掉的字段名**放进
  `ParsedOverride.defaulted` ⇒ 调用方必须**如实回传**给用户（不静默）；
- `key` 由**路径参数**决定：草稿里若给了 `key`，必须与路径一致（不一致 ⇒ 报错，避免"试算的是 A、存的是 B"）。

纯标准库 + 同包相对导入（与 `spec_delta` 同规约：引擎包会被同步进 worker/Pyodide）。
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Mapping, Optional, Callable

from .models import NumericInput, PieceInput, ProductSpec
from .spec_delta import FORBIDDEN_FIELDS, LIST_FIELDS, SCALAR_FIELDS, STRUCT_FIELDS
from .tenant_products import spec_from_dict

__all__ = ["SpecOverrideError", "ParsedOverride", "parse_spec_override", "KNOWN_DRAFT_FIELDS"]

#: ⚠️ `spec_from_dict` **没有**构造这三个字段（实测：它只覆盖 22 个键）：
#: `numeric_inputs` / `piece_inputs` / `params` ⇒ 对"严格草稿"而言那正是要禁止的**静默丢弃**
#: （草稿里写了数值入参，试算时却一个都不认 ⇒ 公式"未定义变量"）。
#: 这里**手动带上**，并在构造后做一次"确实带上了"的兜底检查。
_CARRIED_MANUALLY: dict[str, Callable[[Any], list]] = {
    "numeric_inputs": lambda items: [NumericInput(**i) for i in items],
    "piece_inputs": lambda items: [PieceInput(**i) for i in items],
    "params": lambda items: list(items),      # [[参数, 取值, 单位, 说明], …] 原样透传
}

#: 草稿定义里允许出现的字段 = 标量 ∪ 结构化 ∪ 列表 ∪ {key}。
#: ⚠️ 这里**复用** `spec_delta` 的字段集合，避免"两份字段清单"（那是第二个真相源）。
#: `key` 在 spec_delta 里是**禁止覆盖**的身份字段（差异不许改身份），
#: 但在**定义**里它是必要的身份 ⇒ 本模块单独放行，并要求与路径一致。
KNOWN_DRAFT_FIELDS = frozenset(set(SCALAR_FIELDS) | set(STRUCT_FIELDS) | set(LIST_FIELDS) | {"key"})

assert not (FORBIDDEN_FIELDS - {"key"}), "spec_delta 新增了禁止字段，草稿白名单要同步复核"


class SpecOverrideError(ValueError):
    """草稿定义不合法（结构错）。带 `code` 便于接口层回 422 与前端定位。"""

    def __init__(self, code: str, message: str, field: Optional[str] = None):
        super().__init__(message)
        self.code = code
        self.field = field


@dataclass(frozen=True)
class ParsedOverride:
    """解析结果：构造好的 spec + **被默认掉的字段**（必须回传给用户，不许静默）。"""

    spec: ProductSpec
    defaulted: tuple[str, ...]
    provided: tuple[str, ...]


def parse_spec_override(raw: Any, *, product_key: str) -> ParsedOverride:
    """把请求里的草稿定义严格解析成 `ProductSpec`。

    Raises:
        SpecOverrideError: 结构不合法（未知字段 / `null` / 类型不对 / `key` 不符 / 嵌套不符）。
    """
    if raw is None:
        raise SpecOverrideError("spec_override_missing", "spec_override 不能为 null")
    if not isinstance(raw, Mapping):
        raise SpecOverrideError(
            "spec_override_not_object",
            f"spec_override 必须是对象（dict），实际是 {type(raw).__name__}")

    unknown = sorted(set(raw) - KNOWN_DRAFT_FIELDS)
    if unknown:
        raise SpecOverrideError(
            "spec_override_unknown_field",
            f"草稿定义出现未知字段：{', '.join(unknown)}。"
            f"已知字段：{', '.join(sorted(KNOWN_DRAFT_FIELDS))}。"
            f"（未知字段**不会**被忽略 —— 那会让'打错一个字段名'看起来像'算好了'）",
            field=unknown[0])

    draft_key = raw.get("key")
    if draft_key is not None and str(draft_key) != str(product_key):
        raise SpecOverrideError(
            "spec_override_key_mismatch",
            f"草稿里的 key={draft_key!r} 与路径上的 product_key={product_key!r} 不一致"
            f"（否则会出现「试算的是 A、保存的是 B」）",
            field="key")

    for name, value in raw.items():
        if value is None:
            raise SpecOverrideError(
                "spec_override_null_field",
                f"`{name}` 不能为 null：草稿是**定义**而不是差异，"
                f"缺字段请**不写**（取默认值），要清空列表请写 `[]`、要清空字典请写 `{{}}`",
                field=name)
        if name in LIST_FIELDS:
            if not isinstance(value, (list, tuple)):
                raise SpecOverrideError(
                    "spec_override_bad_type",
                    f"`{name}` 必须是数组，实际是 {type(value).__name__}", field=name)
            for i, item in enumerate(value):
                if not isinstance(item, Mapping):
                    raise SpecOverrideError(
                        "spec_override_bad_item",
                        f"`{name}[{i}]` 必须是对象，实际是 {type(item).__name__}", field=name)
        elif name in STRUCT_FIELDS:
            if not isinstance(value, Mapping):
                raise SpecOverrideError(
                    "spec_override_bad_type",
                    f"`{name}` 必须是对象，实际是 {type(value).__name__}", field=name)
        elif name in SCALAR_FIELDS:
            if isinstance(value, (list, tuple, Mapping, set)):
                raise SpecOverrideError(
                    "spec_override_bad_type",
                    f"`{name}` 是标量字段，不能是 {type(value).__name__}", field=name)

    # 到这里结构已合法；交给宽松构造（缺字段按默认值），并**把默认掉的字段回报出去**
    provided = tuple(sorted(str(k) for k in raw))
    defaulted = tuple(sorted(KNOWN_DRAFT_FIELDS - set(raw)))
    try:
        spec = spec_from_dict({**raw, "key": product_key})
        # `spec_from_dict` 不认的三个字段：手动带上（否则就是静默丢弃）
        manual = {name: build(raw[name])
                  for name, build in _CARRIED_MANUALLY.items() if name in raw}
        if manual:
            spec = replace(spec, **manual)
    except (TypeError, KeyError, ValueError, ArithmeticError) as exc:
        # 嵌套项（axis / formula / column / numeric_input …）字段不对会在这里冒出来 —— **显式报错**，不吞
        raise SpecOverrideError(
            "spec_override_invalid",
            f"草稿定义结构不合法：{type(exc).__name__}: {exc}") from exc

    # 兜底：确认"提供了的字段"真的进了 spec（防止将来 `spec_from_dict` 又吞字段而无人察觉）
    for name in manual:
        if not getattr(spec, name, None):
            raise SpecOverrideError(
                "spec_override_not_carried",
                f"内部错误：字段 `{name}` 没有被带进 ProductSpec（构造器漏了它）")

    return ParsedOverride(spec=spec, defaulted=defaulted, provided=provided)
