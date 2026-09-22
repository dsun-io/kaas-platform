"""P1-P7 工位链（AI 层 / 线索池 / 触达）— Python Worker 版（raw asyncpg 移植）。

与 backend/orchestrator 的 SQLAlchemy 实现保持 API/语义一致：
- 每次 AI 调用落 ai_usage（铁律）；失败记 failed 供对账
- 任务 fallback 链：绑定 Provider → DS↔Kimi 互备 → Zhipu → 纯模板（"不用 AI"合法）
- 订阅治理：未订阅工位 404 SUBSCRIPTION_REQUIRED；/ai/* 不查订阅
- 线索池共享：lead_candidates owner_scope=tenant；outreach/inquiry_status 跨工位只读
- 发送/AI 出站 HTTP：Workers 内用 js.fetch，本地 CPython 回退 urllib

注：Workers 无常驻调度器，replied 扫描仅手动触发（POST /api/v1/leads/scan-replied）。
由 main.py 文件末尾 `import chain` 挂载（复用 main 的 app/_acquire/_get_current_user）。
"""
import csv
import io
import json
import os
import re
import time
import hashlib
from datetime import date, datetime, timezone
from typing import List, Optional

from fastapi import Depends, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel

from main import app, _acquire, _get_current_user, DEFAULT_TENANT

RESEND_API_URL = "https://api.resend.com/emails"
VAR_RE = re.compile(r"\{\{\s*(\w+)\s*\}\}")

