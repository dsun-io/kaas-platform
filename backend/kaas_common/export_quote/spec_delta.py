"""产品定义的「差异覆盖」合并 —— **纯标准库、零三方依赖**（可在 Pyodide 里跑）。

为什么要有它（不是重复造轮子）
==============================

`spec_from_dict()` 是**整体构造**，不是合并器（已核实）：

- 缺字段**静默取默认值**（`data.get("axes") or []`）；
- 字段改名**静默退化**（取不到就落默认，不报错）；
- 列表传 `null` 与不传**等价**。

拿它当"上游 spec ⊕ 团队差异"的合并器，会把**「用户没设」与「用户设成了默认值」混为一谈** ——
而这两件事在"团队私有 + 存差异"的模型里必须分得清。

本模块把这件事**显式化**：每个字段的三种状态（缺失 / 显式 `null` / 有值）各有确定语义，
未知字段、未知版本、身份字段被覆盖、以及互相矛盾的指令**一律报错**（不静默）。

语义模板来自既有实现（不发明新语义）
====================================

- **选项层**（改显示名 / 软停用）直接复用 `models.apply_option_overrides`
  —— 与线上算价路径（`app/api/export_quote.py` 的 `_with_team_overrides`）**是同一份实现**，
  因此不存在"差异合并与线上行为分叉"的可能。
- **"取消覆盖"的写法**与 `services/option_overrides.py` 的 `merge_override` 同构：
  那边是"改名传空串 = 取消改名"，这边是"字段传 `null` = 取消覆盖、回落上游"。

三种状态（**这是本模块的核心契约**）
====================================

====================  ==========================================================
`scalars` / `structs` / `lists` 的取值
------------------------------------------------------------------------------
**缺失**（键不出现）  **不覆盖** —— 取上游的值。上游以后改了，跟着变。
**显式 `null`**       **取消覆盖** —— 回落上游（等价于"这条差异不存在"）。
**有值**              **覆盖**。列表给 `[]` 就是**显式清空**（≠ 未覆盖，也 ≠ `null`）。
====================  ==========================================================

`add` 与 `remove` 是**按条目的外科手术**：

- 条目身份 = `item["key"] or item["name"]`（`Column`/`NumericInput`/`PieceInput` 用 `key`，
  `FormulaSpec`/`Axis`/`VariantGroup`/`Invariant` 用 `name`）。两者都没有 ⇒ 报错。
- `remove` 指向**已不存在**的条目：幂等 no-op，但会进 `DeltaReport.missing_removals`
  （**warning，不静默** —— 通常意味着上游改过名，需要人工复核）。
- `add` 的条目身份**已存在**：**报错**（否则是歧义重复，静默追加会让下游取到哪一条不确定）。
- **标量列表**（`notes` / `hs_codes`）**不支持** `add`/`remove`：它们的元素是字符串，没有
  `key`/`name` 可定位的身份 ⇒ 一律**报错并说明"仅支持整体替换"**（不静默、不按值增删）。

闸门（两条，都不许"尽力而为"）
==============================

- `spec_version`：不认识就报错（字段级改名靠它兜底，而不是靠猜）。
- `base_spec_hash`：给了就必须匹配 `spec_fingerprint(上游 spec)`，否则报错
  —— **上游已变更 ⇒ 拒绝合并并要求人工复核**，绝不静默套用。

字段改名怎么办
==============

1. **载荷里出现未知字段** ⇒ 报错，并把已知字段列出来；
2. 调用方若确知某次改名，可用 `field_aliases={"旧名": "新名"}` **显式映射**，
   用到的映射会进 `DeltaReport.aliases_used`（留痕）；
3. 本模块**不做任何自动猜测**。
"""
from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import asdict, dataclass, field
from typing import Any, Mapping, Optional

from .models import ProductSpec, VariantGroup, apply_option_overrides

