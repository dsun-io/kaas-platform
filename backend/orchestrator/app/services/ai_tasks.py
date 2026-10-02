"""AI 任务层（最终设计 §四）

平台预置任务清单，客户自选 Provider/模型/可关：
- config_validation   配置校验（推荐 DS）
- lead_scoring        线索评分（推荐 DS）
- opening_line        开场白生成（推荐 Kimi）
- email_generation    邮件生成（推荐 Kimi）
- inquiry_classification 询盘分类（推荐 Kimi）

铁律：
- 每个任务有不依赖 AI 的纯模板/纯逻辑降级路径，"不用 AI"是合法选项
- fallback 链只在启用 AI 时生效：
  Primary（客户选）→ 备用（DS↔Kimi 互备）→ Zhipu → TemplateOnly → Stub
- 每次调用落 ai_usage 对账记录
- 定价引擎零 LLM（本模块不参与定价计算）
"""
import json
import re
import time
from datetime import datetime, timezone
from typing import Any, Optional

import structlog
from sqlalchemy import select

from app.db.workstation_models import AiProvider, AiTaskBinding, AiUsage
from app.services.llm_client import openai_compat_chat
from kaas_common.trade_doc import SYSTEM_PROMPT as _KERNEL_TRANSLATE_SYSTEM

logger = structlog.get_logger(__name__)

# Provider 默认端点（客户未填 base_url 时使用）
PROVIDER_DEFAULTS = {
    "deepseek": {"base_url": "https://api.deepseek.com/v1", "model": "deepseek-chat"},
    "kimi": {"base_url": "https://api.moonshot.cn/v1", "model": "kimi-k2-0905-preview"},
    "zhipu": {"base_url": "https://open.bigmodel.cn/api/paas/v4", "model": "glm-4"},
}


# ═══════════════════════════════════════════════════════════════════
# 任务清单（平台预置；推荐只是默认值，客户可改可关）
# ═══════════════════════════════════════════════════════════════════

def _template_config_validation(payload: dict) -> dict:
    """不用 AI：本地格式检查。"""
    issues = []
    region = (payload.get("region") or "").strip()
    industry = (payload.get("industry") or "").strip()
    qty = payload.get("quantity") or 0
    if not region:
        issues.append("地区未填写")
    if not industry:
        issues.append("行业未填写")
    if not (1 <= int(qty) <= 5000):
        issues.append("数量需在 1-5000 之间")
    return {"valid": not issues, "issues": issues,
            "suggestion": "检查地区/行业/数量后重新提交" if issues else None}


def _template_lead_scoring(payload: dict) -> dict:
    """不用 AI：硬过滤规则评分 0-100。"""
    score, reasons = 0, []
    email = payload.get("email")
    website = payload.get("website")
    industry = (payload.get("industry") or "").lower()
    if email:
        score += 40; reasons.append("有邮箱 +40")
    if website:
        score += 25; reasons.append("有官网 +25")
    if any(k in industry for k in ("fence", "mesh", "wire", "construction", "build", "garden")):
        score += 25; reasons.append("行业关键词匹配 +25")
    if payload.get("google_rating"):
        score += 10; reasons.append("有 Google 评分 +10")
    return {"fit_score": min(score, 100), "reasons": reasons}


def _template_opening_line(payload: dict) -> dict:
    """不用 AI：模板开场白。"""
    name = payload.get("contact_name") or payload.get("company_name") or "there"
    city = payload.get("city") or ""
    company = payload.get("company_name") or "your company"
    city_part = f" in {city}" if city else ""
    return {"opening_line": (
        f"Hi {name}, I came across {company}{city_part} and noticed you may be sourcing "
        f"wire mesh & fencing products. We are a manufacturer from China with factory-direct "
        f"pricing — could I send you our catalog and recent project references?"
    )}


def _template_email_generation(payload: dict) -> dict:
    """不用 AI：模板 + 变量占位。"""
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
        f"Best regards,\n{{sender_name}}\n{{sender_title}} | {{sender_company}}"
    )
    return {"subject": subject, "body": body}