# ── 出站 HTTP（Workers: js.fetch；本地 CPython: urllib）────────────────────
async def _http_post_json(url: str, headers: dict, payload: dict, timeout: int = 30):
    body = json.dumps(payload)
    try:
        from js import fetch  # type: ignore  (Pyodide / Python Workers)
    except ImportError:
        import urllib.request
        req = urllib.request.Request(
            url, data=body.encode("utf-8"), method="POST",
            headers={**headers, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    opts = {"method": "POST", "headers": {**headers, "Content-Type": "application/json"}, "body": body}
    resp = await fetch(url, opts)
    return int(resp.status), await resp.text()


async def _openai_chat(base_url: str, api_key: str, model: str, messages: list,
                       temperature: float = 0.3, max_tokens: int = 2000,
                       json_mode: bool = False):
    payload = {"model": model, "messages": messages,
               "temperature": temperature, "max_tokens": max_tokens}
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    status, text = await _http_post_json(
        base_url.rstrip("/") + "/chat/completions",
        {"Authorization": f"Bearer {api_key}"}, payload)
    if status != 200:
        raise RuntimeError(f"HTTP {status}: {text[:300]}")
    data = json.loads(text)
    content = data["choices"][0]["message"]["content"]
    u = data.get("usage") or {}
    return content, {"prompt_tokens": u.get("prompt_tokens"),
                     "completion_tokens": u.get("completion_tokens")}


# ── jsonb 列（asyncpg 在 Workers 里返回 str，需手动解析）───────────────────
_JSONB_COLS = {
    "lead_candidates": {"fit_reasons", "raw"},
    "leadgen_runs": {"config"},
    "outreach_campaigns": set(),
}


def _row_to_dict(row, table: str) -> dict:
    d = dict(row)
    for k in _JSONB_COLS.get(table, set()) & d.keys():
        v = d[k]
        if isinstance(v, str) and v:
            try:
                d[k] = json.loads(v)
            except Exception:
                pass
    return d


def _mask(key: Optional[str]) -> Optional[str]:
    if not key:
        return None
    return "****" if len(key) <= 8 else f"{key[:4]}****{key[-4:]}"


# ═══════════════════════════════════════════════════════════════════
# 订阅治理（P7）
# ═══════════════════════════════════════════════════════════════════
SUB_CODES = {
    "leadgen": ["leadgen_starter", "leadgen_pro", "full_chain"],
    "outreach": ["outreach_starter", "outreach_pro", "full_chain"],
}


async def _require_sub(conn, workstation: str):
    codes = SUB_CODES[workstation]
    ok = await conn.fetchval(
        "SELECT 1 FROM tenant_subscriptions WHERE tenant_id=$1 AND code=ANY($2) AND active=true",
        DEFAULT_TENANT, codes)
    if not ok:
        raise HTTPException(status_code=404, detail={
            "error": "subscription_required", "code": "SUBSCRIPTION_REQUIRED",
            "workstation": workstation, "codes": codes})


# ═══════════════════════════════════════════════════════════════════
# AI 任务层（P1）— 模板与 orchestrator app/services/ai_tasks.py 一致
# ═══════════════════════════════════════════════════════════════════
PROVIDER_DEFAULTS = {
    "deepseek": {"base_url": "https://api.deepseek.com/v1", "model": "deepseek-chat"},
    "kimi": {"base_url": "https://api.moonshot.cn/v1", "model": "kimi-k2-0905-preview"},
    "zhipu": {"base_url": "https://open.bigmodel.cn/api/paas/v4", "model": "glm-4"},
}


def _template_config_validation(payload: dict) -> dict:
    issues = []
    if not (payload.get("region") or "").strip():
        issues.append("地区未填写")
    if not (payload.get("industry") or "").strip():
        issues.append("行业未填写")
    qty = payload.get("quantity") or 0
    if not (1 <= int(qty) <= 5000):
        issues.append("数量需在 1-5000 之间")
    return {"valid": not issues, "issues": issues,
            "suggestion": "检查地区/行业/数量后重新提交" if issues else None}


def _template_lead_scoring(payload: dict) -> dict:
    score, reasons = 0, []
    if payload.get("email"):
        score += 40; reasons.append("有邮箱 +40")
    if payload.get("website"):
        score += 25; reasons.append("有官网 +25")
    industry = (payload.get("industry") or "").lower()
    if any(k in industry for k in ("fence", "mesh", "wire", "construction", "build", "garden")):
        score += 25; reasons.append("行业关键词匹配 +25")
    if payload.get("google_rating"):
        score += 10; reasons.append("有 Google 评分 +10")
    return {"fit_score": min(score, 100), "reasons": reasons}


def _template_opening_line(payload: dict) -> dict:
    name = payload.get("contact_name") or payload.get("company_name") or "there"
    city = payload.get("city") or ""
    company = payload.get("company_name") or "your company"
    city_part = f" in {city}" if city else ""
    return {"opening_line": (
        f"Hi {name}, I came across {company}{city_part} and noticed you may be sourcing "
        f"wire mesh & fencing products. We are a manufacturer from China with factory-direct "
        f"pricing — could I send you our catalog and recent project references?")}


def _template_email_generation(payload: dict) -> dict:
    name = payload.get("contact_name") or "there"
    opening = payload.get("opening_line") or _template_opening_line(payload)["opening_line"]
    product = payload.get("product") or "wire mesh and fence products"
    subject = payload.get("subject") or f"Factory-direct {product} — quick question"
    body = (
        f"Dear {name},\n\n{opening}\n\n"
        f"We supply {product} with:\n"
        f"- Factory-direct pricing (no middlemen)\n"
        f"- Custom specs (galvanized / PVC coated, any size)\n"
        f"- 7-day samples, 15-25 day production\n\n"
        f"May I send you our catalog and a quotation for your current project?\n\n"
        f"Best regards,\n{{{{sender_name}}}}\n{{{{sender_title}}}} | {{{{sender_company}}}}")
    return {"subject": subject, "body": body}


def _template_inquiry_classification(payload: dict) -> dict:
    text = " ".join(str(payload.get(k) or "") for k in
                    ("product_name_raw", "application", "notes", "message")).lower()
    rules = [
        ("chain_link_fence", ("chain link", "勾花", "diamond mesh")),
        ("welded_mesh", ("welded", "电焊", "weldmesh")),
        ("gabion", ("gabion", "石笼", "hexagonal")),
        ("temporary_fence", ("temporary", "mobile fence", "portable fence")),
        ("security_fence", ("358", "anti climb", "high security", "prison")),
        ("farm_fence", ("farm", "field fence", "cattle", "deer fence", "hog")),
    ]
    for label, keywords in rules:
        if any(k in text for k in keywords):
            return {"category": label, "confidence": "template", "auto": False}
    return {"category": "other", "confidence": "template", "auto": False}


def _extract_json(text: str) -> str:
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise ValueError("AI 输出不含 JSON")
    return m.group(0)


TASKS = {
    "config_validation": {
        "name": "配置校验", "recommended_provider": "deepseek",
        "template_fn": _template_config_validation,
        "build_prompt": lambda p: (
            "校验以下客户开发配置是否合理（地区/行业/ICP/数量），"
            "以 JSON 返回 {\"valid\": bool, \"issues\": [...], \"suggestion\": string|null}。\n"
            f"配置：{json.dumps(p, ensure_ascii=False)}"),
        "parse": lambda t: json.loads(_extract_json(t)),
    },
    "lead_scoring": {
        "name": "线索评分", "recommended_provider": "deepseek",
        "template_fn": _template_lead_scoring,
        "build_prompt": lambda p: (
            "给以下潜在客户打分（0-100，B2B 丝网/围栏制造商视角），"
            "以 JSON 返回 {\"fit_score\": int, \"reasons\": [...]}。\n"
            f"线索：{json.dumps(p, ensure_ascii=False)}"),
        "parse": lambda t: json.loads(_extract_json(t)),
    },
    "opening_line": {
        "name": "开场白生成", "recommended_provider": "kimi",
        "template_fn": _template_opening_line,
        "build_prompt": lambda p: (
            "为外贸开发信生成一句个性化开场白（英文，50 词内，自然不套路），"
            "以 JSON 返回 {\"opening_line\": string}。\n"
            f"客户信息：{json.dumps(p, ensure_ascii=False)}"),
        "parse": lambda t: json.loads(_extract_json(t)),
    },
    "email_generation": {
        "name": "邮件生成", "recommended_provider": "kimi",
        "template_fn": _template_email_generation,
        "build_prompt": lambda p: (
            "生成一封外贸开发信，以 JSON 返回 {\"subject\": string, \"body\": string}。"
            "正文含 {{sender_name}} 等占位变量供后续替换。要求：简洁专业、突出工厂直供。\n"
            f"输入：{json.dumps(p, ensure_ascii=False)}"),
        "parse": lambda t: json.loads(_extract_json(t)),
    },
    "inquiry_classification": {
        "name": "询盘分类", "recommended_provider": "kimi",
        "template_fn": _template_inquiry_classification,
        "build_prompt": lambda p: (
            "给询盘打品类标签，以 JSON 返回 "
            "{\"category\": string, \"confidence\": \"high\"|\"low\", \"auto\": bool}。"
            "类别枚举：chain_link_fence / welded_mesh / gabion / temporary_fence / "
            "security_fence / farm_fence / other\n"
            f"询盘：{json.dumps(p, ensure_ascii=False)}"),
        "parse": lambda t: json.loads(_extract_json(t)),
    },
}


def _task_chain(primary: str) -> List[str]:
    chain = [primary]
    for p in ("deepseek", "kimi"):
        if p != primary:
            chain.append(p)
            break
    if "zhipu" != primary:
        chain.append("zhipu")
    return chain


async def _log_usage(conn, task_key: str, provider: Optional[str],
                     model: Optional[str], usage: dict, status: str,
                     error: Optional[str], latency_ms: int):
    await conn.execute(
        """INSERT INTO ai_usage
           (tenant_id, task_key, provider, model, prompt_tokens, completion_tokens,
            status, error, latency_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)""",
        DEFAULT_TENANT, task_key, provider, model,
        usage.get("prompt_tokens"), usage.get("completion_tokens"),
        status, error, latency_ms)


async def run_ai_task(conn, task_key: str, payload: dict) -> dict:
    """执行任务：绑定关→模板；启用→fallback 链；全程落 usage。"""
    if task_key not in TASKS:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "UNKNOWN_TASK", "task_key": task_key})
    task = TASKS[task_key]
    binding = await conn.fetchrow(
        "SELECT * FROM ai_task_bindings WHERE tenant_id=$1 AND task_key=$2",
        DEFAULT_TENANT, task_key)

    if binding is None or not binding["enabled"]:
        started = time.perf_counter()
        result = task["template_fn"](payload)
        await _log_usage(conn, task_key, None, None, {}, "template_only", None,
                         int((time.perf_counter() - started) * 1000))
        return {"result": result, "path": "template", "task": task_key}

    primary = binding["provider"] or task["recommended_provider"]
    prov_rows = await conn.fetch(
        "SELECT * FROM ai_providers WHERE tenant_id=$1", DEFAULT_TENANT)
    providers = {r["provider"]: r for r in prov_rows}

    for provider_name in _task_chain(primary):
        prov = providers.get(provider_name)
        if prov is None or not prov["enabled"] or not prov["api_key"]:
            continue
        defaults = PROVIDER_DEFAULTS.get(provider_name, {})
        base_url = prov["base_url"] or defaults.get("base_url", "")
        model = binding["model"] or prov["model"] or defaults.get("model", "")
        started = time.perf_counter()
        try:
            content, usage = await _openai_chat(
                base_url, prov["api_key"], model,
                [{"role": "user", "content": task["build_prompt"](payload)}],
                json_mode=True)
            result = task["parse"](content)
            latency = int((time.perf_counter() - started) * 1000)
            await _log_usage(conn, task_key, provider_name, model, usage,
                             "success", None, latency)
            return {"result": result, "path": f"ai:{provider_name}",
                    "task": task_key, "latency_ms": latency}
        except Exception as e:
            latency = int((time.perf_counter() - started) * 1000)
            await _log_usage(conn, task_key, provider_name, model, {},
                             "failed", str(e)[:500], latency)

    started = time.perf_counter()
    result = task["template_fn"](payload)
    await _log_usage(conn, task_key, None, None, {}, "template_only",
                     "all_providers_failed",
                     int((time.perf_counter() - started) * 1000))
    return {"result": result, "path": "template", "task": task_key,
            "note": "all_providers_failed"}


# ── AI 端点 ────────────────────────────────────────────────────────────────
class ProviderUpsert(BaseModel):
    api_key: Optional[str] = None   # None=keep, ""=clear
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


@app.get("/api/v1/ai/tasks")
async def ai_tasks():
    return {"items": [
        {"task_key": k, "name": v["name"],
         "recommended_provider": v["recommended_provider"]}
        for k, v in TASKS.items()]}


async def _get_or_create_provider(conn, name: str):
    row = await conn.fetchrow(
        "SELECT * FROM ai_providers WHERE tenant_id=$1 AND provider=$2",
        DEFAULT_TENANT, name)
    if row is None:
        row = await conn.fetchrow(
            """INSERT INTO ai_providers (tenant_id, provider, enabled)
               VALUES ($1,$2,false) RETURNING *""", DEFAULT_TENANT, name)
    return row


def _row_to_provider(p) -> dict:
    return {
        "provider": p["provider"], "api_key_masked": _mask(p["api_key"]),
        "has_key": bool(p["api_key"]), "model": p["model"],
        "base_url": p["base_url"], "enabled": p["enabled"],
        "default_model": PROVIDER_DEFAULTS.get(p["provider"], {}).get("model"),
        "default_base_url": PROVIDER_DEFAULTS.get(p["provider"], {}).get("base_url"),
    }


