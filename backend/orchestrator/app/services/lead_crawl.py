"""线索官网爬取的助手（orchestrator 侧）。

分层
----
- **安全判定与常量** → `kaas_common.net`（**两端同一份**，镜像到 worker）。
  安全件放共享内核而不是各写一份：两份里迟早有一份腐烂，且腐烂的那份没人测。
- **出站抓取实现** → 本文件。因为两端的 HTTP 原语不同：
  worker 在 Pyodide 里用 `js.fetch`，orchestrator 用 `httpx`。

为什么要这一层
--------------
worker 侧 `POST /leads/{id}/crawl` 与 `POST /leads/crawl-batch` 依赖 4 个助手，
**orchestrator 侧原先一个都没有**，导致前端「批量爬取」按钮在 dev 环境直接 404
（前端 `leadgen/page.tsx` 调的就是这两条）。

搬迁顺序（安全件优先）：
1. ✅ `is_safe_crawl_url`（在 `kaas_common.net`）
2. ✅ `http_get_text`（本文件）
3. ❌ `extract_product_from_html`
4. ❌ `enrich_product`
5. ❌ 两条端点
"""
from __future__ import annotations

import httpx

# 安全判定与常量：与 worker 共用同一份（不要在这里另写一遍）
from kaas_common.net import (  # noqa: F401  (is_safe_crawl_url 供调用方直接用)
    CRAWL_TIMEOUT,
    CRAWL_UA,
    MAX_CRAWL_BYTES,
    MAX_REDIRECTS,
    REDIRECT_CODES,
    is_safe_crawl_url,
    next_redirect_url,
)

# 产品信息抽取：同样是共享内核（纯确定性脚本，无平台依赖）
from kaas_common.crawl_extract import (  # noqa: F401
    extract_product_from_html,
    strip_html,
)

__all__ = [
    "CRAWL_TIMEOUT",
    "CRAWL_UA",
    "MAX_CRAWL_BYTES",
    "http_get_text",
    "is_safe_crawl_url",
    "next_redirect_url",
    "extract_product_from_html",
    "enrich_product",
    "crawl_one",
    "strip_html",
]


async def http_get_text(url: str, timeout: int = CRAWL_TIMEOUT) -> tuple:
    """出站 GET，返回 ``(status, text)``；读取上限 `MAX_CRAWL_BYTES`。

    与 worker 的 `_http_get_text` **语义一致**（同样的 UA / 超时 / 字节上限），
    但两处刻意不同：

    1. **用 httpx，而不是 worker 那个 `urllib` 同步回退** ——
       同步 `urlopen` 在 FastAPI 的 async 端点里会**阻塞整个事件循环**，
       一次爬取最长 15 秒，期间 dev 服务全体卡住。
    2. **关掉自动跟随、逐跳校验重定向**（`follow_redirects=False` +
       `next_redirect_url`）。worker 侧原先用 `redirect: "follow"`，
       存在"302 跳到 169.254.169.254"的绕过面，已一并修掉。

    `is_safe_crawl_url` 在任何网络动作**之前**执行，不可跳过。
    """
    if not is_safe_crawl_url(url):
        raise ValueError("URL 不在允许抓取的公网 http(s) 范围内")

    headers = {"User-Agent": CRAWL_UA, "Accept": "text/html,*/*"}
    current = url
    async with httpx.AsyncClient(
        timeout=timeout, follow_redirects=False, headers=headers
    ) as client:
        for _ in range(MAX_REDIRECTS + 1):
            resp = await client.get(current)
            if resp.status_code in REDIRECT_CODES:
                nxt = next_redirect_url(current, resp.headers.get("location", ""))
                if nxt is None:
                    raise ValueError(
                        "重定向指向的地址不在允许抓取的公网 http(s) 范围内")
                current = nxt
                continue
            return resp.status_code, resp.text[:MAX_CRAWL_BYTES]
    raise ValueError("重定向次数过多")


