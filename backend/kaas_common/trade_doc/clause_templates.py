"""条款模板库（A5-W1）—— 团队级常用条款 + 校验 + 按单证类型挑选（纯 stdlib）。

为什么放共享内核
----------------
条款库的**默认措辞、doc_types 合法集、校验口径**必须在 Worker（生产唯一运行时）
与 orchestrator（迁移/离线校验）之间**只有一份**。两份必然漂移：一边校验通过、
另一边 422，用户看到的就是"设置页保存不了"。

数据模型（表 `tenant_clause_templates`，团队级）
-----------------------------------------------
团队内可维护一组常用条款（付款条件/装运/检验/索赔/不可抗力/仲裁），
每条挂若干适用单证类型（`DOC_TYPE` 的 23 类子集），中英双语、可排序、可停用。
**不做条款版本管理**（v2 再议），也不自动改写历史单据 —— 模板只是"填单时的候选值"。

口径
----
- `doc_types`：非空数组、元素必须在 `DOC_TYPE` 23 类内、去重保序；
- `name`：非空、团队内唯一（唯一键 `(tenant_id, team_id, name)`）；
- `text_zh` / `text_en`：至少一个非空（只有中文或只有英文都允许 —— 外贸实务里
  中文给国内同事看、英文给客户看，强行要求双语会逼出机翻）；
- `sort_order`：整数，小的排前面；
- 删除 = **软删**（`is_active=false`），历史单据引用过的措辞仍留在库里可追溯。

默认 6 类模板（`DEFAULT_CLAUSE_TEMPLATES`）是**真实外贸惯例措辞**，只作首次懒创建
的初始值 —— **用户可以编辑/停用/删除**，不要把它当成不可改的系统条款。
"""
from __future__ import annotations

from typing import Any, Iterable, Mapping, Optional, Sequence

__all__ = [
    "CLAUSE_NAME_MAX",
    "CLAUSE_TEXT_MAX",
    "CLAUSE_DOC_TYPES",
    "CLAUSE_DOC_TYPE_SET",
    "DOC_TYPE_SET",
    "DEFAULT_CLAUSE_TEMPLATES",
    "DEFAULT_CLAUSE_CATEGORIES",
    "ClauseTemplateError",
    "default_seed_rows",
    "is_valid_doc_type",
    "normalize_doc_types",
    "pick_for_doc_type",
    "validate_clause_template",
]

# ── 错误码（Worker API 的 `detail.code` 直接复用）──────────────────────────
CLAUSE_NAME_REQUIRED = "CLAUSE_NAME_REQUIRED"
CLAUSE_NAME_TOO_LONG = "CLAUSE_NAME_TOO_LONG"
CLAUSE_TEXT_REQUIRED = "CLAUSE_TEXT_REQUIRED"
CLAUSE_TEXT_TOO_LONG = "CLAUSE_TEXT_TOO_LONG"
CLAUSE_DOC_TYPES_REQUIRED = "CLAUSE_DOC_TYPES_REQUIRED"
INVALID_DOC_TYPE = "INVALID_DOC_TYPE"
CLAUSE_SORT_INVALID = "CLAUSE_SORT_INVALID"

CLAUSE_NAME_MAX = 120
CLAUSE_TEXT_MAX = 8000

# 23 类单证（与 `kaas_common.domain.enums.DOC_TYPE` **逐项一致**）。
#
# 为什么不直接 import enums：`domain/enums.py` 依赖 FastAPI（HTTPException 做枚举校验），
# 而本内核是**纯 stdlib**、orchestrator 侧的迁移/内核测试环境没装 FastAPI
# （`pytest tests -q` 会在 import 阶段直接失败）。两边一致性由 worker 测试
# `test_clause_templates.py::test_doc_types_match_domain_enums` 钉住（worker 有 fastapi）。
CLAUSE_DOC_TYPES = (
    # 出口商自制
    "quotation", "pi", "contract", "ci", "pl",
    "shipping_advice", "draft", "beneficiary_cert", "beneficiary_decl",
    "non_wood_packing", "weight_list", "quality_cert", "manufacturer_cert",
    # 第三方签发
    "bl", "co", "insurance", "customs_declaration", "fumigation_cert",
    "saso_coc", "vessel_cert", "export_license", "ciq",
    # 通用
    "other",
)
DOC_TYPE_SET = frozenset(CLAUSE_DOC_TYPES)
# 对外别名：`__init__` 里也以 `CLAUSE_DOC_TYPE_SET` 暴露（避免与其他模块的 DOC_TYPE_SET 混淆）
CLAUSE_DOC_TYPE_SET = DOC_TYPE_SET
# 6 类默认条款的分类键（前端展示分组/图标可用；不代表业务枚举，全自由文本 name）
DEFAULT_CLAUSE_CATEGORIES = (
    "payment_terms",
    "shipping_terms",
    "inspection",
    "claims",
    "force_majeure",
    "arbitration",
)