@app.get("/api/v1/ai/providers")
async def ai_list_providers(request: Request, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            "SELECT * FROM ai_providers WHERE tenant_id=$1", DEFAULT_TENANT)
    existing = {r["provider"]: r for r in rows}
    return {"items": [
        _row_to_provider(existing[n]) if n in existing else {
            "provider": n, "api_key_masked": None, "has_key": False,
            "model": None, "base_url": None, "enabled": False,
            "default_model": PROVIDER_DEFAULTS[n]["model"],
            "default_base_url": PROVIDER_DEFAULTS[n]["base_url"]}
        for n in PROVIDER_DEFAULTS]}


@app.put("/api/v1/ai/providers/{name}")
async def ai_upsert_provider(name: str, body: ProviderUpsert,
                             request: Request, user: dict = Depends(_get_current_user)):
    if name not in PROVIDER_DEFAULTS:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "BAD_PROVIDER", "allowed": list(PROVIDER_DEFAULTS)})
    async with _acquire(request) as conn:
        p = await _get_or_create_provider(conn, name)
        await conn.execute(
            """UPDATE ai_providers SET
                 api_key = COALESCE($2, api_key),
                 model   = CASE WHEN $3 THEN NULLIF($4,'') ELSE model END,
                 base_url= CASE WHEN $5 THEN NULLIF($6,'') ELSE base_url END,
                 enabled = COALESCE($7, enabled),
                 updated_at = NOW()
               WHERE tenant_id=$1 AND provider=$8 RETURNING *""",
            DEFAULT_TENANT,
            None if body.api_key is None else (body.api_key or None),
            body.model is not None, body.model or "",
            body.base_url is not None, body.base_url or "",
            body.enabled, name)
        row = await conn.fetchrow(
            "SELECT * FROM ai_providers WHERE tenant_id=$1 AND provider=$2",
            DEFAULT_TENANT, name)
    return _row_to_provider(row)


@app.post("/api/v1/ai/providers/{name}/test")
async def ai_test_provider(name: str, request: Request, user: dict = Depends(_get_current_user)):
    if name not in PROVIDER_DEFAULTS:
        raise HTTPException(status_code=422, detail={"error": "validation", "code": "BAD_PROVIDER"})
    async with _acquire(request) as conn:
        p = await _get_or_create_provider(conn, name)
        if not p["api_key"]:
            raise HTTPException(status_code=400, detail={
                "error": "bad_request", "code": "NO_API_KEY"})
        defaults = PROVIDER_DEFAULTS[name]
        started = time.perf_counter()
        try:
            content, usage = await _openai_chat(
                p["base_url"] or defaults["base_url"], p["api_key"],
                p["model"] or defaults["model"],
                [{"role": "user", "content": "Reply with exactly: ok"}],
                max_tokens=10, temperature=0)
            return {"ok": True,
                    "latency_ms": int((time.perf_counter() - started) * 1000),
                    "reply": content[:100], "usage": usage}
        except Exception as e:
            return {"ok": False,
                    "latency_ms": int((time.perf_counter() - started) * 1000),
                    "error": str(e)[:500]}


@app.get("/api/v1/ai/task-bindings")
async def ai_list_bindings(request: Request, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            "SELECT * FROM ai_task_bindings WHERE tenant_id=$1", DEFAULT_TENANT)
    existing = {r["task_key"]: r for r in rows}
    items = []
    for k, v in TASKS.items():
        if k in existing:
            b = dict(existing[k])
            b["use_ai"] = b["enabled"]
            items.append(b)
        else:
            items.append({"task_key": k, "provider": v["recommended_provider"],
                          "model": None, "enabled": False, "config": None,
                          "use_ai": False})
    return {"items": items}


@app.put("/api/v1/ai/task-bindings/{task_key}")
async def ai_upsert_binding(task_key: str, body: BindingUpsert,
                            request: Request, user: dict = Depends(_get_current_user)):
    if task_key not in TASKS:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "UNKNOWN_TASK"})
    async with _acquire(request) as conn:
        row = await conn.fetchrow(
            "SELECT id FROM ai_task_bindings WHERE tenant_id=$1 AND task_key=$2",
            DEFAULT_TENANT, task_key)
        if row is None:
            await conn.execute(
                """INSERT INTO ai_task_bindings (tenant_id, task_key, provider, enabled)
                   VALUES ($1,$2,$3,false)""",
                DEFAULT_TENANT, task_key, TASKS[task_key]["recommended_provider"])
        await conn.execute(
            """UPDATE ai_task_bindings SET
                 provider = COALESCE($3, provider),
                 model    = CASE WHEN $4 THEN NULLIF($5,'') ELSE model END,
                 enabled  = COALESCE($6, enabled),
                 config   = COALESCE($7::jsonb, config),
                 updated_at = NOW()
               WHERE tenant_id=$1 AND task_key=$2""",
            DEFAULT_TENANT, task_key,
            body.provider, body.model is not None, body.model or "",
            body.enabled,
            json.dumps(body.config) if body.config is not None else None)
        b = await conn.fetchrow(
            "SELECT * FROM ai_task_bindings WHERE tenant_id=$1 AND task_key=$2",
            DEFAULT_TENANT, task_key)
    out = dict(b)
    out["use_ai"] = out["enabled"]
    return out


@app.get("/api/v1/ai/usage")
async def ai_usage(request: Request, user: dict = Depends(_get_current_user),
                   task_key: Optional[str] = None,
                   provider: Optional[str] = None,
                   status: Optional[str] = None,
                   page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=200)):
    where = ["tenant_id = $1"]
    params: list = [DEFAULT_TENANT]
    idx = 2
    for col, val in (("task_key", task_key), ("provider", provider), ("status", status)):
        if val:
            where.append(f"{col} = ${idx}")
            params.append(val)
            idx += 1
    where_sql = " AND ".join(where)
    async with _acquire(request) as conn:
        total = await conn.fetchval(f"SELECT COUNT(*) FROM ai_usage WHERE {where_sql}", *params)
        rows = await conn.fetch(
            f"""SELECT id, task_key, provider, model, prompt_tokens, completion_tokens,
                       cost_usd, status, error, latency_ms, created_at
                FROM ai_usage WHERE {where_sql}
                ORDER BY created_at DESC LIMIT ${idx} OFFSET ${idx+1}""",
            *params, page_size, (page - 1) * page_size)
        stats = await conn.fetch(
            """SELECT task_key, provider, status, COUNT(*) AS cnt,
                      COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
                      COALESCE(SUM(completion_tokens),0) AS completion_tokens
               FROM ai_usage WHERE tenant_id=$1
               GROUP BY task_key, provider, status""",
            DEFAULT_TENANT)
    return {"items": [dict(r) for r in rows], "total": total,
            "page": page, "page_size": page_size,
            "stats": [{"task_key": s["task_key"], "provider": s["provider"],
                       "status": s["status"], "count": s["cnt"],
                       "prompt_tokens": s["prompt_tokens"],
                       "completion_tokens": s["completion_tokens"]}
                      for s in stats]}


