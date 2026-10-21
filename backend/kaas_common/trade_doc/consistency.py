"""一致性引擎（Consistency Kernel）—— 跨单证事实矩阵 + 基线承继核对（纯函数）。

为什么需要它
------------
单证是**一单多证**：一份交易的 PI / SC / CI / PL 各自成文，同一批事实要在四份文档里
各写一遍。2026-10-12 Tim 单复盘里 6 类实质错误中有一半是"同一事实在多份单证里各写各的"：

    #1 CI 写 `(Incoterms 2020)`、SC 只写 `DAP Yangzhou, Jiangsu, China`  → 版本丢了
    #2 PI/CI 写 `70% balance before dispatch`、SC 写 `upon dispatch (before delivery)` → 时点被改述
    #4 "PI 里的业务条款你不能更改"                                     → 派生单覆盖了基线

工位原有的校验全部是**单证内、字段级**的（空不空、qty×price 对不对），
跨单证、事实级、可信级的防线一条都没有。本模块补的正是这一层，对应方案 §4-B。
（离线原型：`check_pi_sc_ci.py` 的 54 条四列矩阵 = `diff_facts`；
`check_ct_vs_pi.py` 的 43 条承继核对 = `lint_pair`。）

两条铁律
--------
1. **绝不静默吞差异**：措辞等价只在 `equivalents.EQUIVALENT_GROUPS`（白名单）内成立，
   金额容差只在 `max(5 美分等值, 0.1%)` 内成立；其余差异一律作为
   `conflict` 上报，由人在界面上按"以基线为准"回填 —— 那是显式动作。
2. **基线优先**：交易域以 order（或 contract / PI）为根（`UNCERTAIN #17 ①` 裁决）；
   `diff_facts` 的基线默认取 `root` 指定的那份，`lint_pair` 的基线永远是
   `source_facts`（派生单对基线，方向不可反）。

交易域怎么定（`root` 参数）
--------------------------
`doc_facts` 是 `{doc_id: [Fact, ...]}`（doc_id 可以是单证 id、单号或 `"pi"`/`"ci"`
这类标签）。`root` 有两种用法，都支持：

- `root` 是 `doc_facts` 里的某个键（如 `root="pi"` 或 `root=17`）⇒ **它就是基线**；
- `root` 只是交易域的名字（默认 `"order"`，恰好不在 `doc_facts` 里）⇒ 基线取
  `doc_facts` 的**第一份**（dict 插入序 = 调用方给出的交易链顺序），并在
  每条 diff 上记下 `domain=root`。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Mapping, Optional, Sequence

from . import equivalents
from .facts import (
    FACT_CONFLICT,
    FACT_EQUIVALENT_WORDING,
    FACT_MISSING,
    Fact,
    amount_tolerance,
    check_immutable,
    decimal_text,
    fact_kind,
    fact_label,
    values_equal,
)
from .rules import ItemCheck

__all__ = [
    "IDENTITY_KEYS",
    "FactDiff",
    "FactCheck",
    "diff_facts",
    "lint_pair",
    "equivalent",
]

# 单证**自身**的身份事实：跨单证比较必然不同（CI 的发票号 ≠ PI 的 PI 号），
# 放进四列矩阵只会制造假冲突。交叉引用（"PI 号是否出现在每张单上"）属于
# 引用完整性层（§4-D）与 `pi_no` / `contract_no` 这类显式事实，不在这里比。
IDENTITY_KEYS: frozenset[str] = frozenset({"doc_no", "date"})

_STATUS_CODE: dict[str, str] = {
    "conflict": FACT_CONFLICT,
    "equivalent": FACT_EQUIVALENT_WORDING,
    "missing": FACT_MISSING,
}

_STATUS_LABEL: dict[str, str] = {
    "conflict": "冲突",
    "equivalent": "等价措辞",
    "missing": "缺失",
}


# ─── 数据结构 ─────────────────────────────────────────────────────────────

@dataclass
class FactDiff:
    """一条跨单证差异（同一事实键在交易域内的不一致）。

    `status` 三态对应产品形态（§4-B「✓ 一致 54 项 / ⚠ 等价措辞 2 项 / ✗ 冲突 1 项」）：

    - `conflict`   —— 真冲突：值不同且不在等价词表/容差内；
    - `equivalent` —— 措辞不同但**词表内**等价：不算冲突，但要让人看见
      （"绝不静默吞差异"：这行会出现在 ⚠ 分组里，而不是消失）；
    - `missing`    —— opt-in（`check_missing=True`）：某些单证没有这条事实。
    """

    key: str
    kind: str
    status: str
    values: dict[str, str] = field(default_factory=dict)
    baseline_doc: str = ""
    baseline_value: str = ""
    domain: str = ""
    detail_zh: str = ""
    tolerance: str = ""
    diff_amount: str = ""

    @property
    def code(self) -> str:
        """对应的错误码（`FACT_CONFLICT` / `FACT_EQUIVALENT_WORDING` / `FACT_MISSING`）。"""
        return _STATUS_CODE.get(self.status, FACT_CONFLICT)

    @property
    def docs(self) -> tuple[str, ...]:
        return tuple(self.values)

    @property
    def is_conflict(self) -> bool:
        return self.status == "conflict"

    def as_dict(self) -> dict:
        """给 API / 前端一致性页签的纯 dict。"""
        return {
            "key": self.key,
            "kind": self.kind,
            "status": self.status,
            "code": self.code,
            "domain": self.domain,
            "baseline_doc": self.baseline_doc,
            "baseline_value": self.baseline_value,
            "values": dict(self.values),
            "detail_zh": self.detail_zh,
            "tolerance": self.tolerance,
            "diff_amount": self.diff_amount,
        }


class FactCheck(ItemCheck):
    """一条事实的承继核对结果 —— `rules.ItemCheck` 的子类，额外带 key / status。

    为什么继承而不是另造结构：`ItemCheck`（`ok` + `issues`）已是两端共用的
    "校验结果"口径（`validate_items` / `validate_confirm` 都返回它），
    一致性引擎沿用同一形状，API 层不必为它写第二套序列化；
    `key` / `status` / `original` / `provided` 是核对矩阵需要的最小附加信息。
    """

    def __init__(
        self,
        key: str,
        *,
        ok: bool = True,
        status: str = "consistent",
        original: Optional[str] = None,
        provided: Optional[str] = None,
        issues: Optional[Sequence[str]] = None,
    ) -> None:
        super().__init__(ok=ok, issues=list(issues or []))
        self.key = key
        self.status = status
        self.original = original
        self.provided = provided

    def as_dict(self) -> dict:
        return {
            "key": self.key,
            "ok": self.ok,
            "status": self.status,
            "original": self.original,
            "provided": self.provided,
            "issues": list(self.issues),
        }


# ─── 语义等价入口 ─────────────────────────────────────────────────────────

def equivalent(a: Any, b: Any, extra: Optional[Mapping[str, Any]] = None) -> bool:
    """两条文本是否等价：**全局词表 + 租户增量**，归一化后再比。

    - 全局词表在 `equivalents.EQUIVALENT_GROUPS`（`kaas_common`，仅 internal 可改）；
    - 租户增量由**参数传入**（`extra={规范名: [措辞, ...]}`），内核不读库
      —— `UNCERTAIN #17 ②` 裁决"全局默认表 + 租户增量"，但读租户配置是 API 层的事；
    - 归一化覆盖大小写 / 空白 / 全半角 / 中英标点；
    - 结构化归一（Incoterms 版式、金额大小写、日期格式）见 `equivalents` 的模块注释。
    """
    return equivalents.equivalent_text(a, b, extra)


# ─── 跨单证事实矩阵 ───────────────────────────────────────────────────────

def _domain_currency(index: Mapping[str, Mapping[str, Fact]]) -> str:
    """交易域币种：取任一份单证的 `currency` 事实（用于金额容差的"5 美分等值"）。"""
    for facts in index.values():
        fact = facts.get("currency")
        if fact is not None and fact.value:
            return str(fact.value).upper()
    return ""


def _fmt_value(value: str) -> str:
    """详情里的值展示：长文本截断，避免一条 diff 撑爆日志。"""
    text = value if value is not None else ""
    return text if len(text) <= 120 else f"{text[:117]}..."


def diff_facts(
    doc_facts: Mapping[Any, Iterable[Fact]],
    root: Any = "order",
    *,
    currency: str = "",
    tolerance: bool = True,
    check_missing: bool = False,
    include_identity: bool = False,
    extra: Optional[Mapping[str, Any]] = None,
) -> list[FactDiff]:
    """同一交易域内，同 key 不同值 ⇒ 一条 diff（§4-B）。

    参数：
    - `doc_facts`：`{doc_id: [Fact, ...]}`；
    - `root`：基线单证的键，或交易域的名字（见模块注释的两种用法）；
    - `currency`：金额容差用的币种；不给则从域内的 `currency` 事实推断（再不行按 USD）；
    - `tolerance`：金额是否走容差（`False` = 金额也精确比较，审计/对账场景用）；
    - `check_missing`：是否报告"某份单证缺这条事实"（默认关：不同单证类型本来
      就不带同样的事实集，逐条报会淹没真冲突；**必填项**的缺失由确认必填
      `rules.validate_confirm` 与后续的单证清单层负责）；
    - `include_identity`：是否把 `doc_no` / `date` 这类身份事实也纳入比较（默认关）；
    - `extra`：租户增量词表（参数传入、内核不读库）。

    返回按 `key` 字典序、`key` 内按"基线在前"排列，**顺序稳定**（便于快照测试与前端渲染）。
    """
    if not isinstance(doc_facts, Mapping) or not doc_facts:
        return []

    docs: list[tuple[str, list[Fact]]] = [
        (str(doc_id), [fact for fact in (facts or []) if isinstance(fact, Fact)])
        for doc_id, facts in doc_facts.items()
    ]
    if len(docs) < 2:
        return []

    index: dict[str, dict[str, Fact]] = {
        doc_id: {fact.key: fact for fact in facts} for doc_id, facts in docs
    }
    root_key = str(root)
    if root_key in index:
        baseline_doc = root_key
    else:
        baseline_doc = docs[0][0]
    ordered_docs = [baseline_doc] + [doc_id for doc_id, _ in docs if doc_id != baseline_doc]
    domain_currency = str(currency or "").upper() or _domain_currency(index)

    all_keys: set[str] = set()
    for facts in index.values():
        all_keys.update(facts)
    if not include_identity:
        all_keys -= IDENTITY_KEYS

    diffs: list[FactDiff] = []
    for key in sorted(all_keys):
        present = [
            (doc_id, index[doc_id][key])
            for doc_id in ordered_docs
            if key in index[doc_id]
        ]
        if not present:
            continue
        base_doc, base_fact = present[0]
        kind = fact_kind(key)
        label_zh = fact_label(key)[0]

        # ── 有效比较的字段：容差按事实自带的币种，其次域币种
        currency_for_key = str(base_fact.currency or domain_currency or "USD").upper()
        mismatched: list[tuple[str, Fact]] = []
        tolerance_text = ""
        worst_diff = Decimal("0")
        for doc_id, fact in present[1:]:
            same = values_equal(
                key, base_fact.value, fact.value,
                currency=currency_for_key, tolerance=tolerance, extra=extra,
            )
            if not same:
                mismatched.append((doc_id, fact))
                if kind == "money":
                    left = _as_decimal(base_fact.value)
                    right = _as_decimal(fact.value)
                    if left is not None and right is not None:
                        worst_diff = max(worst_diff, abs(left - right))
        if kind == "money" and mismatched:
            tolerance_text = decimal_text(amount_tolerance(
                currency_for_key, base_fact.value, *(fact.value for _, fact in mismatched)
            ))

        values = {doc_id: fact.value for doc_id, fact in present}
        if mismatched:
            rendered = "、".join(f"{doc_id}={_fmt_value(value)!r}" for doc_id, value in values.items())
            detail = (
                f"「{label_zh}」在 {len(present)} 份单证上不一致：{rendered}；"
                f"以基线 {base_doc} 为准（词表外的措辞差异一律按冲突上报）"
            )
            if kind == "money" and tolerance_text:
                detail += f"（金额容差 ±{tolerance_text}，实际最大差 {decimal_text(worst_diff.normalize())}）"
            diffs.append(FactDiff(
                key=key,
                kind=kind,
                status="conflict",
                values=values,
                baseline_doc=base_doc,
                baseline_value=base_fact.value,
                domain=root_key,
                detail_zh=detail,
                tolerance=tolerance_text,
                diff_amount=decimal_text(worst_diff.normalize()) if worst_diff else "",
            ))
            continue

        same_text = all(fact.value == base_fact.value for _, fact in present[1:])
        if not same_text:
            if kind == "money":
                detail = (
                    f"「{label_zh}」金额差异在容差 ±{decimal_text(amount_tolerance(currency_for_key, *values.values()))}"
                    f" 之内（银行手续费/汇率尾差口径），视为同一金额："
                    + "、".join(f"{doc_id}={value!r}" for doc_id, value in values.items())
                )
            else:
                detail = (
                    f"「{label_zh}」措辞不同但按等价词表/格式归一视为同一事实："
                    + "、".join(f"{doc_id}={_fmt_value(value)!r}" for doc_id, value in values.items())
                )
            diffs.append(FactDiff(
                key=key,
                kind=kind,
                status="equivalent",
                values=values,
                baseline_doc=base_doc,
                baseline_value=base_fact.value,
                domain=root_key,
                detail_zh=detail,
            ))
            continue

        if check_missing:
            missing_docs = [doc_id for doc_id in ordered_docs if key not in index[doc_id]]
            if missing_docs:
                diffs.append(FactDiff(
                    key=key,
                    kind=kind,
                    status="missing",
                    values=values,
                    baseline_doc=base_doc,
                    baseline_value=base_fact.value,
                    domain=root_key,
                    detail_zh=(
                        f"「{label_zh}」在 {', '.join(missing_docs)} 上缺失"
                        f"（其余单证为 {base_fact.value!r}）"
                    ),
                ))
    return diffs


def _as_decimal(value: Any) -> Optional[Decimal]:
    try:
        return Decimal(str(value))
    except InvalidOperation:  # 非数值就按"没法算差额"处理
        return None


# ─── 基线承继核对 ─────────────────────────────────────────────────────────

def lint_pair(
    source_facts: Iterable[Fact],
    derived_facts: Iterable[Fact],
    *,
    currency: str = "",
    check_missing: bool = True,
    extra: Optional[Mapping[str, Any]] = None,
) -> list[FactCheck]:
    """承继核对（派生单对基线）—— `check_ct_vs_pi.py` 那 43 条的机器化。

    返回**逐条结果**（每个被核对的基线事实一条），形如
    `[FactCheck(key="incoterm", ok=True), FactCheck(key="payment_balance_ratio", ok=False, ...)]`，
    与原型脚本打印的 OK/MISS 矩阵一一对应；`ok=False` 的条目 `issues` 里有人话原因。

    判定：
    - 派生值与基线相同（或词表内等价措辞）⇒ `ok=True`；
    - 基线事实 `immutable=True` 且被改值 ⇒ `ok=False` + `FACT_IMMUTABLE`（带原值/新值）；
    - 其余值不同 ⇒ `ok=False` + `FACT_CONFLICT`；
    - 基线有、派生**没承继**：只报 `immutable` 的基线事实（`check_missing=True` 时）——
      派生单不必须携带每条基线事实（如 CO 不带付款条件），
      但"不可改写的条款连写都没写"是真实缺口。

    派生单独有的新事实（发票号、提单号…）**不产生条目**：承继核对的方向是
    「基线 → 派生单有没有照抄/有没有被改」，不是"两边必须一模一样"。
    """
    base_list: list[Fact] = [fact for fact in source_facts if isinstance(fact, Fact)]
    derived_list: list[Fact] = [fact for fact in derived_facts if isinstance(fact, Fact)]
    base_index: dict[str, Fact] = {}
    for fact in base_list:
        base_index.setdefault(fact.key, fact)
    if not base_index:
        return []

    domain_currency = str(currency or "").upper()
    if not domain_currency:
        domain_currency = str(base_index["currency"].value).upper() if "currency" in base_index else ""

    # 不可改写那条规则只在 facts 里写一次（规则 2 的唯一实现），这里复用它的判定，
    # 避免"同一件事两处代码两个结论"——G1 的老毛病。
    immutable_hits: dict[str, Any] = {}
    for violation in check_immutable(base_list, derived_list,
                                     currency=domain_currency, extra=extra):
        if violation.keys:
            immutable_hits[violation.keys[0]] = violation

    checks: list[FactCheck] = []
    carried: set[str] = set()
    for fact in derived_list:
        if fact.key in IDENTITY_KEYS:
            # 单号/日期是每张单证**自己的**标识（CI 的发票号 ≠ PI 的 PI 号），
            # 承继核对不比它们 —— 与 diff_facts 同一口径，否则每对单证都报假冲突。
            continue
        base = base_index.get(fact.key)
        if base is None:
            continue  # 派生单新增的事实，不属于承继核对范围
        carried.add(fact.key)
        currency_for_key = str(fact.currency or base.currency or domain_currency or "USD").upper()
        violation = immutable_hits.get(fact.key)
        if violation is not None:
            checks.append(FactCheck(
                fact.key,
                ok=False,
                status="immutable",
                original=violation.original,
                provided=violation.provided,
                issues=[f"{violation.code}：{violation.detail}"],
            ))
            continue
        if values_equal(fact.key, base.value, fact.value,
                        currency=currency_for_key, extra=extra):
            checks.append(FactCheck(
                fact.key,
                ok=True,
                status="equivalent" if base.value != fact.value else "consistent",
                original=base.value,
                provided=fact.value,
            ))
            continue
        checks.append(FactCheck(
            fact.key,
            ok=False,
            status="conflict",
            original=base.value,
            provided=fact.value,
            issues=[(
                f"{FACT_CONFLICT}：承继事实「{fact_label(fact.key)[0]}」与基线不一致："
                f"基线 {base.value!r} ≠ 派生 {fact.value!r}"
            )],
        ))

    if check_missing:
        for key, base in base_index.items():
            if not base.immutable or key in carried or key in IDENTITY_KEYS:
                continue
            checks.append(FactCheck(
                key,
                ok=False,
                status="missing",
                original=base.value,
                provided=None,
                issues=[(
                    f"{FACT_MISSING}：派生单没有承继不可改写事实「{fact_label(key)[0]}」"
                    f"（基线值 {base.value!r}）"
                )],
            ))
    return checks
