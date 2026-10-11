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
from urllib.parse import urljoin, urlparse

from fastapi import Depends, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel

from main import app, _acquire, _get_current_user, DEFAULT_TENANT

# jsonb 列解析的唯一真源在 dbjson.py（历史上本文件与 main.py 各存一份，
# 且签名不一致，新增表时容易漏改）。调用处均传入表名，故此处直接别名。
from dbjson import row_to_dict as _row_to_dict

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


# ── jsonb 列解析见 dbjson.py（_row_to_dict 已从该模块引入）─────────────────


def _mask(key: Optional[str]) -> Optional[str]:
    if not key:
        return None
    return "****" if len(key) <= 8 else f"{key[:4]}****{key[-4:]}"


# ═══════════════════════════════════════════════════════════════════
# 官网爬取（地图源工位的「产品信息」来源）
#
# Google Places 只能给出店铺信息（名称/地址/电话/评分/website/primary_type）。
# 产品信息（图片 / 当地叫法 / 规格）看不到，必须爬官网。
# Workers 里没有 BeautifulSoup，用正则提取（脚本为主 = 确定性规则）。
# ═══════════════════════════════════════════════════════════════════
CRAWL_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")
CRAWL_TIMEOUT = 15
# 单次爬取只读前 400KB：避免超大页面耗尽 Worker CPU/内存额度
MAX_CRAWL_BYTES = 400_000
# SSRF 防护与重定向逐跳校验 —— **与 orchestrator 共用同一份**
# （`backend/kaas_common/net.py`，由 scripts/sync-shared.ps1 镜像到 worker）。
#
# 为什么不留在这里自己一份：
#   1. 安全判定留两份，迟早有一份腐烂，而腐烂的那份没人测；
#   2. `chain.py` 依赖 Pyodide（模块级 `from main import ...`），
#      在 CPython 测试环境里**根本 import 不了** ——
#      守卫留在这里等于"永远测不到"。
# 放进共享内核后，测试跑在 orchestrator 套件里、测的就是 worker 实际执行的那份。
# ruff: noqa: E402
from kaas_common.net import (  # noqa: E402
    MAX_REDIRECTS,
    REDIRECT_CODES as _REDIRECT_CODES,
    is_safe_crawl_url as _shared_is_safe_crawl_url,
    next_redirect_url as _shared_next_redirect_url,
)


def _is_safe_crawl_url(url: str) -> bool:
    """兼容旧调用点；语义 = `kaas_common.net.is_safe_crawl_url`（唯一真源）。"""
    return _shared_is_safe_crawl_url(url)


def _next_redirect_url(current_url: str, location: str) -> Optional[str]:
    """兼容旧调用点；语义 = `kaas_common.net.next_redirect_url`（唯一真源）。"""
    return _shared_next_redirect_url(current_url, location)


def _urllib_get(url: str, timeout: int):
    """urllib 回退路径（本地 CPython）—— **同样逐跳校验**。

    不能只在 js.fetch 那条路上修：回退路径若还自动跟随，就留下一条
    "换个运行环境就有洞"的缝。两条路必须同一口径。
    """
    import urllib.error
    import urllib.request

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None  # 不自动跟随，改由 _next_redirect_url 校验

    opener = urllib.request.build_opener(_NoRedirect)
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        req = urllib.request.Request(current, headers={"User-Agent": CRAWL_UA})
        try:
            with opener.open(req, timeout=timeout) as resp:
                raw = resp.read(MAX_CRAWL_BYTES)
                return resp.status, raw.decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            if exc.code not in _REDIRECT_CODES:
                raise
            nxt = _next_redirect_url(current, exc.headers.get("Location") or "")
            if nxt is None:
                raise ValueError(
                    "重定向指向的地址不在允许抓取的公网 http(s) 范围内")
            current = nxt
    raise ValueError("重定向次数过多")