def _template_inquiry_classification(payload: dict) -> dict:
    """不用 AI：关键词分类，默认归 other 人工标记。"""
    text = " ".join(str(payload.get(k) or "") for k in
                    ("product_name_raw", "application", "notes", "message")).lower()
    rules = [
        ("chain_link fence", ("chain link", "勾花", "diamond mesh")),
        ("welded mesh", ("welded", "电焊", "weldmesh")),
        ("gabion", ("gabion", "石笼", "hexagonal")),
        ("temporary fence", ("temporary", "mobile fence", "portable fence")),
        ("security fence", ("358", "anti climb", "high security", "prison")),
        ("farm fence", ("farm", "field fence", "cattle", "deer fence", "hog")),
    ]
    for label, keywords in rules:
        if any(k in text for k in keywords):
            return {"category": label, "confidence": "template", "auto": False}
    return {"category": "other", "confidence": "template", "auto": False}


# 任务注册表：prompt 构建 / 输出解析（AI 路径）；template_fn（纯逻辑降级路径）
TASKS: dict[str, dict[str, Any]] = {
    "config_validation": {
        "name": "配置校验",
        "recommended_provider": "deepseek",
        "template_fn": _template_config_validation,
        "build_prompt": lambda p: (
            "校验以下客户开发配置是否合理（地区/行业/ICP/数量），"
            "以 JSON 返回 {\"valid\": bool, \"issues\": [...], \"suggestion\": string|null}。\n"
            f"配置：{json.dumps(p, ensure_ascii=False)}"
        ),
        "parse": lambda t: json.loads(_extract_json(t)),
    },
    "lead_scoring": {
        "name": "线索评分",
        "recommended_provider": "deepseek",
        "template_fn": _template_lead_scoring,
        "build_prompt": lambda p: (
            "给以下潜在客户打分（0-100，B2B 丝网/围栏制造商视角），"
            "以 JSON 返回 {\"fit_score\": int, \"reasons\": [...]}。\n"
            f"线索：{json.dumps(p, ensure_ascii=False)}"
        ),
        "parse": lambda t: json.loads(_extract_json(t)),
    },
    "opening_line": {
        "name": "开场白生成",
        "recommended_provider": "kimi",
        "template_fn": _template_opening_line,
        "build_prompt": lambda p: (
            "为外贸开发信生成一句个性化开场白（英文，50 词内，自然不套路），"
            "以 JSON 返回 {\"opening_line\": string}。\n"
            f"客户信息：{json.dumps(p, ensure_ascii=False)}"
        ),
        "parse": lambda t: json.loads(_extract_json(t)),
    },
    "email_generation": {
        "name": "邮件生成",
        "recommended_provider": "kimi",
        "template_fn": _template_email_generation,
        "build_prompt": lambda p: (
            "生成一封外贸开发信，以 JSON 返回 {\"subject\": string, \"body\": string}。"
            "正文含 {{sender_name}} 等占位变量供后续替换。要求：简洁专业、突出工厂直供。\n"
            f"输入：{json.dumps(p, ensure_ascii=False)}"
        ),
        "parse": lambda t: json.loads(_extract_json(t)),
    },
    "inquiry_classification": {
        "name": "询盘分类",
        "recommended_provider": "kimi",
        "template_fn": _template_inquiry_classification,
        "build_prompt": lambda p: (
            "给询盘打品类标签，以 JSON 返回 "
            "{\"category\": string, \"confidence\": \"high\"|\"low\", \"auto\": bool}。"
            "类别枚举：chain_link_fence / welded_mesh / gabion / temporary_fence / "
            "security_fence / farm_fence / other\n"
            f"询盘：{json.dumps(p, ensure_ascii=False)}"
        ),
        "parse": lambda t: json.loads(_extract_json(t)),
    },
    "trade_doc_translate": {
        "name": "单证中译英",
        "recommended_provider": "kimi",
        # 无 AI 降级：原样回传（提示人工翻译），不丢数据
        "template_fn": lambda p: dict(p.get("fields") or {}),
        # prompt 构造与响应解析复用共享内核（G1 一份代码，Worker 同源）
        "build_prompt": lambda p: (
            _KERNEL_TRANSLATE_SYSTEM
            + "\n\nTranslate these trade document fields to English:\n"
            + json.dumps({k: str(v) for k, v in (p.get("fields") or {}).items()},
                         ensure_ascii=False)
        ),
        "parse": lambda t: json.loads(_extract_json(t)),
    },
}


