"""渲染输入指纹（C 方案）：让归档的 PDF「可复现、可追溯」—— 共享内核，两端一份（G1）。

背景（用户已拍板做 C 方案）
--------------------------
自动出 PDF（`POST /trade-docs/{id}/pdf`）把字节存进 `file_objects` 时只记了**内容**的
`sha256`（"这份 PDF 是什么"），**没有记**"它是用**哪一版模板/渲染器**、**哪一份数据**出的"
（"这份 PDF 凭什么长这样"）。于是事后无法回答两个审计问题：

1. 这张单据当时渲染用的数据，和现在库里的数据**是不是同一份**？
2. 归档件是**哪一版渲染器/模板**出的？（跨版本分页会变，见
   `docs/TRADE_DOC_PDF_ARCHIVAL.md` §四 风险 2）

本模块提供**签发时冻结**用的纯函数：`render_fingerprint(装配好的渲染数据)` →
`{"render_version", "input_sha256", "frozen_at"}`，写进 `trade_docs.raw_payload` 的保留键
`_render`（与既有 `_audit` 同风格：**顶层保留键**，`custom` 覆盖不到它）。

为什么放共享内核
----------------
`confirm`（签发）在 orchestrator 与 Worker 是**两套代码**。摘要算法若各写一份，两端算出来的
指纹必然不同 —— 那样"同一张单据"在本地与生产的可追溯性直接失效（G1：共用的判定只允许一份）。
纯标准库 ⇒ Pyodide 也能加载。

纪律：改渲染器/模板必须 bump `RENDER_VERSION`
--------------------------------------------
`render.ts`、`assets.json`、`manifest.json`（模板与共享打印样式）任何一处改动，
或渲染器行为变化（分页、字体、字段映射），都要把 `RENDER_VERSION` **加一**。
理由：`input_sha256` 只能证明"输入没变"，证明不了"输出没变"；模板改了但版本号不动，
事后会误判"同一版渲染器出的两份 PDF 应该一样"。这条纪律没有代码能自动兜底（渲染器在
前端 TS 里），只能靠人守 + 在 review 时检查。
"""
from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

from .payload_shared import DOC_NO_FIELDS

__all__ = [
    "RENDER_CHECK_VERDICTS",
    "RENDER_KEY",
    "RENDER_VERSION",
    "RENDER_DIGEST_IGNORED_FIELDS",
    "RENDER_CHECK_MAX_DOCS",
    "RENDER_CHECK_CARD_FIELDS",
    "RENDER_CHECK_CARD_UNAVAILABLE",
    "RENDER_CHECK_DECIDED_BUCKETS",
    "RENDER_CHECK_DOC_IDS_INVALID",
    "RENDER_CHECK_DOC_IDS_LIMIT",
    "RENDER_CHECK_DOC_IDS_REQUIRED",
    "RENDER_CHECK_SUMMARY_FIELDS",
    "RenderCheckBatchError",
    "canonical_render_input",
    "parse_render_check_doc_ids",
    "read_render_fingerprint",
    "render_check_card",
    "render_fingerprint",
    "render_fingerprint_check",
    "render_input_digest",
    "summarize_render_checks",
]

# `raw_payload` 里的保留键。下划线前缀与 `_audit` 同风格：**系统写的**，不是用户字段。
RENDER_KEY = "_render"

# 渲染器/模板版本。**从 1 开始**（本机制首次引入时）。
#
# ⚠️ 改以下任一就 +1：
#   - frontend/src/lib/trade-doc/render.ts（模板与字段映射）
#   - frontend/src/lib/trade-doc/assets.json（共享打印样式）
#   - frontend/src/lib/trade-doc/manifest.json（单据类型/字段清单）
#   - 渲染器行为（分页、字体、图片处理）
RENDER_VERSION = 1