_META_TAG_RE = re.compile(r"<meta\b[^>]*>", re.IGNORECASE)
_ATTR_RE = re.compile(r"([a-zA-Z:_-]+)\s*=\s*[\"']([^\"']*)[\"']")
_SCRIPT_STYLE_RE = re.compile(r"<(script|style|noscript)\b.*?</\1>", re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_H1_RE = re.compile(r"<h1[^>]*>(.*?)</h1>", re.IGNORECASE | re.DOTALL)
_LINK_RE = re.compile(r"<a\b[^>]*href\s*=\s*[\"']([^\"']+)[\"'][^>]*>(.*?)</a>",
                      re.IGNORECASE | re.DOTALL)
# 产品页特征路径（脚本规则，命中最先出现的一个）
PRODUCT_PATH_HINTS = ("/product", "/products", "/catalog", "/catalogue",
                      "/shop", "/store", "/category", "/collections", "/goods")


def _strip_html(fragment: str) -> str:
    """去标签 + 压缩空白（正则版，够用且无依赖）。"""
    text = _SCRIPT_STYLE_RE.sub(" ", fragment or "")
    text = _TAG_RE.sub(" ", text)
    text = (text.replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
                .replace("&#39;", "'"))
    return re.sub(r"\s+", " ", text).strip()


def _meta_content(html: str, keys: tuple) -> Optional[str]:
    """按 property/name 抓 meta 的 content。"""
    for tag in _META_TAG_RE.findall(html or ""):
        attrs = {k.lower(): v for k, v in _ATTR_RE.findall(tag)}
        key = (attrs.get("property") or attrs.get("name") or "").lower()
        if key in keys and attrs.get("content"):
            return attrs["content"].strip()
    return None


def _abs_url(base: str, href: str) -> str:
    if href.startswith(("http://", "https://")):
        return href
    if href.startswith("//"):
        return "https:" + href
    parsed = urlparse(base)
    root = f"{parsed.scheme}://{parsed.netloc}"
    if href.startswith("/"):
        return root + href
    return root + "/" + href.lstrip("./")


def extract_product_from_html(html: str, base_url: str) -> dict:
    """从官网 HTML 提取产品信息（确定性脚本，AI 不参与）。

    返回：product_name / product_name_raw_source / product_image_url /
          spec_raw / link_url
    """
    og_image = _meta_content(html, ("og:image", "og:image:secure_url",
                                    "twitter:image", "image"))
    description = _meta_content(html, ("description", "og:description"))
    title_m = _TITLE_RE.search(html or "")
    title = _strip_html(title_m.group(1)) if title_m else ""
    h1_m = _H1_RE.search(html or "")
    h1 = _strip_html(h1_m.group(1)) if h1_m else ""

    # 产品页链接：优先命中所选路径特征词
    link_url = None
    for href, anchor in _LINK_RE.findall(html or ""):
        low = href.lower()
        if any(hint in low for hint in PRODUCT_PATH_HINTS):
            link_url = _abs_url(base_url, href)
            break

    # 主体文本（去脚本样式）作为规格原文
    body_text = _strip_html(html)
    spec_parts = []
    if description:
        spec_parts.append(description)
    if body_text:
        # 截断到 1200 字符，避免 raw 过大
        spec_parts.append(body_text[:1200])

    return {
        "product_name": h1 or title or None,
        "product_name_source": "h1" if h1 else ("title" if title else None),
        "page_title": title or None,
        "product_image_url": og_image,
        "spec_raw": "\n".join(p for p in spec_parts if p) or None,
        "link_url": link_url,
    }


async def _http_get_text(url: str, timeout: int = CRAWL_TIMEOUT):
    """出站 GET：Workers 用 js.fetch，本地 CPython 回退 urllib。读取上限 400KB。

    **逐跳校验重定向**（2026-10-11 修）。原先是 `redirect: "follow"`，
    而 `_is_safe_crawl_url` 只校验请求前的 URL —— 于是
    `evil.com --302--> 169.254.169.254` 能把云元数据抓回来。
    现在关掉自动跟随，每一跳的 Location 都过同一把尺子。
    """
    try:
        from js import fetch  # type: ignore  (Pyodide / Python Workers)
    except ImportError:
        return _urllib_get(url, timeout)

    current = url
    for _ in range(MAX_REDIRECTS + 1):
        resp = await fetch(current, {
            "method": "GET",
            "headers": {"User-Agent": CRAWL_UA, "Accept": "text/html,*/*"},
            # **manual 而不是 follow**：follow 会把 302 的目标直接抓回来，
            # 而我们的防护只看过第一跳。Cloudflare 文档也明确推荐这么做。
            "redirect": "manual",
        })
        status = int(resp.status)
        if status in _REDIRECT_CODES:
            nxt = _next_redirect_url(current, resp.headers.get("location") or "")
            if nxt is None:
                raise ValueError(
                    "重定向指向的地址不在允许抓取的公网 http(s) 范围内")
            current = nxt
            continue
        text = await resp.text()
        if len(text) > MAX_CRAWL_BYTES:
            text = text[:MAX_CRAWL_BYTES]
        return status, text
    raise ValueError("重定向次数过多")


# ═══════════════════════════════════════════════════════════════════
# 订阅治理（P7）
#
# 编码语义（变更档 §六）—— 本期不激活订阅治理（default 仍为 full_chain），
# 仅在此登记编码，待商业化时把 tenant_subscriptions 填行即生效。
#   intel_trade_starter      进出口情报
#   intel_research_starter   市场调研
#   intel_full               情报体系三工位
#   leadgen_starter          地图源客户信息获取 + 线索池
#   outreach_starter         客户触达（含产品手册附件）
#   full_chain               全工位
# ═══════════════════════════════════════════════════════════════════
SUB_CODES = {
    "leadgen": ["leadgen_starter", "leadgen_pro", "full_chain"],
    "outreach": ["outreach_starter", "outreach_pro", "full_chain"],
    "intel": ["intel_trade_starter", "intel_full", "full_chain"],
    "research": ["intel_research_starter", "intel_full", "full_chain"],
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


# ── 市场调研：规格结构化（脚本为主，AI 为辅）──────────────────────────────
_GRID_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(mm|cm|m)?",
                      re.IGNORECASE)
_DIM_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(mm|cm|m)\b", re.IGNORECASE)
_MATERIALS = ("hdpe", "pvc", "galvanized", "galvanised", "stainless", "steel",
              "polyester", "nylon", "aluminium", "aluminum", "copper", "pp", "pe")


def _template_spec_extract(payload: dict) -> dict:
    """确定性规则提取规格（AI 未启用时的兜底，也可作为 AI 结果的自校验基线）。"""
    text = f"{payload.get('product_name') or ''} {payload.get('spec_raw') or ''}"
    out: dict = {}
    grid = _GRID_RE.search(text)
    if grid:
        unit = grid.group(3) or "mm"
        out["size_a"] = grid.group(1)
        out["size_b"] = grid.group(2)
        out["size_unit"] = unit
    dims = [f"{d}{u}" for d, u in _DIM_RE.findall(text)][:8]
    if dims:
        out["dimensions"] = dims
    low = text.lower()
    mats = [m for m in _MATERIALS if m in low]
    if mats:
        out["materials"] = mats
    return {"spec_normalized": out or None, "source": "template"}


def _template_product_translate(payload: dict) -> dict:
    """无 AI 时不做翻译（避免乱猜），返回空并提示人工填写。"""
    return {"product_name_cn": None, "confidence": "template",
            "note": "AI 未启用，中文对照需人工填写"}


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
    # ── 市场调研工位：AI 为辅（难量化的才用 AI，能算的用脚本）─────────────
    "spec_extract": {
        "name": "规格结构化", "recommended_provider": "deepseek",
        "template_fn": _template_spec_extract,
        "build_prompt": lambda p: (
            "从产品名与规格原文中提取结构化规格，以 JSON 返回 "
            "{\"spec_normalized\": {\"size_a\": string, \"size_b\": string, "
            "\"size_unit\": string, \"dimensions\": [...], \"materials\": [...]}}。"
            "只提取原文中确实出现的数值与材质，不要编造；无法确定的字段省略。\n"
            f"产品：{json.dumps(p, ensure_ascii=False)}"),
        "parse": lambda t: {"spec_normalized": json.loads(_extract_json(t)).get("spec_normalized"),
                            "source": "ai"},
    },
    "product_translate": {
        "name": "产品名翻译", "recommended_provider": "kimi",
        "template_fn": _template_product_translate,
        "build_prompt": lambda p: (
            "把产品名翻译成简体中文（外贸丝网/围栏行业标准叫法），以 JSON 返回 "
            "{\"product_name_cn\": string, \"confidence\": \"high\"|\"low\"}。"
            "只输出译文，不要解释。\n"
            f"原文：{json.dumps({'product_name': p.get('product_name'),
                                  'spec': p.get('spec_raw')}, ensure_ascii=False)}"),
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
async def ai_tasks(user: dict = Depends(_get_current_user)):
    """AI 任务元信息。需鉴权——即使内容不敏感，也不应匿名暴露内部任务清单。

    （2026-09-22 冒烟测试发现：此前无鉴权，未带 token 也能 200；
    其余 /ai/* 端点均有 Depends(_get_current_user)）
    """
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