# 默认 6 条（中英双语）。**用户可编辑**：这是首次懒创建的初始值，不是系统铁律。
DEFAULT_CLAUSE_TEMPLATES: tuple[dict, ...] = (
    {
        "category": "payment_terms",
        "name": "付款条件（30% 定金 + 70% 发货前付清）",
        "doc_types": ("quotation", "pi", "contract", "ci"),
        "text_zh": (
            "付款方式：订单确认后支付 30% 定金，余款 70% 于发货前付清；"
            "所有银行费用由买方承担。"
        ),
        "text_en": (
            "Payment Terms: 30% deposit upon order confirmation, 70% balance "
            "before shipment. All bank charges are for the Buyer's account."
        ),
        "sort_order": 10,
    },
    {
        "category": "shipping_terms",
        "name": "装运条款（FOB 上海，允许分批与转运）",
        "doc_types": (
            "quotation", "pi", "contract", "ci", "pl", "shipping_advice", "bl",
        ),
        "text_zh": (
            "装运条款：FOB 上海；装运期以合同约定为准；允许分批装运与转运。"
        ),
        "text_en": (
            "Shipment Terms: FOB Shanghai; shipment date as stipulated in the "
            "contract; partial shipment and transhipment are allowed."
        ),
        "sort_order": 20,
    },
    {
        "category": "inspection",
        "name": "检验条款（装运前工厂检验）",
        "doc_types": ("contract", "pi", "quality_cert", "manufacturer_cert"),
        "text_zh": (
            "检验条款：以装运前工厂检验结果为准，买方有权派员在场见证；"
            "检验标准按合同约定或适用的国际/国家标准执行。"
        ),
        "text_en": (
            "Inspection: pre-shipment factory inspection shall be final; the "
            "Buyer may attend the inspection. The standards shall be those "
            "agreed in the contract or the applicable international/national "
            "standards."
        ),
        "sort_order": 30,
    },
    {
        "category": "claims",
        "name": "索赔条款（到货后 30 天内书面提出）",
        "doc_types": ("contract", "pi", "quality_cert", "insurance"),
        "text_zh": (
            "索赔条款：买方应在货物到达目的港后 30 天内以书面形式提出索赔，"
            "并附检验报告等证明文件；逾期视为验收合格。"
        ),
        "text_en": (
            "Claims: the Buyer shall lodge any claim in writing within 30 days "
            "after the goods arrive at the destination port, supported by "
            "inspection reports and other evidence; otherwise the goods shall "
            "be deemed accepted."
        ),
        "sort_order": 40,
    },
    {
        "category": "force_majeure",
        "name": "不可抗力（受影响方免责并及时通知）",
        "doc_types": ("contract", "pi"),
        "text_zh": (
            "不可抗力：因战争、自然灾害、政府行为等不可抗力导致不能履行或延迟"
            "履行的，受影响方应及时通知对方并提供证明，据此在影响范围内免除责任。"
        ),
        "text_en": (
            "Force Majeure: if performance is prevented or delayed by war, "
            "natural disasters, governmental acts or other events of force "
            "majeure, the affected party shall promptly notify the other party "
            "and provide evidence, and shall be relieved from liability to the "
            "extent so affected."
        ),
        "sort_order": 50,
    },
    {
        "category": "arbitration",
        "name": "仲裁条款（中国国际经济贸易仲裁委员会）",
        "doc_types": ("contract", "pi"),
        "text_zh": (
            "仲裁条款：因本合同产生的争议，应提交中国国际经济贸易仲裁委员会"
            "（CIETAC）按其届时有效的仲裁规则在上海仲裁；仲裁裁决为终局，"
            "对双方均有约束力。"
        ),
        "text_en": (
            "Arbitration: any dispute arising from this contract shall be "
            "submitted to the China International Economic and Trade "
            "Arbitration Commission (CIETAC) for arbitration in Shanghai under "
            "its rules in effect at the time. The arbitral award shall be "
            "final and binding upon both parties."
        ),
        "sort_order": 60,
    },
)


class ClauseTemplateError(ValueError):
    """条款模板校验失败（结构化错误码，API 层直接落 `detail.code`）。"""

    def __init__(self, code: str, detail: str) -> None:
        self.code = code
        self.detail = detail
        super().__init__(f"{code}: {detail}")


def is_valid_doc_type(doc_type: Any) -> bool:
    """单证类型是否属于 23 类枚举（字符串精确匹配，不做大小写/别名猜测）。"""
    return isinstance(doc_type, str) and doc_type.strip() in DOC_TYPE_SET


