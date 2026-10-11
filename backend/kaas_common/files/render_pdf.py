"""自动出 PDF（Cloudflare Browser Rendering）的共享判定 —— 两端**一份**（G1）。

背景（用户原话：「自动出pdf字节听起来是降低工作量的设计实现它」）
----------------------------------------------------------------
单证 HTML 在前端渲染，PDF 以前只能由用户在浏览器打印对话框里另存再手工回传归档。
本模块支撑新链路：前端把**预览同源的那份 HTML** 交给服务端，服务端调 Cloudflare
Browser Rendering 出 PDF 字节，再走既有落档链路（`_store_bytes` → `_create_file`
→ `attach_doc_file`）。方案分析见 `docs/TRADE_DOC_PDF_ARCHIVAL.md`。

为什么这里的判定必须在共享内核
------------------------------
1. 两端（orchestrator / Worker）要**同一套**"渲染器怎么配、HTML 能不能收、字节像不像 PDF"
   的判定；各写一份必然漂移（历史上 80 个接口漂移就是这么来的）。
2. **这是安全边界，不是格式检查**：把"我们账号里的无头浏览器"当成渲染器，
   等于把它的出网能力交给了请求体。若不校验，任意 HTML 都能让我们的浏览器
   去访问外部世界（SSRF / 外联代理）。渲染器 `frontend/src/lib/trade-doc/render.ts`
   产出的永远是**自包含 HTML**（文字全部 HTML 转义、样式内联、图片只允许
   `data:` 或 `http(s)`）⇒ 任何脚本/外链构造一定是"非本系统产出"的东西，一律拒。

纯标准库、零三方依赖 ⇒ Pyodide（Worker）也能加载。
"""
from __future__ import annotations

import re
from typing import Callable, Optional
from urllib.parse import urlsplit

from .rules import MAX_BYTES, FileRuleError

__all__ = [
    "ALLOWED_HOSTS_ENV_KEY",
    "BROWSER_RENDERING_QUICK_ACTION_PATH",
    "CLOUDFLARE_API_ORIGIN",
    "DEFAULT_ALLOWED_HOSTS",
    "MAX_RENDER_HTML_BYTES",
    "MAX_RENDER_PDF_BYTES",
    "PDF_MAGIC",
    "RENDERER_NOT_CONFIGURED_DETAIL",
    "RENDER_PDF_KIND",
    "allowed_html_hosts",
    "host_allowed",
    "looks_like_pdf",
    "render_pdf_rest_config",
    "render_pdf_rest_url",
    "validate_render_html",
]

# `kind` 名与内核 `FILE_KINDS` 一致；只收 `application/pdf`、≤32MB（见 `KIND_MIME`/`MAX_BYTES`）。
RENDER_PDF_KIND = "render_pdf"
MAX_RENDER_PDF_BYTES = MAX_BYTES[RENDER_PDF_KIND]

# 入参 HTML 的上限：单证（含 data URI 图片）实测几十~几百 KB；2MB 足够，
# 同时避免把"超大请求体"直接转给 Browser Rendering（官方请求体上限 50MB）。
MAX_RENDER_HTML_BYTES = 2 * 1024 * 1024

PDF_MAGIC = b"%PDF-"

# 官方文档页写 `/browser-run/pdf`，OpenAPI 与实测可用路径是 `/browser-rendering/pdf`
# （两条路径都实测返回 200；这里取有 OpenAPI 依据的那条）。
# 出处：Cloudflare OpenAPI `POST /accounts/{account_id}/browser-rendering/pdf`（"Get PDF"）。
CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com/client/v4"
BROWSER_RENDERING_QUICK_ACTION_PATH = "/accounts/{account_id}/browser-rendering/pdf"

_ACCOUNT_ID_RE = re.compile(r"^[0-9a-f]{32}$", re.IGNORECASE)

# 两端共用的"没配渲染器"提示：**可执行**（要在哪里配什么），不是一句"失败了"。
# 放内核里是为了两端口径一字不差（前端按 `code` 判断，按 detail 提示用户）。
RENDERER_NOT_CONFIGURED_DETAIL = (
    "服务端未配置 PDF 渲染器。生产 Worker 需在 wrangler.jsonc 声明 "
    "\"browser\": {\"binding\": \"BROWSER\"}（无需 token）；orchestrator（本地/dev）需设 "
    "BROWSER_RENDERING_ACCOUNT_ID + BROWSER_RENDERING_TOKEN"
    "（或 CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN；token 需 Browser Run - Edit 权限）。"
    "在配好之前，「归档本版 PDF」人工归档仍然可用。"
)

