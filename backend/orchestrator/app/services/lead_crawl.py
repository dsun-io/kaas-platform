"""线索官网爬取的助手（orchestrator 侧）。

为什么要这一层
--------------
worker 侧 `POST /leads/{id}/crawl` 与 `POST /leads/crawl-batch` 依赖 4 个助手，
**orchestrator 侧原先一个都没有**，导致前端「批量爬取」按钮在 dev 环境直接 404
（前端 `leadgen/page.tsx` 调的就是这两条）。本模块按顺序补齐它们，
让 orchestrator 与 worker 能力对齐。

4 个助手的搬迁顺序（安全件优先）
--------------------------------
1. `is_safe_crawl_url` —— **SSRF 防护**（本文件已落）
2. `http_get_text`     —— 抓取网页文本
3. `extract_product_from_html` —— 从 HTML 抽产品名/图片/规格
4. `enrich_product`    —— 富集并回写

安全件的移植原则
----------------
**逐行照搬 worker 的实现，不凭理解重写。** 这类防护少一条判断就是一个 SSRF 洞；
而"看起来更简洁"的重写恰恰是最容易漏判断的地方。

已知局限（原样继承，不擅自改）
------------------------------
worker 的判定是**纯正则 + 主机名字符串匹配**：不解析 DNS，
因此挡不住"域名解析到内网 IP"（DNS rebinding / 恶意 A 记录）。
worker 跑在 Pyodide 里没法做 socket 级校验，只能如此；
**orchestrator 是完整 Python，本来可以再叠一层解析后的 IP 校验** ——
但那是**加固**，不是本次移植的范围。留作显式 TODO，避免"顺手加强了某几处、
其余仍按旧口径"这种更难排查的中间状态。
"""
from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx

# SSRF 防护：只允许公网 http(s)，拒绝内网/回环/云元数据地址
# （与 `backend/worker/src/chain.py` 的 `_BLOCKED_HOST_RE` 逐字一致）
_BLOCKED_HOST_RE = re.compile(
    r"^(?:localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|"
    r"172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?$|fc|fd|fe80)",
    re.IGNORECASE,
)


def is_safe_crawl_url(url: str) -> bool:
    """只允许抓取公网 http(s) 地址（防御 CSV/线索注入内网地址）。

    与 worker 的 `_is_safe_crawl_url` 逐行等价。三条判断：
      1. 协议必须是 http/https
      2. 主机名必须存在且含 "."（挡掉 `localhost`、裸主机名、`[::1]` 之外的形式）
      3. 不在封禁前缀里（回环 / 私有网段 / 链路本地 / 云元数据 169.254.x / IPv6 私网）

    TODO（加固，非本次范围）：解析 DNS 后对**解析出的 IP** 再判一次，
    以覆盖"域名指向内网"的情况。见模块 docstring 的「已知局限」。
    """
    parsed = urlparse(url or "")
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    if not host or "." not in host:
        return False
    return not _BLOCKED_HOST_RE.match(host)


# ── 出站抓取 ────────────────────────────────────────────────────────────────

CRAWL_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")
CRAWL_TIMEOUT = 15          # 与 worker 的 CRAWL_TIMEOUT 一致
MAX_CRAWL_BYTES = 400_000   # 与 worker 的 MAX_CRAWL_BYTES 一致
MAX_REDIRECTS = 5


def next_redirect_url(current_url: str, location: str) -> Optional[str]:
    """返回**经过校验**的下一跳绝对地址；不安全或非法则返回 None。

    为什么必须逐跳校验（而不是让客户端自动跟随）
    --------------------------------------------
    只校验"请求前的 URL"挡不住这种绕过：

        http://evil.com  --302-->  http://169.254.169.254/latest/meta-data/

    请求的确发往 evil.com（合法），但客户端**自动跟随**到了内网。
    worker 侧用的是 `redirect: "follow"`，所以那里存在同一个绕过面
    （已作为发现记入 `docs/PROBLEM_STATUS_2026-10-11.md`）。

    正确做法：**关掉自动跟随**，每一跳都拿 Location 过同一把尺子。
    """
    if not location:
        return None
    target = urljoin(current_url, location.strip())
    return target if is_safe_crawl_url(target) else None


async def http_get_text(url: str, timeout: int = CRAWL_TIMEOUT) -> tuple:
    """出站 GET，返回 ``(status, text)``；读取上限 `MAX_CRAWL_BYTES`。

    与 worker 的 `_http_get_text` **语义一致**（同样的 UA / 超时 / 字节上限），
    但两处刻意不同：

    1. **用 httpx，而不是 worker 那个 `urllib` 同步回退** ——
       同步 `urlopen` 在 FastAPI 的 async 端点里会**阻塞整个事件循环**，
       一次爬取最长 15 秒，期间 dev 服务全体卡住。
    2. **逐跳校验重定向**（见 `next_redirect_url`），补上 worker 侧的绕过面。

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
            if resp.status_code in (301, 302, 303, 307, 308):
                nxt = next_redirect_url(current, resp.headers.get("location", ""))
                if nxt is None:
                    raise ValueError(
                        "重定向指向的地址不在允许抓取的公网 http(s) 范围内")
                current = nxt
                continue
            return resp.status_code, resp.text[:MAX_CRAWL_BYTES]
    raise ValueError("重定向次数过多")
