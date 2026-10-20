"""条款模板库 HTTP 层（A5-W1）—— 团队级常用条款 CRUD + 首次懒种子。

端点（前缀 `/api/v1`，tenant 恒 `DEFAULT_TENANT`）
--------------------------------------------------
    GET    /clause-templates?doc_type=      登录即可；团队级过滤；可按单证类型筛选
    POST   /clause-templates                仅团队管理员；新建
    PATCH  /clause-templates/{id}           仅团队管理员；局部更新
    DELETE /clause-templates/{id}           仅团队管理员；**软删** is_active=false

契约（前端已按此写 UI，**不要改字段名/形状**）
----------------------------------------------
    GET → {"items": [
        {"id": 1, "name": "...", "doc_types": ["pi","ci"],
         "text_zh": "...", "text_en": "...", "sort_order": 10, "is_active": true},
        ...], "total": 6}

响应只含这 7 个业务字段（时间戳留在库里，不占前端契约；需要时再扩展）。

口径
----
- **团队级**：`team_id` 取当前登录用户所在团队；无团队 ⇒ 403 `NO_TEAM`
  （条款库不属于个人，也不跨团队共享）。
- **写权限**：团队创建者 或 平台管理员（共享内核 `is_team_admin`，不另写判定）；
  成员可读不可写 ⇒ 403 `NOT_TEAM_ADMIN`。
- **校验在共享内核** `kaas_common.trade_doc.clause_templates`：`doc_types` 必须是
  `DOC_TYPE` 的 18 类子集且非空、`name` 非空、`text_zh/text_en` 至少一个非空；
  违规 ⇒ 422 + `detail.code`（`INVALID_DOC_TYPE` / `CLAUSE_TEXT_REQUIRED` / …）。
- **懒种子**：首次 GET 某团队 0 条时插入 6 条默认措辞（kernel `default_seed_rows`），
  用 `ON CONFLICT DO NOTHING` 保证幂等/并发安全；只在该团队**一条都没有**时触发
  （含软删行也算"有过"⇒ 用户删空后不会被重新塞回默认值）。
- **删除 = 软删**：列表默认只回 `is_active=true`；同名唯一键仍在，避免删了再建同名产生歧义。
"""
from __future__ import annotations

from typing import Any, List, Optional

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, Field

import main as _main
from kaas_common.trade_doc.clause_templates import (
    ClauseTemplateError,
    default_seed_rows,
    is_valid_doc_type,
    validate_clause_template,
)
from kaas_common.workstation.scope import is_admin_role
from kaas_common.workstation.teams import is_team_admin

app = _main.app
DEFAULT_TENANT = _main.DEFAULT_TENANT
_get_current_user = _main._get_current_user


def _db():
    """每次现取 db（与 ws_docs_hardening 同一理由：测试会替换 main.db）。"""
    return _main.db


# ── SQL（全部参数化）──────────────────────────────────────────────────────

_SQL_COUNT_ALL = (
    "SELECT count(*) FROM tenant_clause_templates"
    " WHERE tenant_id=$1 AND team_id=$2"
)
_SQL_LIST = (
    "SELECT id, doc_types, name, text_zh, text_en, sort_order, is_active"
    " FROM tenant_clause_templates"
    " WHERE tenant_id=$1 AND team_id=$2 AND is_active"
    " ORDER BY sort_order, id"
)
_SQL_LIST_BY_DOC_TYPE = (
    "SELECT id, doc_types, name, text_zh, text_en, sort_order, is_active"
    " FROM tenant_clause_templates"
    " WHERE tenant_id=$1 AND team_id=$2 AND is_active AND $3 = ANY(doc_types)"
    " ORDER BY sort_order, id"
)
_SQL_SEED_ONE = (
    "INSERT INTO tenant_clause_templates"
    " (tenant_id, team_id, name, doc_types, text_zh, text_en, sort_order)"
    " VALUES ($1,$2,$3,$4::text[],$5,$6,$7)"
    " ON CONFLICT (tenant_id, team_id, name) DO NOTHING"
)
_SQL_INSERT = (
    "INSERT INTO tenant_clause_templates"
    " (tenant_id, team_id, name, doc_types, text_zh, text_en, sort_order)"
    " VALUES ($1,$2,$3,$4::text[],$5,$6,$7) RETURNING *"
)
_SQL_GET_ROW = (
    "SELECT * FROM tenant_clause_templates"
    " WHERE tenant_id=$1 AND team_id=$2 AND id=$3 AND is_active"
)
_SQL_UPDATE = (
    "UPDATE tenant_clause_templates SET"
    " name=$4, doc_types=$5::text[], text_zh=$6, text_en=$7, sort_order=$8,"
    " updated_at=now()"
    " WHERE tenant_id=$1 AND team_id=$2 AND id=$3 AND is_active RETURNING *"
)
_SQL_SOFT_DELETE = (
    "UPDATE tenant_clause_templates SET is_active=false, updated_at=now()"
    " WHERE tenant_id=$1 AND team_id=$2 AND id=$3 AND is_active RETURNING id"
)
_SQL_TEAM_CREATED_BY = "SELECT created_by FROM teams WHERE id=$1"


