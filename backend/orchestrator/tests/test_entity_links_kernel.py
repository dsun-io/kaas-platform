"""通用关系（边）校验的单测（共享内核，两端共用）。

为什么钉住：边表的 `src_id`/`dst_id` 是多态的 → **数据库加不了外键**，
唯一的防线就是写入前的校验。校验一旦漏掉，脏边会静默留在库里，
把"合并/改版"这类展示搞乱，而且没有约束会提醒你。
"""
import pytest

from kaas_common.workstation.entity_links import (
    ENTITY_TYPES, LINK_INSERT_SQL, LINK_SOFT_DELETE_SQL, REL_TYPES,
    EdgeError, normalize_edge, validate_edge,
)

pytestmark = pytest.mark.unit


def test_valid_edge_passes():
    validate_edge("trade_doc", 2, "quote", 4, "generated_from")


@pytest.mark.parametrize("args", [
    ("quoutes", 1, "quote", 2, "generated_from"),      # 实体类型拼错
    ("quote", 1, "quote", 2, "generated_from"),        # 两端同为报价（合法，见下）
    ("quote", 1, "order", 2, "unknown_rel"),           # 关系类型未知
    ("quote", None, "order", 2, "generated_from"),     # 端点为空
])
def test_invalid_edges_are_rejected_or_allowed(args):
    """同类型两端不算错（报价↔报价的改版关系合法）；其余必须被拒。"""
    if args[0] == args[2] and args[4] == "generated_from":
        validate_edge(*args)                            # 不应抛
        return
    with pytest.raises(EdgeError):
        validate_edge(*args)


def test_self_link_is_rejected():
    with pytest.raises(EdgeError) as exc:
        validate_edge("quote", 7, "quote", 7, "revision_of")
    assert exc.value.code == "SELF_LINK"


def test_normalize_lowercases_and_casts():
    edge = normalize_edge("TRADE_DOC", "2", "Quote", "4", "GENERATED_FROM",
                          meta={"reason": "merge"}, created_by="9")
    assert edge == {"src_type": "trade_doc", "src_id": 2, "dst_type": "quote",
                    "dst_id": 4, "rel_type": "generated_from",
                    "meta": {"reason": "merge"}, "created_by": 9}


def test_sql_is_idempotent_and_soft_deletes():
    # 重复建立同一关系必须幂等（写入路径不该关心"是否已存在"）
    assert "entity_links" in LINK_INSERT_SQL
    assert "ON CONFLICT" in LINK_INSERT_SQL and "DO NOTHING" in LINK_INSERT_SQL
    # 关系失效用软删，保留变更史
    assert "deleted_at = now()" in LINK_SOFT_DELETE_SQL


def test_declared_vocabulary():
    """词表是"加取值而不是建新表"的关键 —— 别悄悄改小。"""
    assert {"quote", "order", "trade_doc", "customer", "user", "inquiry"} == set(ENTITY_TYPES)
    assert {"generated_from", "converted_from", "merged_into",
            "revision_of", "can_access"} == set(REL_TYPES)