def _as_bool(value: Optional[str]) -> Optional[bool]:
    """把 TRUE/FALSE/是/否/1/0 解析成布尔；空值返回 None（不臆测）。"""
    if value is None:
        return None
    v = str(value).strip().lower()
    if v in ("", "none", "null", "n/a", "-"):
        return None
    if v in ("true", "1", "yes", "y", "是", "能", "可以"):
        return True
    if v in ("false", "0", "no", "n", "否", "不能", "不可以"):
        return False
    return None


# CSV 可选列（对齐业务表格：产品图片/中文对照/规格/国家/城市/来源/店铺/
# 店铺类型/电话/链接/官网地址/地址/能否提供）
_CSV_OPTIONAL = (
    "region", "city", "address", "phone", "website", "email", "industry",
    "place_id", "shop_type", "product_name", "product_name_cn",
    "product_image_url", "spec_raw", "link_url", "can_supply", "supply_notes",
)


def _fetch_csv(content: bytes) -> List[dict]:
    text = content.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    required = {"company_name", "country"}
    if not reader.fieldnames or not required.issubset({f.strip().lower() for f in reader.fieldnames}):
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "BAD_CSV",
            "detail": f"CSV needs columns: {sorted(required)} "
                      f"(optional: {', '.join(_CSV_OPTIONAL)})"})
    leads = []
    for row in reader:
        low = {k.strip().lower(): (v or "").strip() for k, v in row.items() if k}
        lead = {
            "place_id": low.get("place_id") or None,
            "company_name": low["company_name"], "country": low.get("country") or None,
            "source": "csv",
            "raw": {"csv_row": low},
        }
        for key in _CSV_OPTIONAL:
            if key in ("can_supply",):
                continue
            if low.get(key):
                lead[key] = low[key]
        # 「能否提供」由用户填写，不猜
        lead["can_supply"] = _as_bool(low.get("can_supply"))
        # 有产品信息即视为已爬取，避免进入待爬队列
        lead["crawl_status"] = "success" if (lead.get("product_name") or
                                             lead.get("product_image_url")) else "no_website"
        leads.append(lead)
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


