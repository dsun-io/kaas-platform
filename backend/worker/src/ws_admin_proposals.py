"""Admin 属性沉淀提案（`/api/v1/admin/spec/attribute-proposals`）—— Worker 端。

与 orchestrator `app/api/admin_proposals.py` 同路径、同方法、同响应键：
- ``GET    /api/v1/admin/spec/attribute-proposals[?status=pending]``
- ``GET    /api/v1/admin/spec/attribute-proposals/recommended``
- ``PATCH  /api/v1/admin/spec/attribute-proposals/{proposal_id}``

为什么补（2026-10-19 方案 B S3 首项）
------------------------------------
前端 `admin/spec-proposals` 页面（`page.tsx:53/64/83`）一直在调这三个端点，
但生产 Worker 从未实现 ⇒ 管理员看到的是 404。它们原先登记在
`scripts/route-parity-allowlist.txt` 的缺口清单里。

鉴权口径与 orchestrator `require_platform_ops` 一致：**internal 账号 + 管理员角色**。
写操作在一条事务里完成（approve 会同时插 `spec_attributes` 并回写提案状态）。
"""
from __future__ import annotations

from fastapi import Depends, HTTPException, Request

from kaas_common.workstation.scope import is_admin_role

import main as _main

app = _main.app
_get_current_user = _main._get_current_user
_acquire = _main._acquire




def _require_platform_ops(user: dict) -> None:
    """平台运营 = internal + 管理员角色（与 orchestrator rbac.require_platform_ops 对齐）。"""
    if user.get("account_type") != "internal" or not is_admin_role(user.get("role")):
        raise HTTPException(
            status_code=403,
            detail={"error": "forbidden", "message": "Platform operator required"},
        )


def _proposal_out(row) -> dict:
    score = row.get("recommendation_score")
    created = row.get("created_at")
    return {
        "id": row["id"],
        "tenant_id": row["tenant_id"],
        "category_id": row["category_id"],
        "proposed_name": row["proposed_name"],
        "proposed_type": row["proposed_type"],
        "group_code": row["group_code"],
        "status": row["status"],
        "occurrence_count": row["occurrence_count"],
        "recommended_for_promotion": row["recommended_for_promotion"],
        "recommendation_score": float(score) if score is not None else None,
        "created_at": created.isoformat() if created else None,
    }


def _recommended_out(row) -> dict:
    score = row.get("recommendation_score")
    recommended_at = row.get("recommended_at")
    return {
        "id": row["id"],
        "tenant_id": row["tenant_id"],
        "proposed_name": row["proposed_name"],
        "recommendation_score": float(score) if score is not None else None,
        "recommended_at": recommended_at.isoformat() if recommended_at else None,
    }


@app.get("/api/v1/admin/spec/attribute-proposals")
async def list_attribute_proposals(
    request: Request,
    status: str | None = None,
    user: dict = Depends(_get_current_user),
):
    """提案列表（平台运营专属）；`status=` 可选过滤。"""
    _require_platform_ops(user)
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            "SELECT id, tenant_id, category_id, proposed_name, proposed_type, group_code,"
            " status, occurrence_count, recommended_for_promotion, recommendation_score,"
            " created_at FROM attribute_proposals"
            " WHERE ($1::text IS NULL OR status = $1)"
            " ORDER BY created_at DESC",
            status,
        )
    return {"items": [_proposal_out(r) for r in rows]}


@app.get("/api/v1/admin/spec/attribute-proposals/recommended")
async def list_recommended_proposals(
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """推荐晋升的提案（平台运营专属）。"""
    _require_platform_ops(user)
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            "SELECT id, tenant_id, proposed_name, recommendation_score, recommended_at"
            " FROM attribute_proposals"
            " WHERE recommended_for_promotion IS TRUE AND status = 'pending'"
            " ORDER BY recommendation_score DESC"
        )
    return {"items": [_recommended_out(r) for r in rows]}


@app.patch("/api/v1/admin/spec/attribute-proposals/{proposal_id}")
async def review_attribute_proposal(
    proposal_id: int,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """审核提案：approve（晋升公库属性）/ reject / merge。"""
    _require_platform_ops(user)

    body = await request.json()
    action = body.get("action")
    review_note = body.get("note")
    reviewer = str(user["id"])

    async with _acquire(request) as conn:
        async with conn.transaction():
            proposal = await conn.fetchrow(
                "SELECT id, proposed_name, proposed_type, group_code, proposed_unit,"
                " proposed_unit_group, private_attribute_id"
                " FROM attribute_proposals WHERE id=$1",
                proposal_id,
            )
            if proposal is None:
                return {"error": "not_found"}

            if action == "approve":
                code = body.get("code") or str(proposal["proposed_name"]).lower().replace(" ", "_")
                new_attribute_id = await conn.fetchval(
                    "INSERT INTO spec_attributes (code, name, aliases, group_code, data_type,"
                    " unit, unit_group, scope, source, status, promoted_from, created_by)"
                    " VALUES ($1, $2, '[]'::jsonb, $3, $4, $5, $6, 'public', 'promoted', 'active',"
                    " $7, $8) RETURNING id",
                    code,
                    proposal["proposed_name"],
                    proposal["group_code"],
                    proposal["proposed_type"],
                    proposal["proposed_unit"],
                    proposal["proposed_unit_group"],
                    proposal["private_attribute_id"],
                    reviewer,
                )
                await conn.execute(
                    "UPDATE attribute_proposals SET status='promoted', reviewer=$2,"
                    " review_note=$3, reviewed_at=now(), promoted_attribute_id=$4 WHERE id=$1",
                    proposal_id,
                    reviewer,
                    review_note,
                    new_attribute_id,
                )
                return {
                    "id": proposal_id,
                    "status": "promoted",
                    "promoted_attribute_id": new_attribute_id,
                }

            if action == "reject":
                await conn.execute(
                    "UPDATE attribute_proposals SET status='rejected', reviewer=$2,"
                    " review_note=$3, reviewed_at=now() WHERE id=$1",
                    proposal_id,
                    reviewer,
                    review_note,
                )
                return {"id": proposal_id, "status": "rejected"}

            if action == "merge":
                target_id = body.get("target_attribute_id")
                if not target_id:
                    return {"error": "target_attribute_id required for merge"}
                await conn.execute(
                    "UPDATE attribute_proposals SET status='merged', reviewer=$2,"
                    " review_note=$3, reviewed_at=now(), promoted_attribute_id=$4 WHERE id=$1",
                    proposal_id,
                    reviewer,
                    review_note,
                    target_id,
                )
                return {"id": proposal_id, "status": "merged", "merged_into": target_id}

            return {"error": "invalid_action"}
