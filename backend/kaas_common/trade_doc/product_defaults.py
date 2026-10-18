"""产品基础信息 → 单据渲染默认值（共享内核 · G1：orchestrator / Worker 共用一份）。

用户要求（原话）：「产品图/基础信息**一次维护、重复使用**」。

现状与设计
----------
产品基础信息存在 `product_profiles.info`（键为材质/表面处理/用途/HS 编码/包装/产地，
即 `material` / `surface` / `usage` / `hs_code` / `packing` / `origin`，见 /products 工位）。
单据用 `raw_payload.custom.product_key` 记录"本单属于哪个产品"（前端「关联产品」选择器写入）。

**只填渲染契约真实支持的字段，一个都不发明**（2026-10-11 逐项核对）：
- 顶层字段：`manifest.json` 与模板占位符里**没有任何**顶层字段与上述六个 info 键同名
  （模板里 `$material/$surface/$usage/$hs_code/$packing/$origin` 出现 0 次；
  `$country_of_origin` 出现 7 次，但产品档案的键是 `origin`（产地，如"河北安平"），
  **不是国家** —— 不能拿它冒充 Country of Origin）。所以顶层字段一律不填：
  填了模板也不会输出，更等于猜字段。
- 唯一真实交集是**行项 HS 编码**：manifest 在 `ci` / `co` / `quality_cert` /
  `customs_declaration` 的 `items` 说明里明确写了「HS编码」，渲染器
  （`render.ts` 的 `ITEM_COLUMNS`）为这四类输出 HS Code 列，
  行项装配（`payload_shared._SPEC_FIELDS`）也把 `hs_code` 当一等字段。

优先级（与两端壳层逐条一致）
---------------------------
1. 行项**已显式给过** `hs_code`（含空串 / null，含上游快照带出的）⇒ **不覆盖**；
2. 否则用产品档案的 `hs_code` 补进**空着的**行项；
3. 没有 `product_key` / 档案没有 `hs_code` / 单据类型没声明 HS 列 / 没有行项
   ⇒ **完全不动 data**（不塞空串、不猜字段）。

多产品单据的注意点
------------------
关联是**单据级**的（一个 `product_key`）。一张单里混了多个产品时**不要**设
`product_key`，否则空着的行项会全被标成该产品的 HS 编码。行项级关联是后续话题。
"""
from __future__ import annotations

from typing import Optional

__all__ = [
    "PRODUCT_KEY_FIELD", "PRODUCT_INFO_KEYS", "HS_ITEM_DOC_TYPES",
    "product_key_of", "apply_product_defaults",
]

# 单据里记录"属于哪个产品"的 custom 键（前端「关联产品」选择器写入）
PRODUCT_KEY_FIELD = "product_key"

# /products 工位维护的基础信息键（`product_profiles.info`）
PRODUCT_INFO_KEYS = ("material", "surface", "usage", "hs_code", "packing", "origin")

# 行项表里有 HS Code 列的单据类型 —— 以 manifest 的 items 说明 + 渲染器 ITEM_COLUMNS 为准。
# 这份清单由单测拿 manifest.json 复核（改一端不改另一端会红）。
# 2026-10-18 用户口径：报价单 / 形式发票 / 合同 / 装箱单 / 重量单 / 装运通知也展示 HS 编码。
HS_ITEM_DOC_TYPES = (
    "quotation", "pi", "contract",
    "ci", "pl", "shipping_advice",
    "weight_list", "quality_cert", "co", "customs_declaration",
)

_HS_FIELD = "hs_code"


def _text(value) -> Optional[str]:
    """非空标量 → 去空白字符串；None / 空串 / 容器 → None。

    **必须转成字符串**：HS 编码若以数字进渲染器，会被 `renderCell` 按金额格式化
    （7314.41 → 7,314.41），海关审单直接判不符（`render.ts` 有同名警告）。
    """
    if value is None or isinstance(value, (dict, list, tuple, set)):
        return None
    text = str(value).strip()
    return text or None


def product_key_of(custom) -> Optional[str]:
    """单据关联的产品 key（`custom.product_key`）。

    只有**非空字符串**才算关联：别的类型（数字/对象）不是注册表里的 key，
    一律当"没关联"处理 —— 宁可不动 data，也不去做一次注定失败的查询。
    """
    if not isinstance(custom, dict):
        return None
    raw = custom.get(PRODUCT_KEY_FIELD)
    if not isinstance(raw, str):
        return None
    key = raw.strip()
    return key or None


def apply_product_defaults(data: dict, custom, doc_type, product_info) -> dict:
    """把产品档案的信息补进渲染数据（纯函数：不改库、不发请求）。

    `product_info` 由调用方取数后传入（产品**不存在/未维护**时传 None 或 {}）：
    "取数"两端不同（orchestrator 走 SQLAlchemy session、Worker 走请求期 db.fetchrow），
    但"取到之后怎么填"只有这一份判定。

    就地修改 `data["items"]` 里空着的行项并返回 `data`；不满足条件时原样返回。
    """
    if not product_key_of(custom):
        return data                                  # 没有显式关联 → 一个字段都不动
    if not isinstance(product_info, dict) or not product_info:
        return data                                  # 产品档案没维护任何信息
    if doc_type not in HS_ITEM_DOC_TYPES:
        return data                                  # 该类单据没声明 HS 列 → 不填
    hs_code = _text(product_info.get(_HS_FIELD))
    if hs_code is None:
        return data                                  # 档案里没有可用的 HS 编码
    items = data.get("items")
    if not isinstance(items, list):
        return data                                  # 没有行项（手工单/无上游）→ 不造行项
    for item in items:
        if not isinstance(item, dict) or _HS_FIELD in item:
            continue                                 # 已显式给过（含空串/None）→ 不覆盖
        item[_HS_FIELD] = hs_code
    return data
