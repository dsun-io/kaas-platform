"""通用关系（边）的语义与校验 —— 纯函数，两端共用（stdlib only）。

背景与设计：`docs/ENTITY_LINKS_OPTIMIZATION.md`

职责划分（**不要混**）
----------------------
| 层 | 表 | 语义 | 基数 |
|---|---|---|---|
| 归属 | 列（`orders.quote_id`、`trade_docs.quote_id`/`order_id`） | 主归属，客户页树的**层级**靠它 | 一个（唯一） |
| 关系 | `entity_links` 边表 | 完整关系集：合并成单、关系变更史、多对多 | 多个 |
| 维护 | 本模块 + 各端薄封装 | 唯一入口，禁止各处手写 INSERT | — |

**为什么边表不能替代归属列**：边表的 `src_id`/`dst_id` 是多态的，数据库**加不了外键** ——
它保证不了"这个 id 真的存在"，删实体也不会自动清边。归属这种"必须有、且唯一"的约束
交给列 + `NOT NULL`/`CHECK`/`FK` 才可靠。

各端实现约定
------------
- dev（SQLAlchemy）：`INSERT INTO entity_links ... ON CONFLICT DO NOTHING`
- worker（asyncpg）：同 SQL，`$n` 占位
两端都**只能**通过各自的 `link()/unlink()` 写这张表；代码评审禁止直接 `INSERT INTO entity_links`。
"""
from __future__ import annotations

from typing import Optional

__all__ = [
    "REL_GENERATED_FROM", "REL_CONVERTED_FROM", "REL_MERGED_INTO",
    "REL_REVISION_OF", "REL_CAN_ACCESS", "REL_TYPES", "ENTITY_TYPES",
    "normalize_edge", "validate_edge", "EdgeError", "LINK_INSERT_SQL",
    "LINK_INSERT_SQL_NAMED", "LINK_SOFT_DELETE_SQL",
]

# ── 关系类型 ──
# generated_from：这张单证/订单是由那个实体生成的（最常用）
# converted_from：报价转订单（与 generated_from 同义，历史表用的是这个词）
# merged_into：多张合并成一张（一单多报价、一单证多报价）
# revision_of：改版/修订
# can_access：访问授权（账号 ↔ 业务客户，即"官网数据后台"权限）
REL_GENERATED_FROM = "generated_from"
REL_CONVERTED_FROM = "converted_from"
REL_MERGED_INTO = "merged_into"
REL_REVISION_OF = "revision_of"
REL_CAN_ACCESS = "can_access"

REL_TYPES = frozenset({
    REL_GENERATED_FROM, REL_CONVERTED_FROM, REL_MERGED_INTO,
    REL_REVISION_OF, REL_CAN_ACCESS,
})

# 允许出现在边的两端的实体类型（加新类型时改这里，而不是建新表）
ENTITY_TYPES = frozenset({"quote", "order", "trade_doc", "customer", "user", "inquiry"})


class EdgeError(ValueError):
    """关系参数非法。带上 code，方便两端返回一致的错误体。"""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def validate_edge(src_type: str, src_id, dst_type: str, dst_id, rel_type: str) -> None:
    """校验一条边是否合法（两端共用；写库前必须调）。"""
    if (src_type or "").strip().lower() not in ENTITY_TYPES:
        raise EdgeError("UNKNOWN_ENTITY_TYPE", f"未知实体类型：{src_type}")
    if (dst_type or "").strip().lower() not in ENTITY_TYPES:
        raise EdgeError("UNKNOWN_ENTITY_TYPE", f"未知实体类型：{dst_type}")
    if (rel_type or "").strip().lower() not in REL_TYPES:
        raise EdgeError("UNKNOWN_REL_TYPE", f"未知关系类型：{rel_type}")
    if src_id is None or dst_id is None:
        raise EdgeError("EDGE_ENDPOINT_REQUIRED", "关系两端都不能为空")
    if str(src_type).lower() == str(dst_type).lower() and str(src_id) == str(dst_id):
        # 自环几乎总是 bug（"报价由自己生成"），拦掉
        raise EdgeError("SELF_LINK", "关系两端不能是同一实体")


def normalize_edge(src_type: str, src_id, dst_type: str, dst_id,
                   rel_type: str, *, meta: Optional[dict] = None,
                   created_by=None) -> dict:
    """规范化成可直接写库的一行（校验 + 统一小写 + id 转 int）。"""
    src_type = (src_type or "").strip().lower()
    dst_type = (dst_type or "").strip().lower()
    rel_type = (rel_type or "").strip().lower()
    validate_edge(src_type, src_id, dst_type, dst_id, rel_type)
    return {
        "src_type": src_type, "src_id": int(src_id),
        "dst_type": dst_type, "dst_id": int(dst_id),
        "rel_type": rel_type,
        "meta": meta,
        "created_by": int(created_by) if created_by is not None else None,
    }


# ── 两端共用 SQL（worker 直接执行；dev 用 SQLAlchemy 同语义实现）──
# ON CONFLICT DO NOTHING：唯一约束是 (tenant, src_type, src_id, dst_type, dst_id, rel_type)，
# 重复建立同一关系视为幂等成功，而不是报错（写入路径不该关心"是否已存在"）。
LINK_INSERT_SQL = (
    "INSERT INTO entity_links"
    " (tenant_id, src_type, src_id, dst_type, dst_id, rel_type, meta, created_by)"
    " VALUES ($1,$2,$3,$4,$5,$6,$7,$8)"
    " ON CONFLICT (tenant_id, src_type, src_id, dst_type, dst_id, rel_type) DO NOTHING"
)

# 关系失效用**软删**：保留关系变更史（"原本由报价 A 生成，后改为 B"两条都在）
LINK_SOFT_DELETE_SQL = (
    "UPDATE entity_links SET deleted_at = now()"
    " WHERE src_type=$1 AND src_id=$2 AND dst_type=$3 AND dst_id=$4 AND rel_type=$5"
    "   AND deleted_at IS NULL"
)

# 同一张边表、同一段 SQL 的**命名参数**版本：dev（SQLAlchemy `text()`）绑的是
# `:name` 而不是 `$n`。为什么要共用一条常量而不是各写一份：旧 refs 表退场后，
# 边表是"列表达不了的关系"（单证 ← 询盘、单证 ← 单证派生）的**唯一**落库点，
# 两端语义必须逐字一致 —— 抄错一个 ON CONFLICT 子句就会让关系静默丢失或 500。
LINK_INSERT_SQL_NAMED = (
    "INSERT INTO entity_links"
    " (tenant_id, src_type, src_id, dst_type, dst_id, rel_type, meta, created_by)"
    " VALUES (:tenant_id, :src_type, :src_id, :dst_type, :dst_id, :rel_type,"
    " :meta, :created_by)"
    " ON CONFLICT (tenant_id, src_type, src_id, dst_type, dst_id, rel_type) DO NOTHING"
)