__all__ = [
    "SPEC_DELTA_VERSION",
    "SUPPORTED_SPEC_DELTA_VERSIONS",
    "SCALAR_FIELDS",
    "STRUCT_FIELDS",
    "LIST_FIELDS",
    "SCALAR_LIST_FIELDS",
    "FORBIDDEN_FIELDS",
    "SpecDeltaError",
    "DeltaReport",
    "normalize_delta",
    "apply_delta",
    "spec_fingerprint",
    "item_identity",
]


# ── 契约常量 ────────────────────────────────────────────────────────────────

SPEC_DELTA_VERSION = 1
SUPPORTED_SPEC_DELTA_VERSIONS = (1,)

#: 可整体覆盖的**标量**字段（`ProductSpec` 的简单字段）
SCALAR_FIELDS = frozenset({
    "name", "name_en", "category_code",
    "cost_field", "cost_basis", "cost_unit",
    "profit_mode", "profit_value", "misc_fee_rate",
})

#: 可整体覆盖的**结构化**字段（dict）
STRUCT_FIELDS = frozenset({"space_deduction", "constants"})

#: 可整体覆盖 / 按条目增删的**列表**字段
LIST_FIELDS = frozenset({
    "axes", "variants", "derived",
    "piece_metrics", "order_metrics", "columns", "invariants",
    "params", "piece_inputs", "numeric_inputs", "pricing_key",
    "notes", "hs_codes", "packaging",
})

#: **标量列表**字段（元素是字符串，不是带 `key`/`name` 的对象）——
#: 只支持 `lists.<字段>` **整体替换**（含 `[]` 显式清空 / `null` 取消覆盖），
#: **不支持** `add` / `remove` 按条目增删（标量没有可定位的身份字段）。
SCALAR_LIST_FIELDS = frozenset({"notes", "hs_codes"})

#: **禁止**被覆盖的字段：身份。`key` 是查表键，被改了整条链都指向别处。
FORBIDDEN_FIELDS = frozenset({"key"})

_KNOWN_FIELDS = SCALAR_FIELDS | STRUCT_FIELDS | LIST_FIELDS | FORBIDDEN_FIELDS

#: 差异载荷允许出现的顶层键（除此之外一律报错）
_DELTA_KEYS = frozenset({
    "spec_version", "base_spec_hash",
    "scalars", "structs", "lists", "add", "remove", "options",
})

#: 选项层允许的键 —— 与 `services/option_overrides.py` 的 `ALLOWED_KEYS` 逐字一致
_OPTION_KEYS = ("rename", "disabled")


class SpecDeltaError(ValueError):
    """差异载荷非法：未知字段 / 未知版本 / 哈希不匹配 / 结构矛盾。

    刻意**不**提供"尽力而为"的降级路径 —— 静默退化正是本模块要消灭的东西。
    """


# ── 指纹 ────────────────────────────────────────────────────────────────────

def spec_fingerprint(spec: Mapping[str, Any]) -> str:
    """上游 spec 的指纹（`sha256:<hex>`）。

    用**规范化 JSON**（`sort_keys`）算，所以同一个 spec 只要值相同就得到同一个指纹，
    与字段书写顺序无关。`default=str` 让 Decimal 之类的值也能参与（不会抛异常）。
    """
    payload = json.dumps(dict(spec), sort_keys=True, ensure_ascii=False, default=str)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


# ── 条目身份 ────────────────────────────────────────────────────────────────

def item_identity(item: Any) -> str:
    """列表条目的身份：`key` 优先，其次 `name`。

    两者都没有 ⇒ 报错。**不退回索引** —— 按位置删会在上游插入/重排后删错东西。
    """
    if not isinstance(item, Mapping):
        raise SpecDeltaError(
            f"列表条目必须是对象（dict），实际是 {type(item).__name__}")
    for k in ("key", "name"):
        v = item.get(k)
        if isinstance(v, str) and v:
            return v
    raise SpecDeltaError(
        "列表条目没有可用于定位的身份：需要 `key` 或 `name` 之一（非空字符串）")


