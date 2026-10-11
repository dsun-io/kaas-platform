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
from urllib.parse import urlparse

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
