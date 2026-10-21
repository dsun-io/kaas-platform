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
worker 跑在 Pyodide 里做不了 socket 级校验，只能如此。

**2026-10-21 加固（TODO(TODO:C11)）**：新增**可选**的解析后校验 ——
`is_safe_crawl_url(url, resolve=True, resolver=...)` / `next_redirect_url(..., resolve=True)`。
- 默认 `resolve=False`，**两端行为不变**（worker/Pyodide 没有 socket，保持字符串判定）；
- 具备 socket 的 Python 运行时（本地脚本、测试、未来非 Pyodide 的调用方）可传 `resolve=True`，
  解析出的每个 IP 都会过一遍私网/回环/链路本地/保留段判定（含 IPv4-mapped 与 169.254.169.254）；
- 解析失败（DNS 异常/无结果）时**不额外阻断**（请求本身也会失败，避免把网络抖动变成安全误杀）。
"""
from __future__ import annotations

import ipaddress
import re
from typing import Callable, Optional
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


def _is_blocked_ip(ip: str) -> bool:
    """IP 是否落在禁止访问的段（私网/回环/链路本地/保留/组播/未指定/云元数据）。"""
    try:
        addr = ipaddress.ip_address((ip or "").strip().strip("[]"))
    except ValueError:
        # 解析出的不是合法 IP（例如空串）：按不安全处理，宁可多挡
        return True
    # IPv4-mapped IPv6（::ffff:10.0.0.5）按 IPv4 判
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    if isinstance(addr, ipaddress.IPv4Address) and str(addr) == "169.254.169.254":
        return True  # 云元数据（部分实现的 is_link_local 已覆盖，这里显式钉住）
    return bool(
        addr.is_private or addr.is_loopback or addr.is_link_local
        or addr.is_multicast or addr.is_reserved or addr.is_unspecified
    )


def resolve_host_ips(
    host: str,
    resolver: Optional[Callable[[str], list[str]]] = None,
) -> list[str]:
    """解析主机名的全部 IP（去重排序）。

    - 传入 `resolver` 时直接用它（测试/调用方注入，便于离线断言）；
    - 否则尝试 `socket.getaddrinfo`：Pyodide/受限运行时没有 socket，导入或调用失败
      一律返回空列表（**不抛异常**，交给调用方决定语义）。
    """
    if resolver is not None:
        try:
            return sorted({str(ip) for ip in resolver(host)})
        except Exception:  # noqa: BLE001 - 有意兜底：注入的 resolver 出错按"解析不到"处理
            return []
    try:
        import socket  # 局部导入：Pyodide 无此模块，模块顶层导入会直接炸
    except ImportError:
        return []
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:  # noqa: BLE001 - 有意兜底：受限 runtime 的 getaddrinfo 失败按"解析不到"处理
        return []
    return sorted({str(info[4][0]) for info in infos if info[4] and info[4][0]})


def is_safe_crawl_url(
    url: str,
    *,
    resolve: bool = False,
    resolver: Optional[Callable[[str], list[str]]] = None,
) -> bool:
    """只允许抓取公网 http(s) 地址（防御 CSV/线索注入内网地址）。

    三条判断：
      1. 协议必须是 http/https
      2. 主机名必须存在且含 "."（挡掉裸主机名，如 `http://intranet/`）
      3. 不在封禁前缀里（回环 / 私有网段 / 链路本地 / 云元数据 169.254.x / IPv6 私网）

    `resolve=True` 时额外做**解析后校验**（DNS rebinding 加固）：
    解析出的每个 IP 都必须通过 `_is_blocked_ip`；解析不到则不额外阻断。
    """
    parsed = urlparse(url or "")
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    if not host or "." not in host:
        return False
    if _BLOCKED_HOST_RE.match(host):
        return False
    if not resolve:
        return True
    ips = resolve_host_ips(host, resolver)
    if not ips:
        return True  # 解析不到：不额外阻断（抓取本身会失败）
    return all(not _is_blocked_ip(ip) for ip in ips)


def next_redirect_url(
    current_url: str,
    location: str,
    *,
    resolve: bool = False,
    resolver: Optional[Callable[[str], list[str]]] = None,
) -> Optional[str]:
    """返回**经过校验**的下一跳绝对地址；不安全或非法则返回 None。

    调用方必须关掉客户端的自动跟随（Workers 用 `redirect: "manual"`，
    urllib 用不跟随的 opener），否则这个函数永远轮不到执行。
    """
    if not location:
        return None
    target = urljoin(current_url, location.strip())
    return target if is_safe_crawl_url(target, resolve=resolve, resolver=resolver) else None