# ── 结果报告 ────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class DeltaReport:
    """合并过程的可核对记录 —— **每个字段到底发生了什么**。

    为什么要它：差异合并最危险的失败是"看着合并成功了，其实某个字段没生效"。
    把 applied / cleared / added / removed / missing_removals 全部回出来，
    调用方（接口层）就能把 warning 直接展示给业务，而不是让他们自己猜。
    """

    scalars_applied: dict[str, Any] = field(default_factory=dict)
    structs_applied: tuple[str, ...] = ()
    lists_replaced: dict[str, int] = field(default_factory=dict)
    added: dict[str, int] = field(default_factory=dict)
    removed: dict[str, int] = field(default_factory=dict)
    options_applied: tuple[str, ...] = ()
    cleared: tuple[str, ...] = ()
    missing_removals: tuple[str, ...] = ()
    aliases_used: dict[str, str] = field(default_factory=dict)
    version: int = SPEC_DELTA_VERSION

    def warnings(self) -> list[str]:
        """需要业务/管理员看一眼的情况（**不阻断合并**，但绝不静默）。"""
        out = []
        for entry in self.missing_removals:
            out.append(
                f"差异要求删除的条目在上游已不存在：{entry} —— "
                f"上游可能改过名，请人工复核这条差异是否还有效")
        return out

    @property
    def is_empty(self) -> bool:
        """这份差异是否什么都没做（全 `null` / 空载荷）。"""
        return not (
            self.scalars_applied or self.structs_applied or self.lists_replaced
            or self.added or self.removed or self.options_applied
        )


# ── 归一化（严格） ──────────────────────────────────────────────────────────

def _require_mapping(value: Any, where: str) -> dict:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise SpecDeltaError(f"`{where}` 必须是对象（dict），实际是 {type(value).__name__}")
    return dict(value)


def _resolve_field(
    raw_name: Any, field_aliases: Optional[Mapping[str, str]], used: dict[str, str]
) -> str:
    """字段名 → 规范字段名；未知一律报错（支持**显式** alias）。"""
    if not isinstance(raw_name, str) or not raw_name:
        raise SpecDeltaError(f"字段名必须是非空字符串，实际是 {raw_name!r}")
    name = raw_name
    if field_aliases and name in field_aliases:
        name = field_aliases[name]
        used[raw_name] = name
    if name in FORBIDDEN_FIELDS:
        raise SpecDeltaError(
            f"`{name}` 是身份字段，不允许被差异覆盖 —— "
            f"它是查表键，改了会让定价数据与历史报价单指向别处")
    if name not in _KNOWN_FIELDS:
        known = ", ".join(sorted(_KNOWN_FIELDS))
        raise SpecDeltaError(
            f"未知字段 `{name}`。已知字段：{known}。"
            f"若它确实是被改名过（上游或载荷新旧版本），请用 `field_aliases` **显式**映射；"
            f"本模块不做自动猜测")
    return name