# 请求期配置的键名（两端同一套；Python Workers 在 import 期读不到绑定/环境，
# 所以调用方必须传"取值函数"而不是在本模块顶层读环境）。
ACCOUNT_ID_ENV_KEYS = ("BROWSER_RENDERING_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID")
TOKEN_ENV_KEYS = ("BROWSER_RENDERING_TOKEN", "CLOUDFLARE_API_TOKEN")

# ── 外链白名单（用户裁决：「外链策略从严格拒绝改为白名单自家域名」）─────────────
#
# 为什么还需要白名单：单证里的图片通常已经是 `data:` URI（产品图库引用在装配层内联），
# 但历史/legacy 数据可能直接写着自家域名下的图片地址。全部拒会把这类单据挡在自动出 PDF
# 之外；全放又会把"我们账号的浏览器"变成任意出网代理（SSRF）⇒ 只放行**自家域名**。
#
# `PDF_HTML_ALLOWED_HOSTS`：逗号分隔，大小写不敏感，条目允许其子域（`cdn.a.com` 命中 `a.com`）。
# 未设/空 ⇒ 用默认值；要完全禁外链就把它设成一个不可能命中的值（例如 `-`）。
ALLOWED_HOSTS_ENV_KEY = "PDF_HTML_ALLOWED_HOSTS"
DEFAULT_ALLOWED_HOSTS = ("kaas.powervoy.com", "api.kaas.powervoy.com")

# ── 安全校验：拒脚本类内容与外链资源 ─────────────────────────────────────────
#
# 注意：`<meta charset>` 是渲染器正常产出（render.ts 的 head），**不能**整类拒；
# 只拒 `<meta http-equiv="refresh">`（会让无头浏览器跳去外部地址）。
_FORBIDDEN_TAG_RES = (
    (re.compile(r"<\s*script\b", re.IGNORECASE), "<script>"),
    (re.compile(r"<\s*iframe\b", re.IGNORECASE), "<iframe>"),
    (re.compile(r"<\s*object\b", re.IGNORECASE), "<object>"),
    (re.compile(r"<\s*embed\b", re.IGNORECASE), "<embed>"),
    (re.compile(r"<\s*link\b", re.IGNORECASE), "<link>（外链样式/资源）"),
    (re.compile(r"<\s*base\b", re.IGNORECASE), "<base>（会改写相对地址）"),
    (re.compile(r"<\s*form\b", re.IGNORECASE), "<form>（可外发数据）"),
    (re.compile(r"<\s*meta[^>]*http-equiv\s*=\s*[\"']?\s*refresh", re.IGNORECASE),
     '<meta http-equiv="refresh">（跳转）'),
    (re.compile(r"<\s*meta[^>]*http-equiv\s*=\s*[\"']?\s*set-cookie", re.IGNORECASE),
     '<meta http-equiv="set-cookie">'),
    (re.compile(r"@\s*import\b", re.IGNORECASE), "@import（外链样式）"),
)
_EVENT_ATTR_RE = re.compile(r"\son[a-z]+\s*=", re.IGNORECASE)
_JS_URL_RE = re.compile(r"(?:javascript|vbscript)\s*:", re.IGNORECASE)
_DATA_HTML_URL_RE = re.compile(r"data\s*:\s*text/html", re.IGNORECASE)
# 会触发浏览器**取回外部资源**的属性（`<a href>` 不在此列：不点击不加载）。
_RESOURCE_ATTR_RE = re.compile(
    r"\b(?:src|srcset|href|poster|background|data|formaction|action|xlink:href)"
    r"\s*=\s*([\"']?)([^\"'\s>]+)",
    re.IGNORECASE,
)
_CSS_URL_RE = re.compile(r"url\(\s*([\"']?)([^\"')]+)", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]*>")
_SAFE_URL_PREFIXES = ("data:", "#")


def _snippet(text: str, limit: int = 80) -> str:
    text = text.strip().replace("\n", " ")
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _reject(code: str, detail: str) -> None:
    raise FileRuleError(code, detail)