@app.post("/api/v1/ai/tasks/{task_key}/run")
async def ai_run_task(task_key: str, body: TaskRun,
                      request: Request, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        return await run_ai_task(conn, task_key, body.payload)


# ═══════════════════════════════════════════════════════════════════
# 开发工位 + 线索池（P2/P3）
# ═══════════════════════════════════════════════════════════════════
REGIONS = [
    {"code": "US-TX", "name": "Texas, USA"}, {"code": "US-CA", "name": "California, USA"},
    {"code": "US-FL", "name": "Florida, USA"}, {"code": "US-NY", "name": "New York, USA"},
    {"code": "CA-ON", "name": "Ontario, Canada"}, {"code": "AU-NSW", "name": "NSW, Australia"},
    {"code": "GB-ENG", "name": "England, UK"}, {"code": "DE-NW", "name": "NRW, Germany"},
    {"code": "FR-IDF", "name": "Île-de-France, France"}, {"code": "AE-DU", "name": "Dubai, UAE"},
    {"code": "SA-RD", "name": "Riyadh, Saudi Arabia"}, {"code": "ZA-GP", "name": "Gauteng, South Africa"},
    {"code": "BR-SP", "name": "São Paulo, Brazil"}, {"code": "MX-CMX", "name": "CDMX, Mexico"},
]

DEMO_DATASET = [
    ("Lone Star Fence Co", "US", "Texas", "Houston", "fencing contractor"),
    ("Gulf Coast Wire Mesh", "US", "Texas", "Galveston", "wire mesh distributor"),
    ("SunState Fencing", "US", "Florida", "Orlando", "fence installation"),
    ("Pacific Mesh Supply", "US", "California", "Fresno", "industrial mesh supplier"),
    ("Maple Fence Pro", "CA", "Ontario", "Toronto", "fence contractor"),
    ("Outback Fencing Pty", "AU", "NSW", "Newcastle", "rural fencing"),
    ("Thames Garden Fence", "GB", "England", "Reading", "garden fencing retail"),
    ("Rheinland Zaunbau", "DE", "NRW", "Düsseldorf", "zaunbau contractor"),
    ("Desert Fence LLC", "AE", "Dubai", "Dubai", "fencing supplier"),
    ("Muro Seguro SA", "MX", "CDMX", "Mexico City", "construction materials"),
    ("Highveld Fence Works", "ZA", "Gauteng", "Pretoria", "security fencing"),
    ("Samba Alambrado", "BR", "São Paulo", "Campinas", "alambrado distributor"),
]


def _fetch_demo(config: dict) -> List[dict]:
    industry = (config.get("industry") or "").lower()
    qty = min(int(config.get("quantity") or 10), len(DEMO_DATASET))
    region = (config.get("region") or "").upper()
    leads = []
    for i, (name, country, region_name, city, ind) in enumerate(DEMO_DATASET):
        if region and region_name.upper() not in region and region.split("-")[-1] not in region_name.upper():
            continue
        slug = name.lower().replace(" ", "")
        leads.append({
            "place_id": f"demo-{i:04d}", "company_name": name, "country": country,
            "region": region_name, "city": city,
            "industry": industry or ind, "source": "demo",
            "email": f"contact@{slug}.example.com",
            "website": f"https://{slug}.example.com",
            "google_rating": round(3.5 + (i % 15) / 10, 1),
            "google_reviews": 10 + i * 7,
            "raw": {"demo": True, "dataset_index": i},
        })
        if len(leads) >= qty:
            break
    return leads


def _fetch_csv(content: bytes) -> List[dict]:
    text = content.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    required = {"company_name", "country"}
    if not reader.fieldnames or not required.issubset({f.strip().lower() for f in reader.fieldnames}):
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "BAD_CSV",
            "detail": f"CSV needs columns: {sorted(required)} (optional: region/city/email/website/industry/place_id)"})
    leads = []
    for row in reader:
        low = {k.strip().lower(): (v or "").strip() for k, v in row.items() if k}
        leads.append({
            "place_id": low.get("place_id") or None,
            "company_name": low["company_name"], "country": low.get("country") or None,
            "region": low.get("region") or None, "city": low.get("city") or None,
            "address": low.get("address") or None, "phone": low.get("phone") or None,
            "website": low.get("website") or None, "email": low.get("email") or None,
            "industry": low.get("industry") or None, "source": "csv",
            "raw": {"csv_row": low},
        })
    return leads


def _hard_filter(raw: List[dict]) -> List[dict]:
    seen, kept = set(), []
    for lead in raw:
        key = re.sub(r"\s+", " ", (lead.get("company_name") or "").strip().lower())
        if not key or key in seen:
            continue
        seen.add(key)
        kept.append(lead)
    return kept


async def _run_pipeline(conn, run_id: int, config: dict, csv_content: Optional[bytes],
                        created_by: str) -> None:
    """抓取 → 硬过滤 → AI 评分/开场白（可关，落 usage）→ 幂等写池。Worker 内联执行。"""
    try:
        if config["source"] == "demo":
            raw = _fetch_demo(config)
        elif config["source"] == "csv":
            raw = _fetch_csv(csv_content or b"")
        else:
            raise ValueError(f"未知抓取源：{config['source']}")
        kept = _hard_filter(raw)
        inserted = 0
        for lead in kept:
            score = await run_ai_task(conn, "lead_scoring", lead)
            s = score["result"]
            lead["fit_score"] = s.get("fit_score")
            lead["fit_reasons"] = s.get("reasons")
            opening = await run_ai_task(conn, "opening_line", lead)
            lead["opening_line"] = opening["result"].get("opening_line")
            row = await conn.fetchrow(
                """INSERT INTO lead_candidates
                   (tenant_id, place_id, company_name, country, region, city, address,
                    phone, website, email, industry, source, google_rating, google_reviews,
                    fit_score, fit_reasons, opening_line, leadgen_run_id, raw,
                    owner_id, owner_scope)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'tenant')
                   ON CONFLICT (tenant_id, place_id) DO NOTHING RETURNING id""",
                DEFAULT_TENANT, lead.get("place_id"), lead["company_name"],
                lead.get("country"), lead.get("region"), lead.get("city"),
                lead.get("address"), lead.get("phone"), lead.get("website"),
                lead.get("email"), lead.get("industry"), lead.get("source"),
                lead.get("google_rating"), lead.get("google_reviews"),
                lead.get("fit_score"),
                json.dumps(lead.get("fit_reasons")) if lead.get("fit_reasons") is not None else None,
                lead.get("opening_line"),
                run_id,
                json.dumps(lead.get("raw")) if lead.get("raw") is not None else None,
                created_by)
            if row is not None:
                inserted += 1
        await conn.execute(
            """UPDATE leadgen_runs SET status='succeeded', leads_found=$2,
               leads_kept=$3, finished_at=NOW() WHERE id=$1""",
            run_id, len(raw), inserted)
    except Exception as e:
        await conn.execute(
            """UPDATE leadgen_runs SET status='failed', error=$2, finished_at=NOW()
               WHERE id=$1""", run_id, str(e)[:1000])


class LeadgenConfig(BaseModel):
    region: str
    industry: str
    icp: Optional[str] = None
    quantity: int = 10
    source: str = "demo"


@app.get("/api/v1/leadgen/regions")
async def leadgen_regions(request: Request, user: dict = Depends(_get_current_user)):
    return {"items": [r["code"] for r in REGIONS], "regions": REGIONS}