async def _enrich_product(conn, lead: dict) -> None:
    """产品信息增强（原地修改 lead）。

    分工（脚本为主 / AI 为辅）：
      - spec_normalized：优先脚本正则提取（确定性）；绑定 AI 时由 AI 细化
      - product_name_cn：难量化 → AI 翻译，AI 未启用则留空待人工填写
    """
    if not (lead.get("product_name") or lead.get("spec_raw")):
        return
    if lead.get("spec_normalized") is None:
        try:
            res = await run_ai_task(conn, "spec_extract", lead)
            lead["spec_normalized"] = res["result"].get("spec_normalized")
        except Exception:
            pass
    if lead.get("product_name") and not lead.get("product_name_cn"):
        try:
            res = await run_ai_task(conn, "product_translate", lead)
            cn = res["result"].get("product_name_cn")
            if cn:
                lead["product_name_cn"] = cn
        except Exception:
            pass


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
            # 已带产品信息的行（CSV 导入）：脚本提规格 + AI 补中文对照
            await _enrich_product(conn, lead)
            row = await conn.fetchrow(
                """INSERT INTO lead_candidates
                   (tenant_id, place_id, company_name, country, region, city, address,
                    phone, website, email, industry, source, google_rating, google_reviews,
                    fit_score, fit_reasons, opening_line, leadgen_run_id, raw,
                    owner_id, shop_type, product_name, product_name_cn,
                    product_image_url, spec_raw, spec_normalized, link_url,
                    can_supply, supply_notes, crawl_status, owner_scope)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
                           $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,'tenant')
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
                created_by,
                lead.get("shop_type"), lead.get("product_name"),
                lead.get("product_name_cn"), lead.get("product_image_url"),
                lead.get("spec_raw"),
                json.dumps(lead.get("spec_normalized")) if lead.get("spec_normalized") is not None else None,
                lead.get("link_url"), lead.get("can_supply"), lead.get("supply_notes"),
                lead.get("crawl_status") or "pending")
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
    # 产品信息（Google Places 拿不到；由爬官网或导入提供）
    shop_type: Optional[str] = None
    product_name: Optional[str] = None
    product_name_cn: Optional[str] = None
    product_image_url: Optional[str] = None
    spec_raw: Optional[str] = None
    link_url: Optional[str] = None
    can_supply: Optional[bool] = None
    supply_notes: Optional[str] = None


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
                phone, website, email, industry, source, opening_line,
                shop_type, product_name, product_name_cn, product_image_url,
                spec_raw, link_url, can_supply, supply_notes, crawl_status,
                owner_id, owner_scope)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual',$12,
                       $13,$14,$15,$16,$17,$18,$19,$20,'no_website',$21,'tenant')
               RETURNING *""",
            DEFAULT_TENANT, place_id, body.company_name, body.country, body.region,
            body.city, body.address, body.phone, body.website, body.email,
            body.industry, body.opening_line,
            body.shop_type, body.product_name, body.product_name_cn,
            body.product_image_url, body.spec_raw, body.link_url,
            body.can_supply, body.supply_notes, str(user["id"]))
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
            # 团队隔离：转化出来的客户归**执行转化的人所在团队**。
            # owner_scope 由 'tenant'（全租户可见）改为 'private' —— 在"一个平台 + 公司=团队"
            # 的模型下，"全租户可见"等于所有公司都能看到，隔离就破了。
            # 若操作者没有团队：team_id 留空 + private，只有他本人和管理员可见（不泄露）。
            acting_team = user.get("team_id")
            cust = await conn.fetchrow(
                "SELECT id FROM customers WHERE tenant_id=$1 AND name=$2"
                " AND team_id IS NOT DISTINCT FROM $3",
                DEFAULT_TENANT, lead["company_name"], acting_team)
            if cust is None:
                cust = await conn.fetchrow(
                    """INSERT INTO customers
                       (tenant_id, name, country, address, stage, owner_id, owner_scope, team_id)
                       VALUES ($1,$2,$3,$4,'inquiry',$5,'private',$6) RETURNING id""",
                    DEFAULT_TENANT, lead["company_name"], lead["country"],
                    lead["address"], lead["owner_id"] or str(user["id"]), acting_team)
            await conn.execute(
                """INSERT INTO cust_inquiries
                   (tenant_id, customer_id, lead_id, channel, notes, status,
                    owner_id, owner_scope, team_id)
                   VALUES ($1,$2,$3,'email',$4,'open',$5,'private',$6)""",
                DEFAULT_TENANT, cust["id"], lead["id"],
                f"来自线索池触达回复（lead#{lead['id']}）",
                lead["owner_id"] or str(user["id"]), acting_team)
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
    # 产品信息（地图源工位 owner：「能否提供」等由用户编辑，不由 AI 判定）
    shop_type: Optional[str] = None
    product_name: Optional[str] = None
    product_name_cn: Optional[str] = None
    product_image_url: Optional[str] = None
    spec_raw: Optional[str] = None
    link_url: Optional[str] = None
    can_supply: Optional[bool] = None
    supply_notes: Optional[str] = None


# lead_patch 允许直接落库的字段（白名单，防止越权改状态列）
_LEAD_PATCHABLE = ("company_name", "email", "website", "phone", "industry",
                   "fit_score", "opening_line", "owner_scope",
                   "shop_type", "product_name", "product_name_cn",
                   "product_image_url", "spec_raw", "link_url",
                   "can_supply", "supply_notes")


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
        for k in _LEAD_PATCHABLE:
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
    # 必须用请求期绑定读取：Worker env 在模块 import 期不可用（os.environ 为空）。
    from main import _binding

    return mailbox.get("api_key") or _binding("RESEND_API_KEY")


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


