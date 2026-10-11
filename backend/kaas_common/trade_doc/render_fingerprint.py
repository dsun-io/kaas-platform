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
    "RENDER_KEY",
    "RENDER_VERSION",
    "RENDER_DIGEST_IGNORED_FIELDS",
    "canonical_render_input",
    "read_render_fingerprint",
    "render_fingerprint",
    "render_input_digest",
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