@app.post("/api/v1/leadgen/validate")
async def leadgen_validate(body: LeadgenConfig, request: Request,
                           user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        await _require_sub(conn, "leadgen")
        return await run_ai_task(conn, "config_validation", body.model_dump())


async def _create_run_common(request, config: dict, csv_content: Optional[bytes],
                             created_by: str):
    if config.get("source") == "csv" and csv_content is None:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "CSV_REQUIRED",
            "detail": "source=csv 需上传 CSV 文件（POST /leadgen/runs/from-csv）"})
    config_hash = hashlib.sha256(
        repr(sorted(config.items())).encode()).hexdigest()[:32]
    async with _acquire(request) as conn:
        await _require_sub(conn, "leadgen")
        existing = await conn.fetchrow(
            """SELECT * FROM leadgen_runs
               WHERE tenant_id=$1 AND config_hash=$2""",
            DEFAULT_TENANT, config_hash)
        if existing is not None:
            return {"id": existing["id"], "status": existing["status"],
                    "leads_found": existing["leads_found"],
                    "leads_kept": existing["leads_kept"],
                    "error": existing["error"], "deduplicated": True}
        run = await conn.fetchrow(
            """INSERT INTO leadgen_runs (tenant_id, config, config_hash, status, started_at, created_by)
               VALUES ($1,$2,$3,'running',NOW(),$4) RETURNING id""",
            DEFAULT_TENANT, json.dumps(config), config_hash, created_by)
        await _run_pipeline(conn, run["id"], config, csv_content, created_by)
        final = await conn.fetchrow("SELECT * FROM leadgen_runs WHERE id=$1", run["id"])
    return {"id": final["id"], "status": final["status"],
            "config_hash": config_hash, "leads_found": final["leads_found"],
            "leads_kept": final["leads_kept"], "error": final["error"],
            "deduplicated": False}


@app.post("/api/v1/leadgen/runs", status_code=201)
async def leadgen_create_run(body: LeadgenConfig, request: Request,
                             user: dict = Depends(_get_current_user)):
    return await _create_run_common(request, body.model_dump(), None, str(user["id"]))


@app.post("/api/v1/leadgen/runs/from-csv", status_code=201)
async def leadgen_create_run_csv(request: Request, csv_file: UploadFile = File(...),
                                 user: dict = Depends(_get_current_user)):
    content = await csv_file.read()
    config = {"region": "", "industry": "", "icp": None, "quantity": 0,
              "source": "csv", "filename": csv_file.filename or "leads.csv"}
    return await _create_run_common(request, config, content, str(user["id"]))


@app.get("/api/v1/leadgen/runs")
async def leadgen_list_runs(request: Request, user: dict = Depends(_get_current_user),
                            page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100)):
    async with _acquire(request) as conn:
        await _require_sub(conn, "leadgen")
        total = await conn.fetchval(
            "SELECT COUNT(*) FROM leadgen_runs WHERE tenant_id=$1", DEFAULT_TENANT)
        rows = await conn.fetch(
            """SELECT id, config, config_hash, status, leads_found, leads_kept,
                      error, started_at, finished_at, created_by, created_at
               FROM leadgen_runs WHERE tenant_id=$1
               ORDER BY id DESC LIMIT $2 OFFSET $3""",
            DEFAULT_TENANT, page_size, (page - 1) * page_size)
    return {"items": [_row_to_dict(r, "leadgen_runs") for r in rows],
            "total": total, "page": page, "page_size": page_size}


@app.get("/api/v1/leadgen/runs/{run_id}")
async def leadgen_get_run(run_id: int, request: Request,
                          user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        await _require_sub(conn, "leadgen")
        run = await conn.fetchrow(
            "SELECT * FROM leadgen_runs WHERE id=$1 AND tenant_id=$2",
            run_id, DEFAULT_TENANT)
        if not run:
            raise HTTPException(status_code=404, detail={"error": "not_found", "code": "RUN_NOT_FOUND"})
        leads = await conn.fetch(
            """SELECT id, place_id, company_name, country, city, fit_score, created_at
               FROM lead_candidates WHERE leadgen_run_id=$1 ORDER BY fit_score DESC NULLS LAST""",
            run_id)
    return {**_row_to_dict(run, "leadgen_runs"), "leads": [dict(l) for l in leads]}


def _row_to_lead(l: dict) -> dict:
    d = _row_to_dict(l, "lead_candidates")
    d.pop("raw", None)
    # P6 商情预留：数据接入前恒为 null（§5.5 接口返回 null 字段）
    d["demand_index"] = None
    d["blank_index"] = None
    return d


class LeadCreate(BaseModel):
    company_name: str
    country: Optional[str] = None
    region: Optional[str] = None
    city: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    email: Optional[str] = None
    industry: Optional[str] = None
    place_id: Optional[str] = None
    opening_line: Optional[str] = None


@app.post("/api/v1/leads", status_code=201)
async def lead_create(body: LeadCreate, request: Request,
                      user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        await _require_sub(conn, "leadgen")
        place_id = body.place_id or f"manual-{hashlib.sha256(body.company_name.encode()).hexdigest()[:16]}"
        existing = await conn.fetchrow(
            "SELECT id FROM lead_candidates WHERE tenant_id=$1 AND place_id=$2",
            DEFAULT_TENANT, place_id)
        if existing:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "DUPLICATE_PLACE"})
        row = await conn.fetchrow(
            """INSERT INTO lead_candidates
               (tenant_id, place_id, company_name, country, region, city, address,
                phone, website, email, industry, source, opening_line, owner_id, owner_scope)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual',$12,$13,'tenant')
               RETURNING *""",
            DEFAULT_TENANT, place_id, body.company_name, body.country, body.region,
            body.city, body.address, body.phone, body.website, body.email,
            body.industry, body.opening_line, str(user["id"]))
    return _row_to_lead(dict(row))


@app.get("/api/v1/leads")
async def lead_list(request: Request, user: dict = Depends(_get_current_user),
                    outreach_status: Optional[str] = None,
                    inquiry_status: Optional[str] = None,
                    search: Optional[str] = None,
                    min_score: Optional[int] = Query(None, ge=0, le=100),
                    sort: str = Query("score", pattern="^(score|recent|name)$"),
                    page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=200)):
    where = ["tenant_id = $1"]
    params: list = [DEFAULT_TENANT]
    idx = 2
    if outreach_status:
        where.append(f"outreach_status = ${idx}"); params.append(outreach_status); idx += 1
    if inquiry_status:
        where.append(f"inquiry_status = ${idx}"); params.append(inquiry_status); idx += 1
    if search:
        where.append(f"company_name ILIKE ${idx}"); params.append(f"%{search}%"); idx += 1
    if min_score is not None:
        where.append(f"fit_score >= ${idx}"); params.append(min_score); idx += 1
    where_sql = " AND ".join(where)
    order_sql = {"recent": "created_at DESC", "name": "company_name ASC"}.get(
        sort, "fit_score DESC NULLS LAST, created_at DESC")
    async with _acquire(request) as conn:
        await _require_sub(conn, "leadgen")
        total = await conn.fetchval(f"SELECT COUNT(*) FROM lead_candidates WHERE {where_sql}", *params)
        rows = await conn.fetch(
            f"""SELECT * FROM lead_candidates WHERE {where_sql}
                ORDER BY {order_sql} LIMIT ${idx} OFFSET ${idx+1}""",
            *params, page_size, (page - 1) * page_size)
    return {"items": [_row_to_lead(r) for r in rows], "total": total,
            "page": page, "page_size": page_size}


