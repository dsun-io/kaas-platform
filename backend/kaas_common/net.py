"""出站抓取的共用安全件（**两端同一份**）。

为什么放进共享内核
------------------
这份判定原先在 worker 的 `chain.py` 里（`_is_safe_crawl_url`），
orchestrator 补爬取功能时又要写一遍。**安全判定不能有两份** ——
两份里迟早有一份腐烂，而腐烂的那份没人会去测。

放进 `kaas_common` 后：`scripts/sync-shared.ps1` 把它镜像到 worker，
两端 import 同一份；测试跑在 orchestrator 套件里，
**测的就是 worker 实际执行的那份代码**。

（worker 的 `chain.py` 依赖 Pyodide，在 CPython 测试环境里根本 import 不了，
所以"把守卫留在 chain.py 里 + 补测试"这条路是走不通的。）

SSRF 防护的两条要点
-------------------
1. **只允许公网 http(s)**：协议白名单 + 主机名须含点 + 内网/回环/链路本地/
   云元数据封禁。
2. **重定向必须逐跳校验**。只校验"请求前的 URL"挡不住：

       http://evil.com  --302-->  http://169.254.169.254/latest/meta-data/

   请求确实发往 evil.com（合法、通过校验），但客户端**自动跟随**会把内网
   内容抓回来 —— 只校验第一跳等于没校验。
   Cloudflare 文档同样要求：`follow` 会把所有头转发给跳转目标，
   "you should set redirect mode to `manual` and implement your own
   redirect policy"。

已知局限（显式记录，不擅自超出范围）
------------------------------------
判定是**纯正则 + 主机名字符串匹配**，**不解析 DNS**，
因此挡不住"域名解析到内网 IP"（DNS rebinding / 恶意 A 记录）。
worker 跑在 Pyodide 里做不了 socket 级校验，只能如此；
orchestrator 是完整 Python，本可再叠一层"解析后的 IP"校验 ——
但那是**加固**，与两端统一口径是两件事，故留成 TODO，
避免出现"某几处加强了、其余仍按旧口径"这种更难排查的中间状态。
"""
from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urljoin, urlparse

# SSRF 防护：只允许公网 http(s)，拒绝内网/回环/云元数据地址
_BLOCKED_HOST_RE = re.compile(
    r"^(?:localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|"
    r"172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?$|fc|fd|fe80)",
    re.IGNORECASE,
)

CRAWL_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")
CRAWL_TIMEOUT = 15          # 秒
MAX_CRAWL_BYTES = 400_000   # 读取上限
MAX_REDIRECTS = 5
REDIRECT_CODES = (301, 302, 303, 307, 308)


def is_safe_crawl_url(url: str) -> bool:
    """只允许抓取公网 http(s) 地址（防御 CSV/线索注入内网地址）。

    三条判断：
      1. 协议必须是 http/https
      2. 主机名必须存在且含 "."（挡掉裸主机名，如 `http://intranet/`）
      3. 不在封禁前缀里（回环 / 私有网段 / 链路本地 / 云元数据 169.254.x / IPv6 私网）

    TODO（加固，非本次范围）：解析 DNS 后对**解析出的 IP** 再判一次，
    以覆盖"域名指向内网"。见模块 docstring 的「已知局限」。
    """
    parsed = urlparse(url or "")
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    if not host or "." not in host:
        return False
    return not _BLOCKED_HOST_RE.match(host)


def next_redirect_url(current_url: str, location: str) -> Optional[str]:
    """返回**经过校验**的下一跳绝对地址；不安全或非法则返回 None。

    调用方必须关掉客户端的自动跟随（Workers 用 `redirect: "manual"`，
    urllib 用不跟随的 opener），否则这个函数永远轮不到执行。
    """
    if not location:
        return None
    target = urljoin(current_url, location.strip())
    return target if is_safe_crawl_url(target) else None