# ── 哪些字段**不**进摘要（含理由）────────────────────────────────────────────
#
# 摘要只该反映"客户看到的**内容**"。以下三类必须排除，否则摘要会**出生即失效**
# 或产生无意义的抖动（同一份内容算出不同指纹 = 指纹没有用）：
#
# 1. **签发动作自身写入的时间/日期字段**（本模块下方由 `DOC_NO_FIELDS` 自动收集的
#    各类型 `*_date`、以及 `issued_at`/`issued_by`/`created_at`/`updated_at`/`frozen_at`）：
#    渲染数据里的单据日期 = `issued_at or created_at`；签发**之前**装配得到 `created_at`、
#    之后得到 `issued_at` —— 若纳入摘要，冻结的摘要与"用同一行重新装配"算出来的**永不相等**，
#    可复现性当场归零。签发时刻另记在 `_render.frozen_at` 与单据行 `issued_at` 上，不丢信息。
# 2. **系统自己的记录键**（`_audit` / `_render`）：审计与指纹是旁路数据，不是渲染输入，
#    纳入会让"改一次审计"改一次指纹（自指）。
# 3. **请求级易变值**（`request_id`/`now`/`trace_id`）：与内容无关。
#
# 注意：**金额、行项、买卖双方、条款、图片（data URI）、公章都在摘要内** ——
# 这些才是"客户看到的那一版"。
_DOC_DATE_FIELDS = tuple(
    date_field for _no_field, date_field in DOC_NO_FIELDS.values() if date_field
)

RENDER_DIGEST_IGNORED_FIELDS = frozenset(
    _DOC_DATE_FIELDS
    + (
        "created_at",
        "issued_at",
        "issued_by",
        "updated_at",
        "frozen_at",
        RENDER_KEY,
        "_audit",
        "request_id",
        "trace_id",
        "now",
    )
)


def _canonical_number(value: Any) -> Any:
    """把数字归一到"同值同形"，否则两端会算出不同指纹（真实风险，不是洁癖）。

    - orchestrator 走 SQLAlchemy：`total_amount` 是 `float(Decimal)`；
      Worker 走 asyncpg：同一列回来是 `Decimal`。JSON 里 `float` 的 `1250.0` 与
      `Decimal("1250.00")` 序列化文本不同 ⇒ 必须先归一。
    - 规则：**能整除的一律落到 `int`，否则落到 `float`**。这样
      `Decimal("1250.00")`、`1250.0`、`1250` 三者同形，而 `12.5` 保持 `12.5`
      （不会因为"统一转 float"把大整数精度丢掉，也不会把 `12.50` 与 `12.5` 分成两种）。
    - `NaN`/`Infinity` 原样保留（JSON 序列化文本稳定，且真实单据不会出现）。
    """
    if isinstance(value, bool):          # bool 是 int 的子类，必须先挡
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if math.isfinite(value) and value.is_integer():
            return int(value)
        return value
    if isinstance(value, Decimal):
        try:
            if value == value.to_integral_value():
                return int(value)
            return float(value)
        except (ArithmeticError, ValueError):  # NaN 比较/转换的边界
            return str(value)
    return value