async def enrich_product(db, tenant_id: str, lead: dict,
                         ai_runner=None) -> None:
    """产品信息增补（**原地修改** `lead`）。分工与 worker 一致：脚本为主 / AI 为辅。

    - `spec_normalized`：脚本规则确定性提取；AI 启用时才由 AI 细化
    - `product_name_cn`：难量化 → 交 AI 翻译；AI 未启用则**留空待人工填**

    `ai_runner` 可注入（默认 `app.services.ai_tasks.run_ai_task`），
    一是便于测试，二是显式声明"本函数依赖一个 AI 执行器"这件事。

    两条必须保留的性质（都有对应测试）：
      1. **无事可做时不调 AI** —— 既省一次调用，也避免把空字段喂给模型。
      2. **AI 失败一律吞掉**（best-effort）。爬取的**主体成果是网页抽取**，
         AI 只是增补；AI 挂了不能让整次爬取判为失败。
    """
    if not (lead.get("product_name") or lead.get("spec_raw")):
        return

    if ai_runner is None:
        from app.services.ai_tasks import run_ai_task as ai_runner  # noqa: PLC0415

    if lead.get("spec_normalized") is None:
        try:
            res = await ai_runner(db, tenant_id, "spec_extract", lead)
            lead["spec_normalized"] = res["result"].get("spec_normalized")
        except Exception:      # noqa: BLE001  —— best-effort，见 docstring 第 2 条
            pass

    if lead.get("product_name") and not lead.get("product_name_cn"):
        try:
            res = await ai_runner(db, tenant_id, "product_translate", lead)
            cn = res["result"].get("product_name_cn")
            if cn:              # 只认**非空**结果，别把空串写进去（空串看着像"已翻译"）
                lead["product_name_cn"] = cn
        except Exception:      # noqa: BLE001
            pass


# 抽取结果 → `lead_candidates` 列的白名单。
# **显式列举**而不是 `setattr` 一把梭：`extract_product_from_html` 还会回
# `product_name_source` / `page_title` 这类**没有对应列**的键，
# 一把梭会在运行时炸 AttributeError（而且只在真正爬取时才炸）。
_LEAD_COLUMNS = {
    "product_name": "product_name",
    "product_image_url": "product_image_url",
    "spec_raw": "spec_raw",
    "link_url": "link_url",
}


def _now():
    from datetime import datetime, timezone  # noqa: PLC0415

    return datetime.now(timezone.utc)


async def crawl_one(db, tenant_id: str, lead, *,
                    fetcher=None, ai_runner=None) -> dict:
    """爬单条线索的官网并回写产品字段（与 worker `_crawl_one` 同语义）。

    `crawl_status` 四态与 worker 一致：`no_website` / `blocked` /
    `failed` / `success`。**四种都要写** —— 否则「待爬」的行会一直挂着，
    界面上看不出是失败了还是没人爬。

    `fetcher` / `ai_runner` 可注入，便于不起网络的测试。
    """
    if fetcher is None:
        fetcher = http_get_text

    website = (lead.website or "").strip()
    if not website:
        lead.crawl_status = "no_website"
        lead.crawled_at = _now()
        return {"lead_id": lead.id, "status": "no_website", "error": None}

    url = website if website.startswith("http") else "https://" + website
    if not is_safe_crawl_url(url):
        lead.crawl_status = "blocked"
        lead.crawled_at = _now()
        return {"lead_id": lead.id, "status": "blocked",
                "error": "URL 不在允许抓取的公网 http(s) 范围内"}

    try:
        status, html = await fetcher(url)
        if status and int(status) >= 400:
            raise ValueError(f"HTTP {status}")
        if not html:
            raise ValueError("空响应")

        data = extract_product_from_html(html, url)
        for src, column in _LEAD_COLUMNS.items():
            value = data.get(src)
            if value:          # 抽不到就保持原值，不拿 None 覆盖已有数据
                setattr(lead, column, value)

        # `enrich_product` 是 dict 语义（且有测试按 dict 写的），
        # 所以在这里做一次显式桥接，而不是把它改成 ORM 版
        payload = {
            "product_name": lead.product_name,
            "product_name_cn": lead.product_name_cn,
            "spec_raw": lead.spec_raw,
            "spec_normalized": lead.spec_normalized,
        }
        await enrich_product(db, tenant_id, payload, ai_runner=ai_runner)
        lead.spec_normalized = payload.get("spec_normalized")
        lead.product_name_cn = payload.get("product_name_cn")

        lead.crawl_status = "success"
        lead.crawled_at = _now()
        return {"lead_id": lead.id, "status": "success", "error": None,
                "product_name": lead.product_name,
                "has_image": bool(lead.product_image_url),
                "has_spec": bool(lead.spec_raw)}
    except Exception as exc:   # noqa: BLE001  —— 单条失败不该中断整批
        lead.crawl_status = "failed"
        lead.crawled_at = _now()
        return {"lead_id": lead.id, "status": "failed", "error": str(exc)[:200]}