@app.post("/api/v1/outreach/webhook")
async def outreach_webhook(request: Request):
    """Inbound 路由预留（§6.8）：Email Routing → 本端点回写 replied/opened。未实现。

    **只保留 POST**（2026-10-11 用户裁决）。原先用 `api_route` 挂了
    GET/PUT/PATCH/DELETE 共 5 种方法，但函数体只 raise 501 ——
    对一个预留桩而言那 4 种方法没有任何语义，只是**无谓放大线上攻击面**
    （扫描器会以为这里有 5 个可写入口）。

    Inbound 回写本来就是 POST（把 replied/opened 写回来），
    收紧后与 orchestrator 侧一致，「反向漂移」也随之少 4 条。
    将来真要用时再按需加方法 —— 那时它会有真实语义。
    """
    raise HTTPException(status_code=501, detail={
        "error": "not_implemented", "code": "INBOUND_WEBHOOK_RESERVED",
        "detail": "Inbound webhook reserved — manual scan available via POST /api/v1/leads/scan-replied"})


# ═══════════════════════════════════════════════════════════════════
# 官网爬取（地图源客户信息获取工位）
#
# Google Places 看不到产品；产品信息只能从官网提取。
# 手动触发（不自动爬），避免被目标站限流/封禁。
# ═══════════════════════════════════════════════════════════════════
async def _crawl_one(conn, lead: dict) -> dict:
    """爬单条线索的官网并回写产品字段。"""
    lead_id = lead["id"]
    website = (lead.get("website") or "").strip()
    if not website:
        await conn.execute(
            """UPDATE lead_candidates SET crawl_status='no_website', crawled_at=NOW(),
               updated_at=NOW() WHERE tenant_id=$1 AND id=$2""",
            DEFAULT_TENANT, lead_id)
        return {"lead_id": lead_id, "status": "no_website", "error": None}
    url = website if website.startswith("http") else "https://" + website
    if not _is_safe_crawl_url(url):
        await conn.execute(
            """UPDATE lead_candidates SET crawl_status='blocked', crawled_at=NOW(),
               updated_at=NOW() WHERE tenant_id=$1 AND id=$2""",
            DEFAULT_TENANT, lead_id)
        return {"lead_id": lead_id, "status": "blocked",
                "error": "URL 不在允许抓取的公网 http(s) 范围内"}
    try:
        status, html = await _http_get_text(url)
        if status and int(status) >= 400:
            raise ValueError(f"HTTP {status}")
        if not html:
            raise ValueError("空响应")
        data = extract_product_from_html(html, url)
        merged = dict(lead)
        for k, v in data.items():
            if v:
                merged[k] = v
        await _enrich_product(conn, merged)
        await conn.execute(
            """UPDATE lead_candidates SET
                 product_name=$3, product_name_cn=$4, product_image_url=$5,
                 spec_raw=$6, spec_normalized=$7, link_url=$8,
                 crawl_status='success', crawled_at=NOW(), updated_at=NOW()
               WHERE tenant_id=$1 AND id=$2""",
            DEFAULT_TENANT, lead_id,
            merged.get("product_name"), merged.get("product_name_cn"),
            merged.get("product_image_url"), merged.get("spec_raw"),
            json.dumps(merged.get("spec_normalized")) if merged.get("spec_normalized") else None,
            merged.get("link_url"))
        return {"lead_id": lead_id, "status": "success", "error": None,
                "product_name": merged.get("product_name"),
                "has_image": bool(merged.get("product_image_url")),
                "has_spec": bool(merged.get("spec_raw"))}
    except Exception as e:
        await conn.execute(
            """UPDATE lead_candidates SET crawl_status='failed', crawled_at=NOW(),
               updated_at=NOW() WHERE tenant_id=$1 AND id=$2""",
            DEFAULT_TENANT, lead_id)
        return {"lead_id": lead_id, "status": "failed", "error": str(e)[:200]}


@app.post("/api/v1/leads/{lead_id}/crawl")
async def lead_crawl(lead_id: int, request: Request,
                     user: dict = Depends(_get_current_user)):
    """手动爬取单条线索官网，提取产品信息（名称/图片/规格/链接）。"""
    async with _acquire(request) as conn:
        await _require_sub(conn, "leadgen")
        lead = await conn.fetchrow(
            "SELECT * FROM lead_candidates WHERE id=$1 AND tenant_id=$2",
            lead_id, DEFAULT_TENANT)
        if not lead:
            raise HTTPException(status_code=404, detail={
                "error": "not_found", "code": "LEAD_NOT_FOUND"})
        result = await _crawl_one(conn, dict(lead))
        row = await conn.fetchrow(
            "SELECT * FROM lead_candidates WHERE id=$1 AND tenant_id=$2",
            lead_id, DEFAULT_TENANT)
    return {"result": result, "lead": _row_to_lead(row)}


class CrawlBatch(BaseModel):
    lead_ids: Optional[List[int]] = None
    only_pending: bool = True
    limit: int = 10