def normalize_delta(
    raw: Optional[Mapping[str, Any]],
    *,
    field_aliases: Optional[Mapping[str, str]] = None,
) -> dict:
    """把外部来的差异载荷收敛成规范形状；**任何不认识的东西都报错**。

    规范形状::

        {
          "spec_version": 1,
          "base_spec_hash": "sha256:…" | None,
          "scalars": {字段: 值 | None},
          "structs": {字段: dict | None},
          "lists":   {字段: list | None},
          "add":     {字段: [条目, …]},
          "remove":  {字段: [身份, …]},
          "options": {变体包 key: {"rename": {...}, "disabled": [...]}},
        }
    """
    used: dict[str, str] = {}
    if raw is None:
        return {
            "spec_version": SPEC_DELTA_VERSION, "base_spec_hash": None,
            "scalars": {}, "structs": {}, "lists": {},
            "add": {}, "remove": {}, "options": {},
            "_aliases_used": {},
        }
    if not isinstance(raw, Mapping):
        raise SpecDeltaError(f"差异载荷必须是对象（dict），实际是 {type(raw).__name__}")

    unknown_top = sorted(set(raw) - _DELTA_KEYS)
    if unknown_top:
        raise SpecDeltaError(
            f"差异载荷出现未知顶层键：{', '.join(unknown_top)}；"
            f"允许的是：{', '.join(sorted(_DELTA_KEYS))}")

    version = raw.get("spec_version", SPEC_DELTA_VERSION)
    if version not in SUPPORTED_SPEC_DELTA_VERSIONS:
        raise SpecDeltaError(
            f"不认识的 `spec_version`={version!r}；支持 {SUPPORTED_SPEC_DELTA_VERSIONS}。"
            f"版本升级必须走一次性转换，不允许'尽力而为'地套用")

    base_hash = raw.get("base_spec_hash")
    if base_hash is not None and not isinstance(base_hash, str):
        raise SpecDeltaError(f"`base_spec_hash` 必须是字符串或 null，实际是 {type(base_hash).__name__}")

    scalars_raw = _require_mapping(raw.get("scalars"), "scalars")
    structs_raw = _require_mapping(raw.get("structs"), "structs")
    lists_raw = _require_mapping(raw.get("lists"), "lists")
    add_raw = _require_mapping(raw.get("add"), "add")
    remove_raw = _require_mapping(raw.get("remove"), "remove")
    options_raw = _require_mapping(raw.get("options"), "options")

    scalars: dict[str, Any] = {}
    for k, v in scalars_raw.items():
        name = _resolve_field(k, field_aliases, used)
        if name in STRUCT_FIELDS or name in LIST_FIELDS:
            raise SpecDeltaError(
                f"`{name}` 是{'结构化' if name in STRUCT_FIELDS else '列表'}字段，"
                f"不能写在 `scalars` 里（应写 `structs` / `lists`）")
        scalars[name] = v

    structs: dict[str, Any] = {}
    for k, v in structs_raw.items():
        name = _resolve_field(k, field_aliases, used)
        if name not in STRUCT_FIELDS:
            raise SpecDeltaError(f"`{name}` 不是结构化字段（`structs` 只接受：{', '.join(sorted(STRUCT_FIELDS))}）")
        if v is not None and not isinstance(v, Mapping):
            raise SpecDeltaError(f"`structs.{name}` 必须是对象或 null，实际是 {type(v).__name__}")
        structs[name] = None if v is None else dict(v)

    lists: dict[str, Optional[list]] = {}
    for k, v in lists_raw.items():
        name = _resolve_field(k, field_aliases, used)
        if name not in LIST_FIELDS:
            raise SpecDeltaError(f"`{name}` 不是列表字段（`lists` 只接受列表字段）")
        if v is None:
            lists[name] = None
        elif isinstance(v, (list, tuple)):
            lists[name] = list(v)
        else:
            hint = (f"它只支持整体替换（含 `[]` 清空 / `null` 取消）"
                    if name in SCALAR_LIST_FIELDS else
                    f"想按条目增删请用 `add` / `remove`")
            raise SpecDeltaError(
                f"`lists.{name}` 必须是数组或 null；{hint}（实际是 {type(v).__name__}）")

    add: dict[str, list] = {}
    for k, v in add_raw.items():
        name = _resolve_field(k, field_aliases, used)
        if name in SCALAR_LIST_FIELDS:
            raise SpecDeltaError(
                f"`add.{name}` 不支持按条目增删 —— `{name}` 是标量列表"
                f"（元素是字符串，没有 key/name 可定位的身份）。"
                f"它仅支持整体替换：用 `lists.{name}` 给出完整新列表"
                f"（含 `[]` 显式清空、`null` 取消覆盖并回落上游）")
        if name not in LIST_FIELDS:
            raise SpecDeltaError(f"`add.{name}` 只能对列表字段使用")
        if not isinstance(v, (list, tuple)) or not v:
            raise SpecDeltaError(f"`add.{name}` 必须是非空数组")
        add[name] = list(v)

    remove: dict[str, list] = {}
    for k, v in remove_raw.items():
        name = _resolve_field(k, field_aliases, used)
        if name in SCALAR_LIST_FIELDS:
            raise SpecDeltaError(
                f"`remove.{name}` 不支持按条目增删 —— `{name}` 是标量列表"
                f"（元素是字符串，没有 key/name 可定位的身份）。"
                f"它仅支持整体替换：用 `lists.{name}` 给出完整新列表"
                f"（含 `[]` 显式清空、`null` 取消覆盖并回落上游）")
        if name not in LIST_FIELDS:
            raise SpecDeltaError(f"`remove.{name}` 只能对列表字段使用")
        if not isinstance(v, (list, tuple)) or not v:
            raise SpecDeltaError(f"`remove.{name}` 必须是非空数组（想清空整个列表请用 `lists.{name}: []`）")
        remove[name] = [str(x) for x in v]

    both = sorted((set(lists) & (set(add) | set(remove))) | (set(add) & set(remove)))
    if both:
        raise SpecDeltaError(
            f"同一字段既有整体替换又有按条增删（或同时 add+remove）：{', '.join(both)}；"
            f"两种指令的先后顺序没有唯一合理解释，请只保留一种")

    options: dict[str, dict] = {}
    for k, v in options_raw.items():
        if not isinstance(k, str) or not k:
            raise SpecDeltaError(f"`options` 的键必须是非空字符串，实际是 {k!r}")
        payload = _require_mapping(v, f"options.{k}")
        bad = sorted(set(payload) - set(_OPTION_KEYS))
        if bad:
            raise SpecDeltaError(
                f"`options.{k}` 出现未知键：{', '.join(bad)}；只允许 {_OPTION_KEYS}"
                f"（与 services/option_overrides.py 的 ALLOWED_KEYS 一致）")
        entry: dict[str, Any] = {}
        rename = payload.get("rename")
        if rename is not None:
            if not isinstance(rename, Mapping):
                raise SpecDeltaError(f"`options.{k}.rename` 必须是对象")
            # 与 option_overrides 同构：**值为空串 = 取消改名**（回到上游写法）
            cleaned = {str(kk): str(vv) for kk, vv in rename.items() if vv not in (None, "")}
            if cleaned:
                entry["rename"] = cleaned
        disabled = payload.get("disabled")
        if disabled is not None:
            if not isinstance(disabled, (list, tuple)):
                raise SpecDeltaError(f"`options.{k}.disabled` 必须是数组")
            codes = [str(x) for x in disabled]
            if codes:
                entry["disabled"] = codes
        if entry:
            options[k] = entry

    return {
        "spec_version": version,
        "base_spec_hash": base_hash,
        "scalars": scalars,
        "structs": structs,
        "lists": lists,
        "add": add,
        "remove": remove,
        "options": options,
        "_aliases_used": used,
    }