def normalize_doc_types(raw: Any) -> list[str]:
    """规范化 `doc_types`：必须是**非空**的 23 类子集，去重保序。

    为什么空数组也拒绝：一条"不适用于任何单证"的条款模板没有意义，
    且会让前端下拉出现永远选不中的幽灵项。
    """
    if isinstance(raw, (str, bytes)) or not isinstance(raw, Sequence):
        raise ClauseTemplateError(
            CLAUSE_DOC_TYPES_REQUIRED,
            "doc_types 必须是单证类型数组（DOC_TYPE 的 23 类子集）",
        )
    if not raw:
        raise ClauseTemplateError(CLAUSE_DOC_TYPES_REQUIRED, "doc_types 不能为空")
    normalized: list[str] = []
    seen: set[str] = set()
    for value in raw:
        text = str(value).strip() if value is not None else ""
        if text not in DOC_TYPE_SET:
            raise ClauseTemplateError(
                INVALID_DOC_TYPE,
                f"未知单证类型：{text or value!r}（可选 {list(CLAUSE_DOC_TYPES)}）",
            )
        if text not in seen:
            normalized.append(text)
            seen.add(text)
    return normalized


def _optional_text(value: Any, *, field: str, code: str) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if len(text) > CLAUSE_TEXT_MAX:
        raise ClauseTemplateError(
            CLAUSE_TEXT_TOO_LONG,
            f"{field} 过长（{len(text)} 字符，上限 {CLAUSE_TEXT_MAX}）",
        )
    return text


def validate_clause_template(
    *,
    name: Any,
    doc_types: Any,
    text_zh: Any = None,
    text_en: Any = None,
    sort_order: Any = 0,
) -> dict:
    """校验并规范化一条条款模板（POST/PATCH 都走这里，不另写第二份规则）。

    返回可直接入库的 dict（已 strip/去重）；校验失败抛 `ClauseTemplateError`。
    """
    text = str(name).strip() if name is not None else ""
    if not text:
        raise ClauseTemplateError(CLAUSE_NAME_REQUIRED, "条款名称不能为空")
    if len(text) > CLAUSE_NAME_MAX:
        raise ClauseTemplateError(
            CLAUSE_NAME_TOO_LONG,
            f"条款名称过长（{len(text)} 字符，上限 {CLAUSE_NAME_MAX}）",
        )

    zh = _optional_text(text_zh, field="text_zh", code=CLAUSE_TEXT_TOO_LONG)
    en = _optional_text(text_en, field="text_en", code=CLAUSE_TEXT_TOO_LONG)
    if zh is None and en is None:
        raise ClauseTemplateError(
            CLAUSE_TEXT_REQUIRED,
            "text_zh 与 text_en 至少填一个（允许单语，但不允许空白条款）",
        )

    try:
        order = int(sort_order)
    except (TypeError, ValueError) as exc:
        raise ClauseTemplateError(
            CLAUSE_SORT_INVALID, f"sort_order 必须是整数：{sort_order!r}"
        ) from exc

    return {
        "name": text,
        "doc_types": normalize_doc_types(doc_types),
        "text_zh": zh,
        "text_en": en,
        "sort_order": order,
    }


def default_seed_rows() -> list[dict]:
    """默认 6 条的可写入副本（list/dict 都复制，避免调用方改到模块常量）。"""
    rows: list[dict] = []
    for template in DEFAULT_CLAUSE_TEMPLATES:
        row = dict(template)
        row["doc_types"] = list(template["doc_types"])
        rows.append(row)
    return rows


def pick_for_doc_type(
    items: Iterable[Mapping[str, Any]],
    doc_type: str,
    *,
    include_inactive: bool = False,
) -> list[dict]:
    """按单证类型挑选可用条款（W3 单证表单的"下拉候选"用）。

    - `doc_type` 必须是合法枚举（避免拼错后静默返回空）；
    - 默认只回 `is_active=true`；按 `sort_order` → `id` 稳定排序；
    - 纯函数：不读库、不改入参。
    """
    if not is_valid_doc_type(doc_type):
        raise ClauseTemplateError(INVALID_DOC_TYPE, f"未知单证类型：{doc_type!r}")
    wanted = doc_type.strip()
    picked: list[dict] = []
    for raw in items:
        item = dict(raw)
        doc_types = item.get("doc_types") or ()
        if wanted not in tuple(str(v) for v in doc_types):
            continue
        if not include_inactive and item.get("is_active") is False:
            continue
        picked.append(item)
    picked.sort(key=lambda row: (int(row.get("sort_order") or 0), int(row.get("id") or 0)))
    return picked