def allowed_html_hosts(get_env: Callable[[str], Optional[str]]) -> tuple[str, ...]:
    """读外链白名单（`PDF_HTML_ALLOWED_HOSTS`，逗号分隔）—— 请求期读，两端同一份判定。

    未设 / 空 ⇒ `DEFAULT_ALLOWED_HOSTS`（**不是**"全部放行"，也不是"全部拒绝"）。
    返回值已小写、去空白、去前导点，并去重保序 —— 校验函数拿到的就是可直接比对的形状。
    """
    raw = get_env(ALLOWED_HOSTS_ENV_KEY) or ""
    text = str(raw).strip()
    if not text:
        return DEFAULT_ALLOWED_HOSTS
    hosts: list[str] = []
    for part in text.split(","):
        host = part.strip().lower().strip(".")  # 去掉两侧的点：`.a.com` 与 `a.com` 等价
        if host and host not in hosts:
            hosts.append(host)
    return tuple(hosts) or DEFAULT_ALLOWED_HOSTS


def host_allowed(url: str, allowed_hosts) -> bool:
    """`url` 的 host 是否命中白名单：**大小写不敏感、允许端口、条目允许子域**。

    刻意**不**放行的情况（白名单最容易写错的地方）：
    - 协议相对地址 `//host/x.png`（`urlsplit` 出来 scheme 为空 ⇒ 不是 http(s)）⇒ 否；
    - `a.com.evil.com` / `evilkaas.a.com` ⇒ 后缀匹配必须是 `.<条目>` 才成立；
    - `https://a.com@evil.com/x` ⇒ hostname 取的是 `evil.com`；
    - `blob:` / `file:` / `javascript:` 等任何非 http(s) 协议 ⇒ 否。
    """
    entries = tuple(
        str(h).strip().lower().strip(".")
        for h in (allowed_hosts or ())
        if str(h).strip()
    )
    if not entries:
        return False
    try:
        parts = urlsplit(str(url).strip())
    except ValueError:  # 非法 IPv6 等
        return False
    if parts.scheme.lower() not in ("http", "https"):
        return False
    # `hostname` 已小写、已去掉端口与用户信息；结尾的点（FQDN 写法的 `a.com.`）也去掉
    host = (parts.hostname or "").strip().lower().rstrip(".")
    if not host:
        return False
    return any(host == entry or host.endswith("." + entry) for entry in entries)


def _resource_url_allowed(value: str, allowed_hosts) -> bool:
    """资源地址：`data:` URI / 页内锚点 / 白名单域名（http(s)）放行，其余拒。"""
    head = value.strip().lower()
    if head.startswith(_SAFE_URL_PREFIXES):
        return True
    return host_allowed(value, allowed_hosts)


def _external_resource_detail(value: str, allowed_hosts, prefix: str = "HTML") -> str:
    hosts = "、".join(allowed_hosts) if allowed_hosts else "（无）"
    return (
        f"{prefix} 引用了外部资源：{_snippet(value)}"
        f"（只允许 data: URI 或白名单域名：{hosts}；可用 {ALLOWED_HOSTS_ENV_KEY} 配置）"
    )