# ── 合并 ────────────────────────────────────────────────────────────────────

def _as_variant_groups(variants: Any) -> list[VariantGroup]:
    groups = []
    for v in variants or []:
        if not isinstance(v, Mapping):
            raise SpecDeltaError(f"`variants` 的条目必须是对象，实际是 {type(v).__name__}")
        try:
            groups.append(VariantGroup(**{k: vv for k, vv in v.items()}))
        except TypeError as exc:
            # 多字段/缺必填都到这里 —— **显式报错**，不静默丢掉这个变体包
            raise SpecDeltaError(
                f"`variants` 条目与 VariantGroup 不匹配（{exc}）；"
                f"上游若改过该结构，需要先升级 spec_version 并显式映射") from exc
    return groups


def _apply_options(variants: Any, options: Mapping[str, dict]) -> list[dict]:
    """选项层：**直接复用** `models.apply_option_overrides`（与线上算价同一份实现）。"""
    tmp = ProductSpec(key="_delta_probe", variants=_as_variant_groups(variants))
    merged = apply_option_overrides(tmp, dict(options))
    return [asdict(vg) for vg in merged.variants]


def _replace_list(base_list: Any, incoming: list) -> list:
    return list(incoming)


def _add_items(base_list: Any, items: list, *, field_name: str) -> list:
    out = list(base_list or [])
    existing = {item_identity(it) for it in out}
    for it in items:
        ident = item_identity(it)
        if ident in existing:
            raise SpecDeltaError(
                f"`add.{field_name}` 里 `{ident}` 在上游已存在 —— "
                f"静默追加会产生两条同身份条目，下游取哪一条不确定；"
                f"想改它请用 `lists.{field_name}` 整体替换")
        out.append(it)
        existing.add(ident)
    return out