@app.post("/api/v1/leads/scan-replied")
async def lead_scan_replied(request: Request, user: dict = Depends(_get_current_user)):
    """触达工位回写 replied → 生成询盘（幂等：lead 只转化一次）。Worker 无调度器，手动触发。"""
    async with _acquire(request) as conn:
        await _require_sub(conn, "leadgen")
        leads = await conn.fetch(
            """SELECT * FROM lead_candidates
               WHERE tenant_id=$1 AND outreach_status='replied' AND inquiry_status='none'
               ORDER BY id LIMIT 100""",
            DEFAULT_TENANT)
        created, existing = 0, 0
        for lead in leads:
            already = await conn.fetchval(
                "SELECT 1 FROM cust_inquiries WHERE tenant_id=$1 AND lead_id=$2",
                DEFAULT_TENANT, lead["id"])
            if already:
                existing += 1
                continue
            cust = await conn.fetchrow(
                "SELECT id FROM cust_customers WHERE tenant_id=$1 AND company_name=$2",
                DEFAULT_TENANT, lead["company_name"])
            if cust is None:
                cust = await conn.fetchrow(
                    """INSERT INTO cust_customers
                       (tenant_id, company_name, country, address, stage, owner_id, owner_scope)
                       VALUES ($1,$2,$3,$4,'inquiry',$5,'tenant') RETURNING id""",
                    DEFAULT_TENANT, lead["company_name"], lead["country"],
                    lead["address"], lead["owner_id"] or str(user["id"]))
            await conn.execute(
                """INSERT INTO cust_inquiries
                   (tenant_id, customer_id, lead_id, channel, notes, status, owner_id, owner_scope)
                   VALUES ($1,$2,$3,'email',$4,'open',$5,'tenant')""",
                DEFAULT_TENANT, cust["id"], lead["id"],
                f"来自线索池触达回复（lead#{lead['id']}）",
                lead["owner_id"] or str(user["id"]))
            await conn.execute(
                """UPDATE lead_candidates SET inquiry_status='new', updated_at=NOW()
                   WHERE tenant_id=$1 AND id=$2""",
                DEFAULT_TENANT, lead["id"])
            created += 1
    return {"scanned": len(leads), "created": created, "already_linked": existing}


