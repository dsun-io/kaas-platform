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

__all__ = [
    "CRAWL_TIMEOUT",
    "CRAWL_UA",
    "MAX_CRAWL_BYTES",
    "http_get_text",
    "is_safe_crawl_url",
    "next_redirect_url",
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
