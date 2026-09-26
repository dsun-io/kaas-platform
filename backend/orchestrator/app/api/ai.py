"""AI 层 API（最终设计 §4.7）

- GET   /api/v1/ai/tasks               任务清单（平台预置，含推荐 Provider）
- GET   /api/v1/ai/providers           Provider 列表（API Key 脱敏返回）
- PUT   /api/v1/ai/providers/{name}    配置 Provider（key/model/base_url/enabled；key 传 null 保留原值）
- POST  /api/v1/ai/providers/{name}/test  连通性测试
- GET   /api/v1/ai/task-bindings       任务绑定列表（含"不用 AI"状态）
- PUT   /api/v1/ai/task-bindings/{task_key}  设置绑定（provider/model/enabled）
- GET   /api/v1/ai/usage               对账记录（可按任务/Provider 拆分统计）
- POST  /api/v1/ai/tasks/{task_key}/run  手动执行任务（调试/前端预览）
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.workstation_models import AiProvider, AiTaskBinding, AiUsage
from app.core.auth import AuthContext, get_auth_context
from app.services.ai_tasks import TASKS, PROVIDER_DEFAULTS, mask_key, run_ai_task
from app.services.llm_client import openai_compat_chat
from app.api.ws_common import tenant_id_of

router = APIRouter(prefix="/api/v1/ai", tags=["ai"])

PROVIDERS = ("deepseek", "kimi", "zhipu")


# ── Schemas ──────────────────────────────────────────────────────────────────

class ProviderUpsert(BaseModel):
    api_key: Optional[str] = None      # None = 保留原值；空字符串 = 清除
    model: Optional[str] = None
    base_url: Optional[str] = None
    enabled: Optional[bool] = None


class BindingUpsert(BaseModel):
    provider: Optional[str] = None
    model: Optional[str] = None
    enabled: Optional[bool] = None
    config: Optional[dict] = None


class TaskRun(BaseModel):
    payload: dict = {}


# ── 任务清单 ─────────────────────────────────────────────────────────────────

@router.get("/tasks")
async def list_tasks():
    return {"items": [
        {"task_key": k, "name": v["name"], "recommended_provider": v["recommended_provider"]}
        for k, v in TASKS.items()
    ]}


# ── Provider 配置 ────────────────────────────────────────────────────────────

def _row_to_provider(p: AiProvider) -> dict:
    return {
        "provider": p.provider, "api_key_masked": mask_key(p.api_key),
        "has_key": bool(p.api_key), "model": p.model, "base_url": p.base_url,
        "enabled": p.enabled,
        "default_model": PROVIDER_DEFAULTS.get(p.provider, {}).get("model"),
        "default_base_url": PROVIDER_DEFAULTS.get(p.provider, {}).get("base_url"),
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


async def _get_or_create_provider(db, tenant_id: str, name: str) -> AiProvider:
    p = (await db.execute(
        select(AiProvider).where(
            AiProvider.tenant_id == tenant_id, AiProvider.provider == name)
    )).scalar_one_or_none()
    if p is None:
        p = AiProvider(tenant_id=tenant_id, provider=name, enabled=False)
        db.add(p)
        await db.flush()
    return p


@router.get("/providers")
async def list_providers(
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    rows = (await db.execute(
        select(AiProvider).where(AiProvider.tenant_id == tenant_id)
    )).scalars().all()
    existing = {r.provider: r for r in rows}
    items = []
    for name in PROVIDERS:  # 三个 Provider 固定展示，未配置也返回（enabled=false）
        items.append(_row_to_provider(existing[name]) if name in existing else {
            "provider": name, "api_key_masked": None, "has_key": False,
            "model": None, "base_url": None, "enabled": False,
            "default_model": PROVIDER_DEFAULTS.get(name, {}).get("model"),
            "default_base_url": PROVIDER_DEFAULTS.get(name, {}).get("base_url"),
            "updated_at": None,
        })
    return {"items": items}


@router.put("/providers/{name}")
async def upsert_provider(
    name: str,
    body: ProviderUpsert,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    if name not in PROVIDERS:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "BAD_PROVIDER",
            "field": "provider", "value": name, "allowed": list(PROVIDERS)})
    tenant_id = tenant_id_of(auth)
    p = await _get_or_create_provider(db, tenant_id, name)
    if body.api_key is not None:
        p.api_key = body.api_key or None
    if body.model is not None:
        p.model = body.model or None
    if body.base_url is not None:
        p.base_url = body.base_url or None
    if body.enabled is not None:
        p.enabled = body.enabled
    await db.commit()
    await db.refresh(p)
    return _row_to_provider(p)


@router.post("/providers/{name}/test")
async def test_provider(
    name: str,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """连通性测试：最小 chat 调用，返回延迟与模型应答。"""
    if name not in PROVIDERS:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "BAD_PROVIDER", "allowed": list(PROVIDERS)})
    tenant_id = tenant_id_of(auth)
    p = await _get_or_create_provider(db, tenant_id, name)
    if not p.api_key:
        raise HTTPException(status_code=400, detail={
            "error": "bad_request", "code": "NO_API_KEY",
            "detail": "请先配置 API Key"})
    defaults = PROVIDER_DEFAULTS.get(name, {})
    import time
    started = time.perf_counter()
    try:
        content, usage = await openai_compat_chat(
            p.base_url or defaults.get("base_url", ""),
            p.api_key,
            p.model or defaults.get("model", ""),
            [{"role": "user", "content": "Reply with exactly: ok"}],
            max_tokens=10, temperature=0,
        )
        return {"ok": True, "latency_ms": int((time.perf_counter() - started) * 1000),
                "reply": content[:100], "model": p.model or defaults.get("model"),
                "usage": usage}
    except Exception as e:
        return {"ok": False, "latency_ms": int((time.perf_counter() - started) * 1000),
                "error": str(e)[:500]}


# ── 任务绑定 ─────────────────────────────────────────────────────────────────

def _row_to_binding(b: AiTaskBinding) -> dict:
    return {
        "task_key": b.task_key, "provider": b.provider, "model": b.model,
        "enabled": b.enabled, "config": b.config,
        "use_ai": b.enabled,   # "不用 AI" 是合法选项：enabled=false
        "updated_at": b.updated_at.isoformat() if b.updated_at else None,
    }


@router.get("/task-bindings")
async def list_bindings(
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    rows = (await db.execute(
        select(AiTaskBinding).where(AiTaskBinding.tenant_id == tenant_id)
    )).scalars().all()
    existing = {r.task_key: r for r in rows}
    items = []
    for k, v in TASKS.items():
        if k in existing:
            items.append(_row_to_binding(existing[k]))
        else:
            items.append({"task_key": k, "provider": v["recommended_provider"],
                          "model": None, "enabled": False, "config": None,
                          "use_ai": False, "updated_at": None})
    return {"items": items}


@router.put("/task-bindings/{task_key}")
async def upsert_binding(
    task_key: str,
    body: BindingUpsert,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    if task_key not in TASKS:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "BAD_TASK",
            "field": "task_key", "value": task_key, "allowed": list(TASKS)})
    if body.provider is not None and body.provider not in PROVIDERS:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "BAD_PROVIDER",
            "field": "provider", "value": body.provider, "allowed": list(PROVIDERS)})
    tenant_id = tenant_id_of(auth)
    b = (await db.execute(
        select(AiTaskBinding).where(
            AiTaskBinding.tenant_id == tenant_id, AiTaskBinding.task_key == task_key)
    )).scalar_one_or_none()
    if b is None:
        b = AiTaskBinding(tenant_id=tenant_id, task_key=task_key,
                          provider=TASKS[task_key]["recommended_provider"],
                          enabled=False)
        db.add(b)
        await db.flush()
    if body.provider is not None:
        b.provider = body.provider or None
    if body.model is not None:
        b.model = body.model or None
    if body.enabled is not None:
        b.enabled = body.enabled
    if body.config is not None:
        b.config = body.config
    await db.commit()
    await db.refresh(b)
    return _row_to_binding(b)


# ── 对账记录 ─────────────────────────────────────────────────────────────────

@router.get("/usage")
async def list_usage(
    task_key: Optional[str] = None,
    provider: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    stmt = select(AiUsage).where(AiUsage.tenant_id == tenant_id)
    if task_key:
        stmt = stmt.where(AiUsage.task_key == task_key)
    if provider:
        stmt = stmt.where(AiUsage.provider == provider)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    stmt = stmt.order_by(AiUsage.created_at.desc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = (await db.execute(stmt)).scalars().all()
    items = [{
        "id": u.id, "task_key": u.task_key, "provider": u.provider, "model": u.model,
        "prompt_tokens": u.prompt_tokens, "completion_tokens": u.completion_tokens,
        "cost_usd": float(u.cost_usd) if u.cost_usd is not None else None,
        "status": u.status, "error": u.error, "latency_ms": u.latency_ms,
        "created_at": u.created_at.isoformat() if u.created_at else None,
    } for u in rows]

    # 成本统计：按任务 / 按 Provider 拆分
    stats_stmt = select(
        AiUsage.task_key, AiUsage.provider, AiUsage.status,
        func.count().label("cnt"),
        func.coalesce(func.sum(AiUsage.prompt_tokens), 0).label("prompt_tokens"),
        func.coalesce(func.sum(AiUsage.completion_tokens), 0).label("completion_tokens"),
    ).where(AiUsage.tenant_id == tenant_id).group_by(
        AiUsage.task_key, AiUsage.provider, AiUsage.status)
    stats = [{
        "task_key": r.task_key, "provider": r.provider, "status": r.status,
        "count": r.cnt, "prompt_tokens": int(r.prompt_tokens),
        "completion_tokens": int(r.completion_tokens),
    } for r in (await db.execute(stats_stmt)).all()]
    return {"items": items, "total": total, "page": page, "page_size": page_size,
            "stats": stats}


# ── 手动执行任务 ─────────────────────────────────────────────────────────────

@router.post("/tasks/{task_key}/run")
async def run_task(
    task_key: str,
    body: TaskRun,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    try:
        outcome = await run_ai_task(db, tenant_id, task_key, body.payload)
    except KeyError:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "BAD_TASK",
            "field": "task_key", "value": task_key, "allowed": list(TASKS)})
    return outcome