@app.post("/api/v1/leads/crawl-batch")
async def lead_crawl_batch(body: CrawlBatch, request: Request,
                           user: dict = Depends(_get_current_user)):
    """批量爬取（默认只爬待爬的）；limit 上限 20，避免单次请求超时。"""
    limit = max(1, min(int(body.limit or 10), 20))
    async with _acquire(request) as conn:
        await _require_sub(conn, "leadgen")
        if body.lead_ids:
            rows = await conn.fetch(
                """SELECT * FROM lead_candidates
                   WHERE tenant_id=$1 AND id = ANY($2) LIMIT $3""",
                DEFAULT_TENANT, body.lead_ids, limit)
        elif body.only_pending:
            rows = await conn.fetch(
                """SELECT * FROM lead_candidates
                   WHERE tenant_id=$1 AND crawl_status='pending' AND website IS NOT NULL
                   ORDER BY id LIMIT $2""",
                DEFAULT_TENANT, limit)
        else:
            rows = await conn.fetch(
                """SELECT * FROM lead_candidates
                   WHERE tenant_id=$1 AND website IS NOT NULL
                   ORDER BY id DESC LIMIT $2""",
                DEFAULT_TENANT, limit)
        results = []
        for row in rows:
            results.append(await _crawl_one(conn, dict(row)))
    return {"crawled": len(results),
            "success": sum(1 for r in results if r["status"] == "success"),
            "failed": sum(1 for r in results if r["status"] == "failed"),
            "blocked": sum(1 for r in results if r["status"] == "blocked"),
            "no_website": sum(1 for r in results if r["status"] == "no_website"),
            "items": results}


# ═══════════════════════════════════════════════════════════════════
# 市场调研工位（情报体系 · 微观）
#
# 定位：从「地图源」产出中挑选有价值的数据，再深入细化。
#   挑选 = source_ref 指向 lead_candidates.id
#   细化 = product_category / price_local / market_note / can_supply
# ═══════════════════════════════════════════════════════════════════
RESEARCH_CATEGORIES = [
    "chain_link_fence", "welded_mesh", "gabion", "temporary_fence",
    "security_fence", "farm_fence", "razor_wire", "hinge_joint_fence",
    "accessories", "other",
]

# 从线索挑选时复制的字段（产品 + 店铺信息）
_PICK_FIELDS = (
    "product_name", "product_name_cn", "product_image_url", "spec_raw",
    "spec_normalized", "country", "region", "city",
    "shop_name", "shop_type", "address", "phone", "email", "website",
    "link_url", "can_supply", "supply_notes", "source",
)


def _row_to_research(r) -> dict:
    return _row_to_dict(r, "research_products")


class ResearchCreate(BaseModel):
    """手工录入 / 从线索挑选（source_ref 给定时自动回填线索字段）。"""
    source_ref: Optional[int] = None
    source: Optional[str] = None
    product_name: Optional[str] = None
    product_name_cn: Optional[str] = None
    product_image_url: Optional[str] = None
    spec_raw: Optional[str] = None
    product_category: Optional[str] = None
    country: Optional[str] = None
    region: Optional[str] = None
    city: Optional[str] = None
    shop_name: Optional[str] = None
    shop_type: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    website: Optional[str] = None
    link_url: Optional[str] = None
    price_local: Optional[float] = None
    price_currency: Optional[str] = None
    market_note: Optional[str] = None
    can_supply: Optional[bool] = None
    supply_notes: Optional[str] = None


async def _insert_research(conn, data: dict, owner_id: str) -> dict:
    cols = list(data.keys())
    placeholders = ", ".join(f"${i + 2}" for i in range(len(cols)))
    values = [
        json.dumps(data[c]) if c == "spec_normalized" and data[c] is not None else data[c]
        for c in cols
    ]
    row = await conn.fetchrow(
        f"""INSERT INTO research_products
            (tenant_id, {', '.join(cols)}, owner_id, owner_scope)
            VALUES ($1, {placeholders}, ${len(cols) + 2}, 'tenant')
            RETURNING *""",
        DEFAULT_TENANT, *values, owner_id)
    return _row_to_research(row)


@app.get("/api/v1/research/categories")
async def research_categories(request: Request, user: dict = Depends(_get_current_user)):
    return {"items": RESEARCH_CATEGORIES}