@app.get("/api/v1/leads/{lead_id}")
async def lead_get(lead_id: int, request: Request, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        await _require_sub(conn, "leadgen")
        lead = await conn.fetchrow(
            "SELECT * FROM lead_candidates WHERE id=$1 AND tenant_id=$2",
            lead_id, DEFAULT_TENANT)
        if not lead:
            raise HTTPException(status_code=404, detail={"error": "not_found", "code": "LEAD_NOT_FOUND"})
        messages = await conn.fetch(
            """SELECT id, subject, status, error, sent_at FROM outreach_messages
               WHERE tenant_id=$1 AND lead_id=$2 ORDER BY created_at DESC""",
            DEFAULT_TENANT, lead_id)
        inquiries = await conn.fetch(
            """SELECT id, status, channel, created_at FROM cust_inquiries
               WHERE tenant_id=$1 AND lead_id=$2 ORDER BY created_at DESC""",
            DEFAULT_TENANT, lead_id)
    return {**_row_to_lead(lead),
            "outreach_history": [dict(m) for m in messages],
            "inquiry_history": [dict(i) for i in inquiries]}


class LeadPatch(BaseModel):
    company_name: Optional[str] = None
    email: Optional[str] = None
    website: Optional[str] = None
    phone: Optional[str] = None
    industry: Optional[str] = None
    fit_score: Optional[int] = None
    opening_line: Optional[str] = None
    notes_raw: Optional[dict] = None     # 合并入 raw 字段
    owner_scope: Optional[str] = None


@app.patch("/api/v1/leads/{lead_id}")
async def lead_patch(lead_id: int, body: LeadPatch, request: Request,
                     user: dict = Depends(_get_current_user)):
    """线索池 owner=开发工位。outreach_status / inquiry_status 是其他工位
    的写入接口，本端点拒绝修改（跨工位禁止写，§不变量）。"""
    async with _acquire(request) as conn:
        await _require_sub(conn, "leadgen")
        lead = await conn.fetchrow(
            "SELECT * FROM lead_candidates WHERE id=$1 AND tenant_id=$2",
            lead_id, DEFAULT_TENANT)
        if not lead:
            raise HTTPException(status_code=404, detail={"error": "not_found", "code": "LEAD_NOT_FOUND"})
        fields = body.model_dump(exclude_none=True)
        sets, params = [], [DEFAULT_TENANT, lead_id]
        for k in ("company_name", "email", "website", "phone", "industry",
                  "fit_score", "opening_line", "owner_scope"):
            if k in fields:
                params.append(fields[k])
                sets.append(f"{k} = ${len(params)}")
        if fields.get("notes_raw") is not None:
            raw_val = lead["raw"]
            if isinstance(raw_val, str):
                try:
                    raw_val = json.loads(raw_val)
                except Exception:
                    raw_val = {}
            merged = dict(raw_val or {})
            merged.update(fields["notes_raw"])
            params.append(json.dumps(merged))
            sets.append(f"raw = ${len(params)}")
        if sets:
            await conn.execute(
                f"""UPDATE lead_candidates SET {', '.join(sets)}, updated_at=NOW()
                    WHERE tenant_id=$1 AND id=$2""",
                *params)
        row = await conn.fetchrow(
            "SELECT * FROM lead_candidates WHERE id=$1 AND tenant_id=$2",
            lead_id, DEFAULT_TENANT)
    return _row_to_lead(row)


# ═══════════════════════════════════════════════════════════════════
# 触达工位（P4）— Resend 出站；inbound webhook 501 预留
# ═══════════════════════════════════════════════════════════════════
def render_template(template: str, variables: dict) -> str:
    return VAR_RE.sub(lambda m: str(variables.get(m.group(1)) or ""), template)


def _lead_variables(lead: dict, mailbox: dict) -> dict:
    return {
        "name": lead.get("company_name") or "",
        "company": lead.get("company_name") or "",
        "city": lead.get("city") or "",
        "country": lead.get("country") or "",
        "region": lead.get("region") or "",
        "opening_line": lead.get("opening_line") or "",
        "sender_name": (mailbox or {}).get("name") or "",
    }


async def _resolve_api_key(mailbox: dict) -> Optional[str]:
    return mailbox.get("api_key") or os.environ.get("RESEND_API_KEY")


async def _send_one(conn, msg: dict, mailbox: dict) -> dict:
    """经 Resend 发送单封；状态/计数/线索 outreach_status 回写。"""
    api_key = await _resolve_api_key(mailbox)
    if not api_key:
        err = "未配置 Resend API Key（邮箱 api_key 或环境变量 RESEND_API_KEY）"
        await conn.execute(
            """UPDATE outreach_messages SET status='failed', error=$3
               WHERE id=$1 AND tenant_id=$2""", msg["id"], DEFAULT_TENANT, err)
        return {"status": "failed", "error": err}
    today = date.today()
    sent_today = mailbox["sent_today"] or 0
    if mailbox["last_sent_date"] and mailbox["last_sent_date"].date() != today:
        sent_today = 0
    if mailbox["daily_limit"] is not None and sent_today >= mailbox["daily_limit"]:
        err = f"超出每日限额 {mailbox['daily_limit']}"
        await conn.execute(
            """UPDATE outreach_messages SET status='failed', error=$3
               WHERE id=$1 AND tenant_id=$2""", msg["id"], DEFAULT_TENANT, err)
        return {"status": "failed", "error": err}
    try:
        status, text = await _http_post_json(
            RESEND_API_URL, {"Authorization": f"Bearer {api_key}"},
            {"from": f"{mailbox['name'] or mailbox['email']} <{mailbox['email']}>",
             "to": [msg["to_email"]], "subject": msg["subject"],
             "text": msg["body_rendered"]})
        if status not in (200, 201):
            raise RuntimeError(f"HTTP {status}: {text[:300]}")
        data = json.loads(text)
        await conn.execute(
            """UPDATE outreach_messages SET status='sent', resend_message_id=$3,
               sent_at=NOW(), error=NULL WHERE id=$1 AND tenant_id=$2""",
            msg["id"], DEFAULT_TENANT, data.get("id"))
        await conn.execute(
            """UPDATE outreach_mailboxes SET sent_today=COALESCE($3,0)+1,
               last_sent_date=$4 WHERE id=$1 AND tenant_id=$2""",
            mailbox["id"], DEFAULT_TENANT, sent_today, today)
        if msg.get("lead_id"):
            await conn.execute(
                """UPDATE lead_candidates SET outreach_status='sent', updated_at=NOW()
                   WHERE tenant_id=$1 AND id=$2""",
                DEFAULT_TENANT, msg["lead_id"])
        return {"status": "sent"}
    except Exception as e:
        err = str(e)[:500]
        await conn.execute(
            """UPDATE outreach_messages SET status='failed', error=$3
               WHERE id=$1 AND tenant_id=$2""", msg["id"], DEFAULT_TENANT, err)
        return {"status": "failed", "error": err}


class MailboxCreate(BaseModel):
    email: str
    name: Optional[str] = None
    api_key: Optional[str] = None
    is_default: bool = False
    daily_limit: Optional[int] = None


class MailboxPatch(BaseModel):
    name: Optional[str] = None
    api_key: Optional[str] = None
    is_default: Optional[bool] = None
    daily_limit: Optional[int] = None
    enabled: Optional[bool] = None


def _row_to_mailbox(m) -> dict:
    return {
        "id": m["id"], "email": m["email"], "name": m["name"],
        "provider": m["provider"], "api_key_masked": _mask(m["api_key"]),
        "has_own_key": bool(m["api_key"]), "is_default": m["is_default"],
        "daily_limit": m["daily_limit"], "sent_today": m["sent_today"],
        "last_sent_date": m["last_sent_date"].isoformat() if m["last_sent_date"] else None,
        "enabled": m["enabled"],
    }


@app.get("/api/v1/outreach/mailboxes")
async def mb_list(request: Request, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        await _require_sub(conn, "outreach")
        rows = await conn.fetch(
            """SELECT * FROM outreach_mailboxes WHERE tenant_id=$1
               ORDER BY is_default DESC, created_at""", DEFAULT_TENANT)
    return {"items": [_row_to_mailbox(r) for r in rows], "total": len(rows)}


@app.post("/api/v1/outreach/mailboxes", status_code=201)
async def mb_create(body: MailboxCreate, request: Request,
                    user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        await _require_sub(conn, "outreach")
        existing = await conn.fetchrow(
            "SELECT id FROM outreach_mailboxes WHERE tenant_id=$1 AND email=$2",
            DEFAULT_TENANT, body.email)
        if existing:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "DUPLICATE_MAILBOX"})
        if body.is_default:  # 先清旧默认再插新行（避免新行被一起刷掉）
            await conn.execute(
                "UPDATE outreach_mailboxes SET is_default=false WHERE tenant_id=$1 AND is_default=true",
                DEFAULT_TENANT)
        row = await conn.fetchrow(
            """INSERT INTO outreach_mailboxes
               (tenant_id, email, name, api_key, is_default, daily_limit)
               VALUES ($1,$2,$3,$4,$5,$6) RETURNING *""",
            DEFAULT_TENANT, body.email, body.name, body.api_key,
            body.is_default, body.daily_limit)
    return _row_to_mailbox(row)


@app.patch("/api/v1/outreach/mailboxes/{mailbox_id}")
async def mb_patch(mailbox_id: int, body: MailboxPatch, request: Request,
                   user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        await _require_sub(conn, "outreach")
        m = await conn.fetchrow(
            "SELECT * FROM outreach_mailboxes WHERE id=$1 AND tenant_id=$2",
            mailbox_id, DEFAULT_TENANT)
        if not m:
            raise HTTPException(status_code=404, detail={"error": "not_found", "code": "MAILBOX_NOT_FOUND"})
        if body.name is not None:
            await conn.execute("UPDATE outreach_mailboxes SET name=$3 WHERE id=$1 AND tenant_id=$2",
                               mailbox_id, DEFAULT_TENANT, body.name)
        if body.api_key is not None:
            await conn.execute("UPDATE outreach_mailboxes SET api_key=$3 WHERE id=$1 AND tenant_id=$2",
                               mailbox_id, DEFAULT_TENANT, body.api_key or None)
        if body.daily_limit is not None:
            await conn.execute("UPDATE outreach_mailboxes SET daily_limit=$3 WHERE id=$1 AND tenant_id=$2",
                               mailbox_id, DEFAULT_TENANT, body.daily_limit)
        if body.enabled is not None:
            await conn.execute("UPDATE outreach_mailboxes SET enabled=$3 WHERE id=$1 AND tenant_id=$2",
                               mailbox_id, DEFAULT_TENANT, body.enabled)
        if body.is_default:
            await conn.execute(
                """UPDATE outreach_mailboxes SET is_default=false
                   WHERE tenant_id=$1 AND is_default=true AND id<>$2""",
                DEFAULT_TENANT, mailbox_id)
            await conn.execute("UPDATE outreach_mailboxes SET is_default=true WHERE id=$1", mailbox_id)
        row = await conn.fetchrow(
            "SELECT * FROM outreach_mailboxes WHERE id=$1", mailbox_id)
    return _row_to_mailbox(row)


@app.post("/api/v1/outreach/mailboxes/{mailbox_id}/test")
async def mb_test(mailbox_id: int, to: str, request: Request,
                  user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        await _require_sub(conn, "outreach")
        m = await conn.fetchrow(
            "SELECT * FROM outreach_mailboxes WHERE id=$1 AND tenant_id=$2",
            mailbox_id, DEFAULT_TENANT)
        if not m:
            raise HTTPException(status_code=404, detail={"error": "not_found", "code": "MAILBOX_NOT_FOUND"})
        api_key = await _resolve_api_key(m)
        if not api_key:
            return {"status": "failed",
                    "error": "未配置 Resend API Key（邮箱 api_key 或环境变量 RESEND_API_KEY）"}
        try:
            status, text = await _http_post_json(
                RESEND_API_URL, {"Authorization": f"Bearer {api_key}"},
                {"from": f"{m['name'] or m['email']} <{m['email']}>",
                 "to": [to], "subject": f"[KaaS] Mailbox test from {m['email']}",
                 "text": "This is a connectivity test email sent from the KaaS outreach workstation."})
            if status not in (200, 201):
                raise RuntimeError(f"HTTP {status}: {text[:300]}")
            return {"status": "sent", "resend_message_id": json.loads(text).get("id")}
        except Exception as e:
            return {"status": "failed", "error": str(e)[:500]}


class CampaignCreate(BaseModel):
    name: str
    subject_template: str
    body_template: str
    mailbox_id: Optional[int] = None


class CampaignSend(BaseModel):
    lead_ids: List[int]


@app.get("/api/v1/outreach/campaigns")
async def camp_list(request: Request, user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        await _require_sub(conn, "outreach")
        rows = await conn.fetch(
            "SELECT * FROM outreach_campaigns WHERE tenant_id=$1 ORDER BY id DESC",
            DEFAULT_TENANT)
    return {"items": [_row_to_dict(r, "outreach_campaigns") for r in rows]}


@app.post("/api/v1/outreach/campaigns", status_code=201)
async def camp_create(body: CampaignCreate, request: Request,
                      user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        await _require_sub(conn, "outreach")
        row = await conn.fetchrow(
            """INSERT INTO outreach_campaigns
               (tenant_id, name, subject_template, body_template, mailbox_id, status)
               VALUES ($1,$2,$3,$4,$5,'draft') RETURNING *""",
            DEFAULT_TENANT, body.name, body.subject_template,
            body.body_template, body.mailbox_id)
    return _row_to_dict(row, "outreach_campaigns")


@app.post("/api/v1/outreach/generate")
async def camp_generate(body: TaskRun, request: Request,
                        user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        await _require_sub(conn, "outreach")
        return await run_ai_task(conn, "email_generation", body.payload)


@app.post("/api/v1/outreach/campaigns/{campaign_id}/send")
async def camp_send(campaign_id: int, body: CampaignSend, request: Request,
                    user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        await _require_sub(conn, "outreach")
        c = await conn.fetchrow(
            "SELECT * FROM outreach_campaigns WHERE id=$1 AND tenant_id=$2",
            campaign_id, DEFAULT_TENANT)
        if not c:
            raise HTTPException(status_code=404, detail={"error": "not_found", "code": "CAMPAIGN_NOT_FOUND"})
        if c["status"] == "sending":
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "ALREADY_SENDING"})
        if c["mailbox_id"]:
            mailbox = await conn.fetchrow(
                "SELECT * FROM outreach_mailboxes WHERE id=$1 AND tenant_id=$2",
                c["mailbox_id"], DEFAULT_TENANT)
            if not mailbox:
                raise HTTPException(status_code=404, detail={"error": "not_found", "code": "MAILBOX_NOT_FOUND"})
            if not mailbox["enabled"]:
                raise HTTPException(status_code=409, detail={
                    "error": "conflict", "code": "MAILBOX_DISABLED"})
        else:
            mailbox = await conn.fetchrow(
                """SELECT * FROM outreach_mailboxes
                   WHERE tenant_id=$1 AND is_default=true AND enabled=true""",
                DEFAULT_TENANT)
            if mailbox is None:
                raise HTTPException(status_code=422, detail={
                    "error": "validation", "code": "NO_DEFAULT_MAILBOX"})
        leads = await conn.fetch(
            "SELECT * FROM lead_candidates WHERE tenant_id=$1 AND id = ANY($2)",
            DEFAULT_TENANT, body.lead_ids)
        if not leads:
            raise HTTPException(status_code=422, detail={
                "error": "validation", "code": "NO_LEADS"})
        message_ids = []
        for lead in leads:
            variables = _lead_variables(lead, mailbox)
            msg = await conn.fetchrow(
                """INSERT INTO outreach_messages
                   (tenant_id, campaign_id, lead_id, to_email, to_name, subject, body_rendered, status)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, status""",
                DEFAULT_TENANT, campaign_id, lead["id"], lead["email"] or "",
                lead["company_name"],
                render_template(c["subject_template"], variables),
                render_template(c["body_template"], variables),
                "failed" if not lead["email"] else "pending")
            message_ids.append(dict(msg))
        await conn.execute(
            """UPDATE outreach_campaigns SET status='sending', total_count=$3
               WHERE id=$1 AND tenant_id=$2""",
            campaign_id, DEFAULT_TENANT, len(message_ids))
        sent, failed = 0, 0
        for m in message_ids:
            if m["status"] == "failed":
                failed += 1
                continue
            claimed = await conn.fetchrow(
                """UPDATE outreach_messages SET status='sending' WHERE id=$1
                   AND tenant_id=$2 AND status='pending' RETURNING *""",
                m["id"], DEFAULT_TENANT)
            if claimed is None:
                continue  # 已被抢占（幂等防重复）
            result = await _send_one(conn, dict(claimed), mailbox)
            if result["status"] == "sent":
                sent += 1
            else:
                failed += 1
        await conn.execute(
            """UPDATE outreach_campaigns SET status='sent', sent_count=$3, failed_count=$4
               WHERE id=$1 AND tenant_id=$2""",
            campaign_id, DEFAULT_TENANT, sent, failed)
    return {"campaign_id": campaign_id, "total": len(message_ids),
            "sent": sent, "failed": failed}


@app.get("/api/v1/outreach/messages")
async def msg_list(request: Request, user: dict = Depends(_get_current_user),
                   campaign_id: Optional[int] = None,
                   lead_id: Optional[int] = None,
                   status: Optional[str] = None,
                   page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=200)):
    where = ["m.tenant_id = $1"]
    params: list = [DEFAULT_TENANT]
    idx = 2
    for col, val in (("m.campaign_id", campaign_id), ("m.lead_id", lead_id), ("m.status", status)):
        if val is not None:
            where.append(f"{col} = ${idx}"); params.append(val); idx += 1
    where_sql = " AND ".join(where)
    async with _acquire(request) as conn:
        await _require_sub(conn, "outreach")
        total = await conn.fetchval(f"SELECT COUNT(*) FROM outreach_messages m WHERE {where_sql}", *params)
        rows = await conn.fetch(
            f"""SELECT m.id, m.campaign_id, m.lead_id, m.to_email, m.to_name, m.subject,
                       m.status, m.error, m.sent_at, m.opened_at, m.replied_at, m.created_at,
                       l.company_name AS lead_company
                FROM outreach_messages m
                LEFT JOIN lead_candidates l ON l.id = m.lead_id AND l.tenant_id = m.tenant_id
                WHERE {where_sql}
                ORDER BY m.id DESC LIMIT ${idx} OFFSET ${idx+1}""",
            *params, page_size, (page - 1) * page_size)
    return {"items": [dict(r) for r in rows], "total": total,
            "page": page, "page_size": page_size}


@app.get("/api/v1/outreach/messages/{message_id}")
async def msg_get(message_id: int, request: Request,
                  user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        await _require_sub(conn, "outreach")
        row = await conn.fetchrow(
            "SELECT * FROM outreach_messages WHERE id=$1 AND tenant_id=$2",
            message_id, DEFAULT_TENANT)
        if not row:
            raise HTTPException(status_code=404, detail={"error": "not_found", "code": "MESSAGE_NOT_FOUND"})
    return dict(row)


@app.post("/api/v1/outreach/messages/{message_id}/retry")
async def msg_retry(message_id: int, request: Request,
                    user: dict = Depends(_get_current_user)):
    async with _acquire(request) as conn:
        await _require_sub(conn, "outreach")
        msg = await conn.fetchrow(
            "SELECT * FROM outreach_messages WHERE id=$1 AND tenant_id=$2",
            message_id, DEFAULT_TENANT)
        if not msg:
            raise HTTPException(status_code=404, detail={"error": "not_found", "code": "MESSAGE_NOT_FOUND"})
        if msg["status"] not in ("failed", "bounced"):
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "NOT_RETRYABLE",
                "detail": "仅 failed/bounced 可重发"})
        if msg["campaign_id"]:
            c = await conn.fetchrow(
                "SELECT * FROM outreach_campaigns WHERE id=$1 AND tenant_id=$2",
                msg["campaign_id"], DEFAULT_TENANT)
        else:
            c = None
        if c and c["mailbox_id"]:
            mailbox = await conn.fetchrow(
                "SELECT * FROM outreach_mailboxes WHERE id=$1 AND tenant_id=$2",
                c["mailbox_id"], DEFAULT_TENANT)
        else:
            mailbox = await conn.fetchrow(
                """SELECT * FROM outreach_mailboxes
                   WHERE tenant_id=$1 AND is_default=true AND enabled=true""",
                DEFAULT_TENANT)
        if mailbox is None:
            raise HTTPException(status_code=422, detail={
                "error": "validation", "code": "NO_DEFAULT_MAILBOX"})
        result = await _send_one(conn, dict(msg), mailbox)
    return {"id": message_id, **result}


@app.api_route("/api/v1/outreach/webhook", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def outreach_webhook(request: Request):
    """Inbound 路由预留（§6.8）：Email Routing → 本端点回写 replied/opened。未实现。"""
    raise HTTPException(status_code=501, detail={
        "error": "not_implemented", "code": "INBOUND_WEBHOOK_RESERVED",
        "detail": "Inbound webhook reserved — manual scan available via POST /api/v1/leads/scan-replied"})