def _extract_json(text: str) -> str:
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise ValueError("AI 输出不含 JSON")
    return m.group(0)


def task_chain(primary: str) -> list[str]:
    """fallback 链（§4.5）：Primary → DS↔Kimi 互备 → Zhipu → TemplateOnly。

    链中去掉与 Primary 重复的项；template_only 由调用方兜底，不在链内。
    """
    pair = ["deepseek", "kimi"]
    chain: list[str] = [primary]
    for p in pair:
        if p != primary:
            chain.append(p)
            break
    if "zhipu" != primary:
        chain.append("zhipu")
    return chain


async def _log_usage(db, tenant_id: str, task_key: str, provider: Optional[str],
                     model: Optional[str], usage: dict, status: str,
                     error: Optional[str], latency_ms: int):
    db.add(AiUsage(
        tenant_id=tenant_id, task_key=task_key, provider=provider, model=model,
        prompt_tokens=usage.get("prompt_tokens"),
        completion_tokens=usage.get("completion_tokens"),
        status=status, error=error, latency_ms=latency_ms,
    ))


async def run_ai_task(db, tenant_id: str, task_key: str, payload: dict) -> dict:
    """执行任务：读绑定 → 未启用走模板；启用走 fallback 链；全程落 usage。

    返回 {"result": ..., "path": "ai:<provider>" | "template", "usage_id"?}
    """
    if task_key not in TASKS:
        raise KeyError(f"未知任务：{task_key}")
    task = TASKS[task_key]

    binding = (await db.execute(
        select(AiTaskBinding).where(
            AiTaskBinding.tenant_id == tenant_id,
            AiTaskBinding.task_key == task_key,
        )
    )).scalar_one_or_none()

    # "不用 AI" 是合法选项：直接走纯逻辑降级路径
    if binding is None or not binding.enabled:
        started = time.perf_counter()
        result = task["template_fn"](payload)
        await _log_usage(db, tenant_id, task_key, None, None, {},
                         "template_only", None, int((time.perf_counter() - started) * 1000))
        await db.commit()
        return {"result": result, "path": "template", "task": task_key}

    primary = binding.provider or task["recommended_provider"]
    chain = task_chain(primary)

    providers = {
        r.provider: r for r in (await db.execute(
            select(AiProvider).where(AiProvider.tenant_id == tenant_id)
        )).scalars().all()
    }

    for provider_name in chain:
        prov = providers.get(provider_name)
        if prov is None or not prov.enabled or not prov.api_key:
            continue
        defaults = PROVIDER_DEFAULTS.get(provider_name, {})
        base_url = prov.base_url or defaults.get("base_url", "")
        model = binding.model or prov.model or defaults.get("model", "")
        started = time.perf_counter()
        try:
            content, usage = await openai_compat_chat(
                base_url, prov.api_key, model,
                [{"role": "user", "content": task["build_prompt"](payload)}],
                temperature=0.3, json_mode=True,
            )
            result = task["parse"](content)
            latency = int((time.perf_counter() - started) * 1000)
            await _log_usage(db, tenant_id, task_key, provider_name, model,
                             usage, "success", None, latency)
            await db.commit()
            return {"result": result, "path": f"ai:{provider_name}", "task": task_key,
                    "latency_ms": latency}
        except Exception as e:  # 失败默认退款（usage 记 failed 供对账）
            latency = int((time.perf_counter() - started) * 1000)
            logger.warning("ai_task_attempt_failed", task=task_key,
                           provider=provider_name, error=str(e))
            await _log_usage(db, tenant_id, task_key, provider_name, model, {},
                             "failed", str(e)[:500], latency)
            await db.commit()

    # 链全挂 → TemplateOnly（零外部调用）
    started = time.perf_counter()
    result = task["template_fn"](payload)
    await _log_usage(db, tenant_id, task_key, None, None, {},
                     "template_only", "all_providers_failed",
                     int((time.perf_counter() - started) * 1000))
    await db.commit()
    return {"result": result, "path": "template", "task": task_key,
            "note": "all_providers_failed"}


def mask_key(key: Optional[str]) -> Optional[str]:
    """API Key 脱敏返回（前4+后4）。"""
    if not key:
        return None
    if len(key) <= 8:
        return "****"
    return f"{key[:4]}****{key[-4:]}"