@app.get("/api/v1/research/products")
async def research_list(request: Request, user: dict = Depends(_get_current_user),
                        country: Optional[str] = None,
                        city: Optional[str] = None,
                        product_category: Optional[str] = None,
                        can_supply: Optional[str] = None,
                        research_status: Optional[str] = None,
                        search: Optional[str] = None,
                        page: int = Query(1, ge=1),
                        page_size: int = Query(20, ge=1, le=200)):
    where = ["tenant_id = $1"]
    params: list = [DEFAULT_TENANT]
    idx = 2
    for col, val in (("country", country), ("city", city),
                     ("product_category", product_category),
                     ("research_status", research_status)):
        if val:
            where.append(f"{col} = ${idx}"); params.append(val); idx += 1
    # can_supply 三态：true / false / unknown(未填 → IS NULL)
    if can_supply == "true":
        where.append("can_supply IS TRUE")
    elif can_supply == "false":
        where.append("can_supply IS FALSE")
    elif can_supply == "unknown":
        where.append("can_supply IS NULL")
    if search:
        where.append(f"(product_name ILIKE ${idx} OR product_name_cn ILIKE ${idx} "
                     f"OR shop_name ILIKE ${idx})")
        params.append(f"%{search}%"); idx += 1
    where_sql = " AND ".join(where)
    async with _acquire(request) as conn:
        await _require_sub(conn, "research")
        total = await conn.fetchval(
            f"SELECT COUNT(*) FROM research_products WHERE {where_sql}", *params)
        rows = await conn.fetch(
            f"""SELECT * FROM research_products WHERE {where_sql}
                ORDER BY id DESC LIMIT ${idx} OFFSET ${idx + 1}""",
            *params, page_size, (page - 1) * page_size)
    return {"items": [_row_to_research(r) for r in rows], "total": total,
            "page": page, "page_size": page_size}


@app.get("/api/v1/research/stats")
async def research_stats(request: Request, user: dict = Depends(_get_current_user)):
    """按国家/品类/供给能力聚合（供情报体系统计与空白指数消费）。"""
    async with _acquire(request) as conn:
        await _require_sub(conn, "research")
        by_country = await conn.fetch(
            """SELECT country, COUNT(*) AS total,
                      COUNT(*) FILTER (WHERE can_supply IS TRUE) AS can_supply
               FROM research_products WHERE tenant_id=$1 AND country IS NOT NULL
               GROUP BY country ORDER BY total DESC LIMIT 50""", DEFAULT_TENANT)
        by_category = await conn.fetch(
            """SELECT COALESCE(product_category, 'unclassified') AS product_category,
                      COUNT(*) AS total
               FROM research_products WHERE tenant_id=$1
               GROUP BY 1 ORDER BY total DESC""", DEFAULT_TENANT)
        total = await conn.fetchval(
            "SELECT COUNT(*) FROM research_products WHERE tenant_id=$1", DEFAULT_TENANT)
        supply_yes = await conn.fetchval(
            """SELECT COUNT(*) FROM research_products
               WHERE tenant_id=$1 AND can_supply IS TRUE""", DEFAULT_TENANT)
    return {"total": total, "can_supply_yes": supply_yes,
            "by_country": [dict(r) for r in by_country],
            "by_category": [dict(r) for r in by_category]}


@app.post("/api/v1/research/products", status_code=201)
async def research_create(body: ResearchCreate, request: Request,
                          user: dict = Depends(_get_current_user)):
    """手工录入，或从线索挑选（source_ref → 自动回填线索上的产品/店铺字段）。"""
    async with _acquire(request) as conn:
        await _require_sub(conn, "research")
        data = body.model_dump(exclude_none=True)
        source_ref = data.pop("source_ref", None)
        if source_ref is not None:
            existing = await conn.fetchrow(
                """SELECT id FROM research_products
                   WHERE tenant_id=$1 AND source_ref=$2""",
                DEFAULT_TENANT, source_ref)
            if existing:
                raise HTTPException(status_code=409, detail={
                    "error": "conflict", "code": "ALREADY_PICKED",
                    "research_id": existing["id"]})
            lead = await conn.fetchrow(
                "SELECT * FROM lead_candidates WHERE id=$1 AND tenant_id=$2",
                source_ref, DEFAULT_TENANT)
            if not lead:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "code": "LEAD_NOT_FOUND"})
            lead_d = dict(lead)
            for f in _PICK_FIELDS:
                if data.get(f) is None and lead_d.get(f) is not None:
                    data[f] = lead_d[f]
            data.setdefault("shop_name", lead_d.get("company_name"))
            data["source_ref"] = source_ref
            if not data.get("source"):
                data["source"] = lead_d.get("source")
        row = await _insert_research(conn, data, str(user["id"]))
        # 挑选动作落一条 run（审计 + 幂等语义）
        cfg = {"action": "pick", "source_ref": source_ref}
        cfg_hash = hashlib.sha256(repr(sorted(cfg.items())).encode()).hexdigest()[:32]
        await conn.execute(
            """INSERT INTO research_runs
               (tenant_id, config, config_hash, status, leads_scanned,
                products_found, products_kept, started_at, finished_at, created_by)
               VALUES ($1,$2,$3,'succeeded',$4,1,1,NOW(),NOW(),$5)
               ON CONFLICT (tenant_id, config_hash) DO NOTHING""",
            DEFAULT_TENANT, json.dumps(cfg), cfg_hash,
            1 if source_ref is not None else 0, str(user["id"]))
    return row


class ResearchPatch(BaseModel):
    product_name: Optional[str] = None
    product_name_cn: Optional[str] = None
    product_image_url: Optional[str] = None
    spec_raw: Optional[str] = None
    spec_normalized: Optional[dict] = None
    product_category: Optional[str] = None
    country: Optional[str] = None
    region: Optional[str] = None
    city: Optional[str] = None
    shop_name: Optional[str] = None
    shop_type: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    website: Optional[str] = None
    link_url: Optional[str] = None
    price_local: Optional[float] = None
    price_currency: Optional[str] = None
    market_note: Optional[str] = None
    can_supply: Optional[bool] = None
    supply_notes: Optional[str] = None
    research_status: Optional[str] = None


