"""从官网 HTML 抽取产品信息（**两端同一份**）。

为什么放进共享内核
------------------
这段是**纯确定性脚本**：只用 `re` + `urlparse`，没有任何平台依赖。
原先它是 worker 的 `chain.py` 私有函数，而 `chain.py` 依赖 Pyodide、
**在 CPython 测试环境里 import 不了** —— 也就是说这段解析逻辑
**一直测不到**，偏偏它又是最容易出错的一类代码（正则、HTML 变体、编码）。

放进 `kaas_common` 后两端 import 同一份，测试跑在 orchestrator 套件里。

口径
----
- **确定性脚本，AI 不参与**（与 worker 侧注释一致）。同样的 HTML 必须得到
  同样的结果 —— 否则"这条线索的产品名为什么变了"这类问题无法追。
- 只做**保守抽取**：抓不到就回 `None`，**绝不猜**。
  猜错的产品名会被当成真实数据进入线索池，比空着更糟。
"""
from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urlparse

_META_TAG_RE = re.compile(r"<meta\b[^>]*>", re.IGNORECASE)
_ATTR_RE = re.compile(r"([a-zA-Z:_-]+)\s*=\s*[\"']([^\"']*)[\"']")
_SCRIPT_STYLE_RE = re.compile(r"<(script|style|noscript)\b.*?</\1>",
                              re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_H1_RE = re.compile(r"<h1[^>]*>(.*?)</h1>", re.IGNORECASE | re.DOTALL)
_LINK_RE = re.compile(r"<a\b[^>]*href\s*=\s*[\"']([^\"']+)[\"'][^>]*>(.*?)</a>",
                      re.IGNORECASE | re.DOTALL)

# 产品页特征路径（脚本规则，命中最先出现的一个）
PRODUCT_PATH_HINTS = ("/product", "/products", "/catalog", "/catalogue",
                      "/shop", "/store", "/category", "/collections", "/goods")

# 规格原文里正文的截断长度（与 worker 侧一致）
SPEC_BODY_LIMIT = 1200


def strip_html(fragment: str) -> str:
    """去标签 + 压缩空白（正则版，够用且无依赖）。"""
    text = _SCRIPT_STYLE_RE.sub(" ", fragment or "")
    text = _TAG_RE.sub(" ", text)
    text = (text.replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
                .replace("&#39;", "'"))
    return re.sub(r"\s+", " ", text).strip()


def meta_content(html: str, keys: tuple) -> Optional[str]:
    """按 property/name 抓 meta 的 content。"""
    for tag in _META_TAG_RE.findall(html or ""):
        attrs = {k.lower(): v for k, v in _ATTR_RE.findall(tag)}
        key = (attrs.get("property") or attrs.get("name") or "").lower()
        if key in keys and attrs.get("content"):
            return attrs["content"].strip()
    return None


def abs_url(base: str, href: str) -> str:
    """把相对链接补成绝对地址（协议/协议相对/根路径/相对路径四类）。"""
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

    返回：``product_name`` / ``product_name_source`` / ``page_title`` /
    ``product_image_url`` / ``spec_raw`` / ``link_url``

    产品名优先级 **h1 > title**：h1 通常才是产品名，title 往往带
    "公司名 - 首页"这类噪音。同时回 `product_name_source`，
    让下游能看出这个名字是从哪来的（排查"名字不对"时很关键）。
    """
    og_image = meta_content(html, ("og:image", "og:image:secure_url",
                                  "twitter:image", "image"))
    description = meta_content(html, ("description", "og:description"))
    title_m = _TITLE_RE.search(html or "")
    title = strip_html(title_m.group(1)) if title_m else ""
    h1_m = _H1_RE.search(html or "")
    h1 = strip_html(h1_m.group(1)) if h1_m else ""

    # 产品页链接：优先命中所选路径特征词
    link_url = None
    for href, _anchor in _LINK_RE.findall(html or ""):
        low = href.lower()
        if any(hint in low for hint in PRODUCT_PATH_HINTS):
            link_url = abs_url(base_url, href)
            break

    # 主体文本（去脚本样式）作为规格原文
    body_text = strip_html(html)
    spec_parts = []
    if description:
        spec_parts.append(description)
    if body_text:
        spec_parts.append(body_text[:SPEC_BODY_LIMIT])

    return {
        "product_name": h1 or title or None,
        "product_name_source": "h1" if h1 else ("title" if title else None),
        "page_title": title or None,
        "product_image_url": og_image,
        "spec_raw": "\n".join(p for p in spec_parts if p) or None,
        "link_url": link_url,
    }