def validate_render_html(
    html: object, allowed_hosts: Optional[tuple[str, ...]] = None
) -> None:
    """校验"交给无头浏览器渲染的那份 HTML"。任何一条不满足都抛 `FileRuleError`。

    为什么服务端还要再校验一次（前端明明也能拦）：前端能伪造请求体，
    而这个端点的后果是"我们账号的浏览器去渲染它" —— 服务端是**唯一的守门人**。

    `allowed_hosts` 是外链白名单（由调用方用 `allowed_html_hosts(取环境)` 读好传进来）；
    不传 ⇒ 用 `DEFAULT_ALLOWED_HOSTS`（**不是**"全部放行"）。

    拒绝面（全部映射到 422，`code` 区分原因）：
    - 非字符串 / 空 / 只含空白 → `HTML_REQUIRED`
    - 超过 2MB（按 UTF-8 字节）→ `HTML_TOO_LARGE`
    - `<script>`/`<iframe>`/`<object>`/`<embed>`/`<link>`/`<base>`/`<form>`、
      `on*=` 事件属性、`javascript:`/`vbscript:`、`data:text/html`、
      `<meta refresh/set-cookie>`、`@import` → `HTML_UNSAFE_MARKUP`
    - 资源地址（`src`/`href`/`srcset`/`poster`/`background`/`data`/`formaction`/
      `action`/`xlink:href` + CSS `url()`）既不是 `data:` URI、也不是白名单域名的
      http(s) 地址 → `HTML_EXTERNAL_RESOURCE`（含协议相对的 `//host/x`）
    """
    if not isinstance(html, str):
        _reject("HTML_REQUIRED", "html 必须是字符串（与预览同源的那份单证 HTML）")
    if html.strip() == "":
        _reject("HTML_REQUIRED", "html 不能为空：请把预览用的单证 HTML 一起发过来")

    hosts = tuple(allowed_hosts) if allowed_hosts is not None else DEFAULT_ALLOWED_HOSTS

    size = len(html.encode("utf-8"))
    if size > MAX_RENDER_HTML_BYTES:
        _reject(
            "HTML_TOO_LARGE",
            f"HTML 超过上限 {MAX_RENDER_HTML_BYTES // (1024 * 1024)}MB（实际 {size} 字节）",
        )

    for pattern, label in _FORBIDDEN_TAG_RES:
        hit = pattern.search(html)
        if hit:
            _reject("HTML_UNSAFE_MARKUP", f"HTML 含禁止的构造：{label}（{_snippet(hit.group(0))}）")

    # 脚本协议地址先判：`javascript:` 出现在 href 里时，若先走资源地址检查会被
    # 记成"外部资源"（同样是 422，但错误码误导人）。
    hit = _JS_URL_RE.search(html)
    if hit:
        _reject("HTML_UNSAFE_MARKUP", f"HTML 含脚本协议地址：{_snippet(hit.group(0))}")
    hit = _DATA_HTML_URL_RE.search(html)
    if hit:
        _reject("HTML_UNSAFE_MARKUP", "HTML 含 data:text/html 嵌套文档")

    # 事件属性与资源地址只在**标签内部**判：正文里的 "onload=" / "src=" 之类是用户文案
    # （渲染器已把 `<`/`"` 转义成实体），认成属性会误杀正常单据。
    for tag_match in _TAG_RE.finditer(html):
        tag = tag_match.group(0)
        hit = _EVENT_ATTR_RE.search(tag)
        if hit:
            _reject(
                "HTML_UNSAFE_MARKUP",
                f"HTML 含内联事件属性：{_snippet(hit.group(0))}（只渲染自包含静态单据）",
            )
        for _quote, value in _RESOURCE_ATTR_RE.findall(tag):
            if not _resource_url_allowed(value, hosts):
                _reject("HTML_EXTERNAL_RESOURCE", _external_resource_detail(value, hosts))

    # CSS 里的外链（`url(...)`）：样式只会出现在 `<style>` 或 `style=` 属性里，
    # 这两处都是渲染器自己产出的；正文里出现 "url(" 的概率极低，判错也只是拒（fail-safe）。
    for _quote, value in _CSS_URL_RE.findall(html):
        if not _resource_url_allowed(value, hosts):
            _reject(
                "HTML_EXTERNAL_RESOURCE",
                _external_resource_detail(value, hosts, prefix="CSS"),
            )


def looks_like_pdf(data: object) -> bool:
    """字节是不是 PDF（只看魔数 `%PDF-`）。

    为什么必须验：渲染服务返回非 2xx 时可能是一段 JSON 错误体，
    若不验就会把"错误信息"当成 PDF 存进 `render_pdf`（外观看不出来，事后极难发现）。
    """
    if not isinstance(data, (bytes, bytearray)):
        return False
    return bytes(data[: len(PDF_MAGIC)]) == PDF_MAGIC


def _first_env(get_env: Callable[[str], Optional[str]], keys: tuple[str, ...]) -> str:
    for key in keys:
        value = get_env(key)
        if value and str(value).strip():
            return str(value).strip()
    return ""


def render_pdf_rest_config(get_env: Callable[[str], Optional[str]]) -> Optional[dict]:
    """REST 方式（orchestrator / 本地）的 Browser Rendering 配置；没配好返回 `None`。

    返回 `{"account_id", "token", "url"}`。**没配好就是没配好**：调用方据此返回
    503 `PDF_RENDERER_NOT_CONFIGURED`，绝不假装成功。
    """
    account_id = _first_env(get_env, ACCOUNT_ID_ENV_KEYS)
    token = _first_env(get_env, TOKEN_ENV_KEYS)
    if not account_id or not token:
        return None
    if not _ACCOUNT_ID_RE.match(account_id):
        # 防呆 + 防注入：账号 id 是 32 位十六进制，拼进 URL 前先卡住
        return None
    return {"account_id": account_id, "token": token,
            "url": render_pdf_rest_url(account_id)}


def render_pdf_rest_url(account_id: str) -> str:
    """Browser Rendering `/pdf` 的完整 REST 地址。"""
    if not _ACCOUNT_ID_RE.match(account_id or ""):
        raise ValueError(f"账号 id 形状不对（应为 32 位十六进制）：{account_id!r}")
    return CLOUDFLARE_API_ORIGIN + BROWSER_RENDERING_QUICK_ACTION_PATH.format(
        account_id=account_id
    )