@app.patch("/api/v1/research/products/{research_id}")
async def research_patch(research_id: int, body: ResearchPatch, request: Request,
                         user: dict = Depends(_get_current_user)):
    """深化字段编辑（含「能否提供」——由用户判定，不由 AI 推断）。"""
    fields = body.model_dump(exclude_none=True)
    async with _acquire(request) as conn:
        await _require_sub(conn, "research")
        row = await conn.fetchrow(
            "SELECT * FROM research_products WHERE id=$1 AND tenant_id=$2",
            research_id, DEFAULT_TENANT)
        if not row:
            raise HTTPException(status_code=404, detail={
                "error": "not_found", "code": "RESEARCH_NOT_FOUND"})
        allowed = tuple(ResearchPatch.model_fields.keys())
        sets, params = [], [DEFAULT_TENANT, research_id]
        for k in allowed:
            if k in fields:
                v = fields[k]
                if k == "spec_normalized" and v is not None:
                    v = json.dumps(v)
                params.append(v)
                sets.append(f"{k} = ${len(params)}")
        if sets:
            await conn.execute(
                f"""UPDATE research_products SET {', '.join(sets)}, updated_at=NOW()
                    WHERE tenant_id=$1 AND id=$2""",
                *params)
        updated = await conn.fetchrow(
            "SELECT * FROM research_products WHERE id=$1 AND tenant_id=$2",
            research_id, DEFAULT_TENANT)
    return _row_to_research(updated)


@app.delete("/api/v1/research/products/{research_id}")
async def research_delete(research_id: int, request: Request,
                          user: dict = Depends(_get_current_user)):
    """从调研集移除（仅删本工位记录，不动地图源线索）。"""
    async with _acquire(request) as conn:
        await _require_sub(conn, "research")
        deleted = await conn.fetchval(
            """DELETE FROM research_products WHERE tenant_id=$1 AND id=$2
               RETURNING id""", DEFAULT_TENANT, research_id)
        if deleted is None:
            raise HTTPException(status_code=404, detail={
                "error": "not_found", "code": "RESEARCH_NOT_FOUND"})
    return {"deleted": deleted}


class PickFromLeadgen(BaseModel):
    lead_ids: List[int]


@app.post("/api/v1/research/from-leadgen", status_code=201)
async def research_from_leadgen(body: PickFromLeadgen, request: Request,
                                user: dict = Depends(_get_current_user)):
    """从地图源批量挑选进市场调研（已挑选过的跳过，不报错）。"""
    if not body.lead_ids:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "EMPTY_SELECTION"})
    async with _acquire(request) as conn:
        await _require_sub(conn, "research")
        leads = await conn.fetch(
            """SELECT * FROM lead_candidates
               WHERE tenant_id=$1 AND id = ANY($2)""",
            DEFAULT_TENANT, body.lead_ids)
        created, skipped = [], 0
        for lead in leads:
            lead_d = dict(lead)
            dup = await conn.fetchval(
                "SELECT id FROM research_products WHERE tenant_id=$1 AND source_ref=$2",
                DEFAULT_TENANT, lead_d["id"])
            if dup:
                skipped += 1
                continue
            data = {f: lead_d.get(f) for f in _PICK_FIELDS if lead_d.get(f) is not None}
            data["shop_name"] = lead_d.get("company_name")
            data["source_ref"] = lead_d["id"]
            row = await _insert_research(conn, data, str(user["id"]))
            created.append(row)
        cfg = {"action": "from_leadgen", "lead_ids": sorted(body.lead_ids)}
        cfg_hash = hashlib.sha256(repr(sorted(cfg.items())).encode()).hexdigest()[:32]
        await conn.execute(
            """INSERT INTO research_runs
               (tenant_id, config, config_hash, status, leads_scanned,
                products_found, products_kept, started_at, finished_at, created_by)
               VALUES ($1,$2,$3,'succeeded',$4,$5,$6,NOW(),NOW(),$7)
               ON CONFLICT (tenant_id, config_hash) DO NOTHING""",
            DEFAULT_TENANT, json.dumps(cfg), cfg_hash,
            len(leads), len(leads), len(created), str(user["id"]))
    return {"scanned": len(leads), "created": len(created), "skipped": skipped,
            "items": created}


@app.get("/api/v1/research/runs")
async def research_runs(request: Request, user: dict = Depends(_get_current_user),
                        page: int = Query(1, ge=1),
                        page_size: int = Query(20, ge=1, le=100)):
    async with _acquire(request) as conn:
        await _require_sub(conn, "research")
        total = await conn.fetchval(
            "SELECT COUNT(*) FROM research_runs WHERE tenant_id=$1", DEFAULT_TENANT)
        rows = await conn.fetch(
            """SELECT * FROM research_runs WHERE tenant_id=$1
               ORDER BY id DESC LIMIT $2 OFFSET $3""",
            DEFAULT_TENANT, page_size, (page - 1) * page_size)
    return {"items": [_row_to_dict(r, "research_runs") for r in rows],
            "total": total, "page": page, "page_size": page_size}