def _canonical(value: Any) -> Any:
    """把值规范化成 **JSON 可序列化且跨端一致** 的形状。

    - 映射：递归处理，键统一成 `str`（顺序由 `json.dumps(sort_keys=True)` 决定 ⇒ 与插入顺序无关）；
    - 列表/元组：保持顺序（顺序有意义：行项顺序就是单据上的行序）；
    - 数字：`int`/`float`/`Decimal` 归一到同形（见 `_canonical_number`）；
    - `datetime`/`date` → ISO 字符串；其余未知类型 → `str`（宁可记个可读值，也不抛异常）。
    """
    if isinstance(value, dict):
        return {
            str(key): _canonical(item)
            for key, item in value.items()
            if key not in RENDER_DIGEST_IGNORED_FIELDS
        }
    if isinstance(value, (list, tuple)):
        return [_canonical(item) for item in value]
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, (int, float, Decimal)):
        return _canonical_number(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if hasattr(value, "isoformat"):  # date / time
        return value.isoformat()
    return str(value)


def canonical_render_input(data: Any) -> Any:
    """暴露规范化后的结构（**给测试与排障用**）：看得到"到底什么进了摘要"。"""
    return _canonical(data)


def render_input_digest(data: Any) -> Optional[str]:
    """对**装配好的渲染数据**做稳定摘要（sha256 十六进制）。

    确定性保证：
    - **同输入同摘要**，与 dict 的插入顺序无关（键排序后序列化）；
    - 不依赖运行时间/进程/请求（时间类字段已被排除，见 `RENDER_DIGEST_IGNORED_FIELDS`）。

    `data` 不是映射（例如装配失败传了 `None`）⇒ 返回 `None` —— **不伪造**一个"看起来像摘要"
    的常量：调用方据此如实标注"输入不可用"，而不是让人误以为已冻结。
    """
    if not isinstance(data, dict):
        return None
    payload = json.dumps(
        _canonical(data), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def render_fingerprint(data: Any, *, frozen_at: Optional[str] = None) -> dict:
    """产出写进 `raw_payload["_render"]` 的那份结构（形状即契约，两端一致）。

    - `data`：**装配好的渲染数据**（`render-data` 返回的那个 `data`，含图片 data URI）；
    - `frozen_at`：冻结时刻（UTC ISO）。不传则取当前时间 —— 测试请显式传入以保证确定。

    `data` 不可用时 `input_sha256` 为 `None` 且带 `note="input_unavailable"`：
    签发不能被指纹计算拖垮，但也**不假装**冻结成功。
    """
    digest = render_input_digest(data)
    out = {
        "render_version": RENDER_VERSION,
        "input_sha256": digest,
        "frozen_at": frozen_at or datetime.now(timezone.utc).isoformat(),
    }
    if digest is None:
        out["note"] = "input_unavailable"
    return out


def read_render_fingerprint(raw_payload: Any) -> Optional[dict]:
    """从 `raw_payload` 读出冻结的指纹（没有/形状不对 ⇒ `None`）。

    给读取侧（前端展示、事后审计脚本）用：**只读**，不改任何东西。
    """
    if isinstance(raw_payload, str):
        try:
            raw_payload = json.loads(raw_payload)
        except (TypeError, ValueError):
            return None
    if not isinstance(raw_payload, dict):
        return None
    meta = raw_payload.get(RENDER_KEY)
    return meta if isinstance(meta, dict) else None


# ── 对账（消费者）：现在的数据与签发时冻结的那一份，还一致吗？──────────────────
#
# 结论码（`reason`）是**保守**的：只在两边都拿得到摘要、且确实相等时才说"一致"。
# 特别注意它把"模板改过"与"数据被改"分成两件事：
#   · `data_changed`      —— 摘要不等 ⇒ 客户看到的**内容**变了；
#   · `version_drift`     —— 摘要相等但 `render_version` 不同 ⇒ 内容没变，
#                            但当前渲染器/模板已不是当时那一版（重出会不一样）。
# 只拿 sha 不等就下"数据被改"的结论是错的（模板变了也可能让 sha 变），所以两者分开报。
RENDER_CHECK_VERDICTS = (
    "matched",              # 数据一致 + 版本一致
    "version_drift",        # 数据一致，但模板/渲染器版本不同
    "data_changed",         # 数据变了（内容摘要不等）
    "no_fingerprint",       # 这张单据没冻结过（草稿/老单据）⇒ 没有基线，谈不上"一致"
    "frozen_unavailable",   # 冻结时就装配失败过（input_sha256=null）⇒ 无从比对
    "current_unavailable",  # 现在装配失败 ⇒ 比不了（**绝不**给"看起来匹配"的假结论）
)


def _render_check_reason(
    *, has_fingerprint: bool, frozen_sha: Any, current_sha: Any, version_drift: bool
) -> str:
    if not has_fingerprint:
        return "no_fingerprint"
    if not isinstance(frozen_sha, str):
        return "frozen_unavailable"
    if not isinstance(current_sha, str):
        return "current_unavailable"
    if current_sha != frozen_sha:
        return "data_changed"
    return "version_drift" if version_drift else "matched"


def render_fingerprint_check(
    frozen_meta: Any,
    current_data: Any,
    *,
    current_version: Optional[int] = None,
    checked_at: Optional[str] = None,
    current_error: Optional[str] = None,
) -> dict:
    """把"冻结的指纹"与"用**现在**的数据重算的摘要"比一比（两端同一份判定）。

    - `frozen_meta`：`read_render_fingerprint(raw_payload)` 的结果（没有 ⇒ `None`）；
    - `current_data`：**现在**装配好的渲染数据；装配失败请传 `None` 并给 `current_error`；
    - `current_version`：当前渲染器版本（默认 `RENDER_VERSION`）；测试可注入以模拟模板变更。

    返回的字段即两端端点的响应契约（逐字相同）：
    `has_fingerprint / frozen / current_sha256 / matches / render_version_frozen /
     render_version_current / render_version_drift / reason / checked_at / current_note / frozen_note`

    `matches=True` **当且仅当**两边都有摘要且完全相等 —— 装配失败、没有基线、
    冻结时就没摘要，一律 `False`（宁可说"比不了"，也不给假的"一致"）。
    """
    frozen = frozen_meta if isinstance(frozen_meta, dict) else None
    frozen_sha = frozen.get("input_sha256") if frozen else None
    frozen_version = frozen.get("render_version") if frozen else None
    current_sha = render_input_digest(current_data)
    drift = isinstance(frozen_version, int) and frozen_version != (
        RENDER_VERSION if current_version is None else current_version
    )
    return {
        "has_fingerprint": frozen is not None,
        "frozen": frozen,
        "current_sha256": current_sha,
        "matches": bool(
            frozen is not None
            and isinstance(frozen_sha, str)
            and isinstance(current_sha, str)
            and current_sha == frozen_sha
        ),
        "render_version_frozen": frozen_version if isinstance(frozen_version, int) else None,
        "render_version_current": RENDER_VERSION if current_version is None else current_version,
        "render_version_drift": bool(drift),
        "reason": _render_check_reason(
            has_fingerprint=frozen is not None,
            frozen_sha=frozen_sha,
            current_sha=current_sha,
            version_drift=bool(drift),
        ),
        "checked_at": checked_at or datetime.now(timezone.utc).isoformat(),
        # 现在这一次装配失败的原因（None = 装配成功）；不吞掉，用户才知道"比不了"为什么
        "current_note": None if current_sha is not None else (current_error or "input_unavailable"),
        # 冻结那次就失败过的话，把当时的说明原样带出来（别让读取侧以为有基线）
        "frozen_note": (frozen or {}).get("note"),
    }


# ── 批量对账（一次查出"哪些单据被改了"）───────────────────────────────────────
#
# 为什么这些也在内核，而不是各端壳层各写一份
# ------------------------------------------
# 批量 = 对 N 张各跑一次上面的判定，再把结论**计数**。计数口径本身就是语义：
# 哪几个 reason 算"有明确结论"、`frozen_unavailable` / `current_unavailable` /
# 取不到单据该落进哪一桶 —— 两端各写一份必然漂移（同一批数据两端给出不同的"结论分布"，
# 而用户正是拿这个分布决定"要不要重出"）。所以入参校验、卡片形状、汇总口径都在这里，
# 两端端点只剩"取数 → 逐张调用 → 组装"（G1）。

# 一次最多对账多少张：**成本闸门**，不是性能调优。
# 每张都要跑一次完整装配（企业主体 + 买方 + 上游快照 + 行项 + 产品图 data URI +
# 默认公章 + 产品基础信息回落）—— 50 张就是最多 50 次装配。上限是"误用防线"：
# 有人把它接到列表轮询/自动刷新上会直接压垮连接池。要更多就分批，节奏由调用方控制。
RENDER_CHECK_MAX_DOCS = 50

# 入参错误码（两端壳层原样回给客户端，前端一套错误处理两端通用）
RENDER_CHECK_DOC_IDS_REQUIRED = "DOC_IDS_REQUIRED"
RENDER_CHECK_DOC_IDS_INVALID = "DOC_IDS_INVALID"
RENDER_CHECK_DOC_IDS_LIMIT = "DOC_IDS_LIMIT"

# 卡片级"没得出任何结论"的 reason（**不属于** RENDER_CHECK_VERDICTS）
RENDER_CHECK_CARD_UNAVAILABLE = "unavailable"

# 卡片字段即契约（顺序也是契约：两端 JSON 逐字同构）
RENDER_CHECK_CARD_FIELDS = (
    "doc_id", "doc_no", "reason", "matches", "render_version_drift", "error",
)

# 汇总字段即契约
RENDER_CHECK_SUMMARY_FIELDS = (
    "total", "matched", "data_changed", "version_drift", "no_fingerprint", "unavailable",
)

# 四个"有明确结论"的 reason → 汇总桶。其余（frozen_unavailable / current_unavailable /
# 卡片级 unavailable）一律计入 `unavailable`：它们都只是"比不了"，
# 混进结论桶会让"这批里多少张被改了"这个数字不可信。
RENDER_CHECK_DECIDED_BUCKETS = {
    "matched": "matched",
    "data_changed": "data_changed",
    "version_drift": "version_drift",
    "no_fingerprint": "no_fingerprint",
}


class RenderCheckBatchError(ValueError):
    """批量对账入参不合法。

    纯内核异常：**不带 HTTP**（内核在脚本/其它调用方里也能用），
    `code` / `detail` 由两端壳层原样映射成 400 的错误体（与其它内核异常的用法一致）。
    """

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def parse_render_check_doc_ids(raw: Any) -> list:
    """`doc_ids` → 去重保序的整数列表；不合法 ⇒ `RenderCheckBatchError`。

    - 支持 `"1,2,3"`（查询串）与已拆好的序列（脚本/测试直接传 list）；
    - 空 token 跳过（`"1,,2"`、末尾逗号都很常见），但**整体为空** ⇒ `DOC_IDS_REQUIRED`：
      "什么都不查"必然是调用方 bug，静默回一份空报告只会把它藏起来；
    - 非整数 token ⇒ `DOC_IDS_INVALID`：不猜、也不静默跳过 —— 跳过会让"少对了几张"无声发生；
    - 重复 id 去重**保序**：同一张只装配一次（省一半成本），卡片顺序可预期；
    - 去重后超过 `RENDER_CHECK_MAX_DOCS` ⇒ `DOC_IDS_LIMIT`。
    """
    if raw is None:
        tokens: list = []
    elif isinstance(raw, str):
        tokens = raw.split(",")
    elif isinstance(raw, (list, tuple)):
        tokens = list(raw)
    else:
        raise RenderCheckBatchError(
            RENDER_CHECK_DOC_IDS_INVALID,
            f"doc_ids 只能是逗号分隔的整数（收到 {type(raw).__name__}）",
        )

    ids: list = []
    for token in tokens:
        text = str(token).strip()
        if not text:
            continue
        try:
            value = int(text)
        except (TypeError, ValueError):
            raise RenderCheckBatchError(
                RENDER_CHECK_DOC_IDS_INVALID,
                f"doc_ids 只能是逗号分隔的整数（收到 {text!r}）",
            )
        if value not in ids:
            ids.append(value)

    if not ids:
        raise RenderCheckBatchError(
            RENDER_CHECK_DOC_IDS_REQUIRED, "doc_ids 不能为空（形如 doc_ids=1,2,3）"
        )
    if len(ids) > RENDER_CHECK_MAX_DOCS:
        raise RenderCheckBatchError(
            RENDER_CHECK_DOC_IDS_LIMIT,
            f"一次最多对账 {RENDER_CHECK_MAX_DOCS} 张（去重后 {len(ids)} 张）；"
            f"这是重操作（每张一次完整装配），请分批调用",
        )
    return ids


def render_check_card(doc_id: Any, doc_no: Any = None, check: Any = None,
                      error: Optional[str] = None) -> dict:
    """批量响应里的一张卡（形状即契约，见 `RENDER_CHECK_CARD_FIELDS`）。

    `check` 是 `render_fingerprint_check` 的结果；传 `None` 表示这张**没得出任何结论**
    （单据不存在 / 无权看，或者该张自己抛了异常）⇒ `reason=unavailable` + `error` 写明原因，
    `matches=False`（**绝不**假报"一致"）。
    """
    if not isinstance(check, dict):
        return {
            "doc_id": doc_id,
            "doc_no": doc_no,
            "reason": RENDER_CHECK_CARD_UNAVAILABLE,
            "matches": False,
            "render_version_drift": False,
            "error": error or RENDER_CHECK_CARD_UNAVAILABLE,
        }
    return {
        "doc_id": doc_id,
        "doc_no": doc_no,
        "reason": check.get("reason"),
        "matches": bool(check.get("matches")),
        "render_version_drift": bool(check.get("render_version_drift")),
        "error": error,
    }


def summarize_render_checks(items: Any) -> dict:
    """批量对账的顶层计数（口径见 `RENDER_CHECK_DECIDED_BUCKETS`）。

    不变式：`matched + data_changed + version_drift + no_fingerprint + unavailable == total`
    —— 六个桶必须覆盖每一张卡；漏掉一张会被读成"这张没问题"，而这正是最危险的错法。
    """
    cards = [c for c in items if isinstance(c, dict)] if isinstance(items, (list, tuple)) else []
    counts = {field: 0 for field in RENDER_CHECK_SUMMARY_FIELDS}
    counts["total"] = len(cards)
    for card in cards:
        bucket = RENDER_CHECK_DECIDED_BUCKETS.get(card.get("reason"))
        if bucket:
            counts[bucket] += 1
    counts["unavailable"] = counts["total"] - (
        counts["matched"] + counts["data_changed"]
        + counts["version_drift"] + counts["no_fingerprint"]
    )
    return counts