def _remove_items(base_list: Any, identities: list, *, field_name: str) -> tuple[list, list]:
    out, missing = [], []
    wanted = {str(i) for i in identities}
    seen = set()
    for it in base_list or []:
        ident = item_identity(it)
        if ident in wanted:
            seen.add(ident)
            continue
        out.append(it)
    for ident in identities:
        if str(ident) not in seen:
            missing.append(f"{field_name}[{ident}]")
    return out, missing


def apply_delta(
    base: Mapping[str, Any],
    delta: Optional[Mapping[str, Any]],
    *,
    field_aliases: Optional[Mapping[str, str]] = None,
) -> tuple[dict, DeltaReport]:
    """把差异套到上游 spec 上，返回 `(新的 spec dict, 报告)`。

    - **不修改入参**（`base` 与 `delta` 都不会被就地改写）。
    - `base` 是上游 spec 的 **dict 形态**（`spec_to_dict` / JSONB 读出来的都行）。
    - `delta` 为 `None` / 空 ⇒ 原样返回 `base` 的深拷贝 + 空报告（"没有覆盖"）。
    - 任何非法情形都抛 `SpecDeltaError` —— **绝不静默降级**。
    """
    norm = normalize_delta(delta, field_aliases=field_aliases)
    merged = copy.deepcopy(dict(base))
    report_kwargs: dict[str, Any] = {"version": norm["spec_version"]}

    # 闸门 2：上游指纹（给了才校验）
    base_hash = norm["base_spec_hash"]
    if base_hash is not None:
        actual = spec_fingerprint(base)
        if base_hash != actual:
            raise SpecDeltaError(
                f"`base_spec_hash` 与上游不一致：差异写的是 {base_hash}，"
                f"当前上游是 {actual} —— 上游已变更，请人工复核这条差异后再合并"
                f"（本模块拒绝静默套用）")

    cleared: list[str] = []

    # ① 标量
    for name, value in norm["scalars"].items():
        if value is None:
            cleared.append(name)          # 取消覆盖 ⇒ 保持上游值
            continue
        merged[name] = value
    report_kwargs["scalars_applied"] = dict(norm["scalars"])

    # ② 结构化字段（整体替换）
    for name, value in norm["structs"].items():
        if value is None:
            cleared.append(name)
            continue
        merged[name] = copy.deepcopy(value)
    report_kwargs["structs_applied"] = tuple(norm["structs"])

    # ③ 列表：整体替换（`[]` = 显式清空；`null` = 取消覆盖）
    replaced: dict[str, int] = {}
    for name, value in norm["lists"].items():
        if value is None:
            cleared.append(name)
            continue
        merged[name] = _replace_list(merged.get(name), value)
        replaced[name] = len(value)
    report_kwargs["lists_replaced"] = replaced

    # ④ 追加
    added: dict[str, int] = {}
    for name, items in norm["add"].items():
        merged[name] = _add_items(merged.get(name), items, field_name=name)
        added[name] = len(items)
    report_kwargs["added"] = added

    # ⑤ 删除（不存在 ⇒ warning，不静默）
    removed: dict[str, int] = {}
    missing: list[str] = []
    for name, idents in norm["remove"].items():
        new_list, missing_here = _remove_items(merged.get(name), idents, field_name=name)
        merged[name] = new_list
        removed[name] = len(idents) - len(missing_here)
        missing.extend(missing_here)
    report_kwargs["removed"] = removed
    report_kwargs["missing_removals"] = tuple(missing)

    # ⑥ 选项层（改显示名 / 软停用）—— 复用线上实现
    options = norm["options"]
    if options:
        merged["variants"] = _apply_options(merged.get("variants"), options)
    report_kwargs["options_applied"] = tuple(options)

    report_kwargs["cleared"] = tuple(cleared)
    report_kwargs["aliases_used"] = dict(norm["_aliases_used"])
    return merged, DeltaReport(**report_kwargs)
