"""公司默认公章的渲染回落（共享内核）—— orchestrator 与 Worker **共用一份**（G1）。

背景
----
公章（`tenant_company_seals`，写入侧见 orchestrator `app/api/company_seals.py`
与 Worker `src/ws_seals.py`）是**租户级可复用资产**，但单据渲染原先只认单据
`raw_payload.custom.company_stamp` —— 于是"章存了"还得每张单据手工传一次图。
本模块放的是**装配层判定**：单据没显式给章时，用租户默认章（转 `data:` URI）补上，
渲染器一行都不用改（它的图片白名单只认 `data:` 与 `http(s)`）。

为什么必须在共享内核
  两端（orchestrator / Worker）都要做同一套判定（字段名、覆盖优先级、空值处理）；
  各写一份必然漂移（G1）。纯标准库、零三方依赖 ⇒ Pyodide 也能加载。

覆盖优先级（两端逐字一致）
  1. 单据 `custom` **显式含** `company_stamp` 键（哪怕是空串）⇒ 以它为准，不覆盖；
  2. 否则租户有默认章（`is_default`）⇒ 取 `png_bytes` 转 `data:` URI 填入；
  3. 两者都没有 ⇒ 原样返回（渲染器本来就不盖章位，不伪造一张空图）。

取数不在这里
  两端"怎么取到默认章那一行"不同（orchestrator 走 SQLAlchemy session、Worker 走
  请求期 `db.fetchrow`），但**取到之后的判定只有这一份**。
"""
from __future__ import annotations

from typing import Optional

from .rules import to_data_uri

__all__ = ["SEAL_FIELD", "seal_field", "seal_data_uri", "apply_default_seal"]

# 渲染数据里公章位的字段名（渲染器认的键就是它）
SEAL_FIELD = "company_stamp"


def seal_field(row, key):
    """从公章行取列：dict / asyncpg Record 走下标，ORM 对象走属性（纯函数，无 IO）。"""
    if row is None:
        return None
    try:
        return row[key]
    except (TypeError, KeyError, IndexError):
        return getattr(row, key, None)


def seal_data_uri(seal_row) -> Optional[str]:
    """租户公章行 → `data:` URI（纯函数：无 DB、无请求、无图像库）。

    章的图统一是 PNG 字节（`tenant_company_seals.png_bytes`：上传时前端 Canvas 已
    归一化，后端零图像库），所以这里不需要任何图像处理。
    空字节 → None：宁可没有章位，也不伪造一张空图。
    """
    png = seal_field(seal_row, "png_bytes")
    if not png:
        return None
    return to_data_uri(seal_field(seal_row, "mime") or "image/png", bytes(png), "seal.png")


def apply_default_seal(data: dict, custom, seal_row) -> dict:
    """把默认公章填进渲染数据（纯函数：入参给什么就用什么）。

    优先级见模块头；`custom` 显式给过 `company_stamp`（含空串）时原样返回 ——
    单据手工传的图优先，这是保守口径。
    """
    if isinstance(custom, dict) and SEAL_FIELD in custom:
        return data
    uri = seal_data_uri(seal_row)
    if uri:
        data[SEAL_FIELD] = uri
    return data