# ── 请求模型 ──────────────────────────────────────────────────────────────

class ClauseTemplateIn(BaseModel):
    """新建一条条款模板（字段与前端设置页一致）。"""

    name: str = Field(description="条款名称（团队内唯一，下拉辨认用）")
    doc_types: List[str] = Field(description="适用单证类型（DOC_TYPE 18 类子集）")
    text_zh: Optional[str] = Field(default=None, description="中文条款正文")
    text_en: Optional[str] = Field(default=None, description="英文条款正文")
    sort_order: int = Field(default=0, description="排序（小的在前）")


class ClauseTemplatePatchIn(BaseModel):
    """局部更新：`exclude_unset` 区分"没传"与"显式 null"。"""

    name: Optional[str] = None
    doc_types: Optional[List[str]] = None
    text_zh: Optional[str] = None
    text_en: Optional[str] = None
    sort_order: Optional[int] = None


# ── 输出 / 权限 ───────────────────────────────────────────────────────────

def _out(row: dict) -> dict:
    """响应契约（前端固定 7 字段；数组转 list 防 asyncpg 返回 tuple 形态）。"""
    return {
        "id": int(row["id"]),
        "name": row.get("name"),
        "doc_types": [str(t) for t in (row.get("doc_types") or [])],
        "text_zh": row.get("text_zh"),
        "text_en": row.get("text_en"),
        "sort_order": int(row.get("sort_order") or 0),
        "is_active": bool(row.get("is_active")),
    }


def _forbidden(code: str, detail: str) -> HTTPException:
    return HTTPException(
        status_code=403, detail={"error": "forbidden", "code": code, "detail": detail},
    )


def _team_id_or_403(user: dict) -> int:
    """当前团队（条款库是团队级资源；无团队无法归属 ⇒ 403 `NO_TEAM`）。"""
    team_id = user.get("team_id")
    if team_id is None:
        raise _forbidden("NO_TEAM", "当前账号不属于任何团队，条款模板按团队维护")
    return int(team_id)


async def _require_team_admin_team(request: Request, user: dict) -> int:
    """写权限：团队创建者或平台管理员（共享内核判定），返回 team_id。"""
    team_id = _team_id_or_403(user)
    if is_admin_role(user.get("role")):
        return team_id
    row = await _db().fetchrow(
        request, _SQL_TEAM_CREATED_BY, team_id, table="teams",
    )
    if row is None or not is_team_admin(
        row.get("created_by"), user.get("id"), user.get("role"),
    ):
        raise _forbidden("NOT_TEAM_ADMIN", "仅团队管理员可维护条款模板")
    return team_id


async def _seed_defaults(request: Request, team_id: int) -> None:
    """首次读取懒种子 6 条默认条款（幂等：唯一键 + DO NOTHING）。"""
    for row in default_seed_rows():
        await _db().execute(
            request,
            _SQL_SEED_ONE,
            DEFAULT_TENANT, team_id, row["name"], row["doc_types"],
            row["text_zh"], row["text_en"], row["sort_order"],
        )


def _validation_error(exc: ClauseTemplateError) -> HTTPException:
    return HTTPException(
        status_code=422,
        detail={"error": "validation", "code": exc.code, "detail": exc.detail},
    )


# ── 端点 ──────────────────────────────────────────────────────────────────

@app.get("/api/v1/clause-templates")
async def list_clause_templates(
    request: Request,
    doc_type: Optional[str] = None,
    user: dict = Depends(_get_current_user),
):
    """条款模板列表（团队成员可读）。

    `doc_type` 给了就只回"适用于该单证类型"的模板（18 类枚举之外 ⇒ 422，
    不静默返回空 —— 拼错类型却看到"没有模板"很难查）。
    """
    team_id = _team_id_or_403(user)
    if doc_type is not None and not is_valid_doc_type(doc_type):
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_DOC_TYPE",
            "detail": f"未知单证类型：{doc_type!r}",
        })

    count = await _db().fetchval(request, _SQL_COUNT_ALL, DEFAULT_TENANT, team_id)
    if int(count or 0) == 0:
        # 懒种子：该团队一条都没有（含软删）才种；用户删空后不会被塞回默认值
        await _seed_defaults(request, team_id)

    if doc_type is None:
        rows = await _db().fetch(request, _SQL_LIST, DEFAULT_TENANT, team_id)
    else:
        rows = await _db().fetch(
            request, _SQL_LIST_BY_DOC_TYPE, DEFAULT_TENANT, team_id,
            doc_type.strip(),
        )
    items = [_out(dict(row)) for row in rows or []]
    return {"items": items, "total": len(items)}


@app.post("/api/v1/clause-templates", status_code=201)
async def create_clause_template(
    request: Request,
    body: ClauseTemplateIn,
    user: dict = Depends(_get_current_user),
):
    """新建条款模板（仅团队管理员）。"""
    team_id = await _require_team_admin_team(request, user)
    try:
        normalized = validate_clause_template(
            name=body.name,
            doc_types=body.doc_types,
            text_zh=body.text_zh,
            text_en=body.text_en,
            sort_order=body.sort_order,
        )
    except ClauseTemplateError as exc:
        raise _validation_error(exc) from exc

    try:
        row = await _db().fetchrow(
            request,
            _SQL_INSERT,
            DEFAULT_TENANT, team_id, normalized["name"], normalized["doc_types"],
            normalized["text_zh"], normalized["text_en"], normalized["sort_order"],
        )
    except Exception as exc:  # uq_tenant_clause_templates_name
        if "uq_tenant_clause_templates_name" in str(exc) or "duplicate key" in str(exc):
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "CLAUSE_NAME_TAKEN",
                "detail": f"本团队已存在同名条款模板「{normalized['name']}」",
            }) from exc
        raise
    return _out(dict(row))


@app.patch("/api/v1/clause-templates/{template_id}")
async def update_clause_template(
    template_id: int,
    request: Request,
    body: ClauseTemplatePatchIn,
    user: dict = Depends(_get_current_user),
):
    """局部更新（仅团队管理员）。未传字段保持原值；合并后**整条重新校验**。"""
    team_id = await _require_team_admin_team(request, user)
    current = await _db().fetchrow(
        request, _SQL_GET_ROW, DEFAULT_TENANT, team_id, template_id,
    )
    if current is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "CLAUSE_TEMPLATE_NOT_FOUND",
            "detail": f"条款模板不存在或已停用：{template_id}",
        })

    provided = body.model_dump(exclude_unset=True)
    merged = {
        "name": provided.get("name", current.get("name")),
        "doc_types": provided.get("doc_types", current.get("doc_types")),
        "text_zh": provided.get("text_zh", current.get("text_zh")),
        "text_en": provided.get("text_en", current.get("text_en")),
        "sort_order": provided.get("sort_order", current.get("sort_order")),
    }
    try:
        normalized = validate_clause_template(**merged)
    except ClauseTemplateError as exc:
        raise _validation_error(exc) from exc

    try:
        row = await _db().fetchrow(
            request,
            _SQL_UPDATE,
            DEFAULT_TENANT, team_id, template_id, normalized["name"],
            normalized["doc_types"], normalized["text_zh"], normalized["text_en"],
            normalized["sort_order"],
        )
    except Exception as exc:  # 改名撞唯一键
        if "uq_tenant_clause_templates_name" in str(exc) or "duplicate key" in str(exc):
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "CLAUSE_NAME_TAKEN",
                "detail": f"本团队已存在同名条款模板「{normalized['name']}」",
            }) from exc
        raise
    if row is None:  # 并发删除
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "CLAUSE_TEMPLATE_NOT_FOUND",
            "detail": f"条款模板不存在或已停用：{template_id}",
        })
    return _out(dict(row))


@app.delete("/api/v1/clause-templates/{template_id}")
async def delete_clause_template(
    template_id: int,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """软删（仅团队管理员）：`is_active=false`，历史单据引用可追溯。"""
    team_id = await _require_team_admin_team(request, user)
    row = await _db().fetchrow(
        request, _SQL_SOFT_DELETE, DEFAULT_TENANT, team_id, template_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "CLAUSE_TEMPLATE_NOT_FOUND",
            "detail": f"条款模板不存在或已停用：{template_id}",
        })
    return {"id": int(template_id), "is_active": False}
