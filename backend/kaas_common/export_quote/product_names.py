"""产品英文名（一名多写法 / 主名）—— 团队级口径的**唯一**实现。

问题（2026-10-24 生产验收）
==========================
1. 产品基本信息里的英文名改完不保存（旧前端只 PUT `/products/{key}/profile` 的
   usage/origin/material_options，英文名根本没进请求体）；
2. 鹿网 / 牛栏网（代码注册表系统产品）的英文名改不了 —— 生产库 `tenant_products`
   只有团队自定义的两行，系统产品的真源是代码注册表，DB 里**没有 is_system 行**；
3. 一个产品在不同地区叫法不同 ⇒ 英文名要支持多个，且有一个"主英文名"给报价/单证用。

为什么存 `product_profiles.info` 而不是 `tenant_products`
==========================================================
`product_profiles` 本来就是**团队作用域的可编辑产品资料**（用途 / 产地 / 材质选项），
任何团队对**任何产品**（含系统产品）都能写一行 —— 正好覆盖"系统产品也要能按团队改英文名"
这条需求，而且**不需要 DB 迁移**。`tenant_products` 只代表"团队自定义的产品定义"，
系统产品没有这一行，写不进去（这正是旧版静默丢名的根因之一）。

存储形状（`info` 里的两个键）
==============================
- `name_en_list`    : `list[str]`，**主名在前**（有序；第一个就是主英文名）
- `name_en_primary` : `str`，主英文名（= 列表第一个；显式存一份，读侧不必依赖顺序）

读侧兼容（**不能把旧数据当成"没配"**）
======================================
1. 只有 `name_en_list`、没有 `name_en_primary` ⇒ 主名 = 列表第一个；
2. 只有 `name_en_primary`、且不在列表里 ⇒ 主名 = 它，并插到列表最前；
3. 只有历史的单值 `name_en`（早期前端 / 手工 SQL 写的）⇒ 当成唯一英文名；
4. 两端空白 / 空串 / 重复（大小写不敏感）在归一化时清掉，保留首次出现的写法。

写侧约定
========
调用方把用户提交的原始 `info` 交给 `apply_name_en_info`，拿返回值落库：
- 归一化只在**内核**做一次（前端只是把用户输入原样搬运）；
- 其它键（usage / origin / material_options / 未知键）原样保留；
- 历史单值 `name_en` 若本来就在，跟着主名同步（避免两个值打架）。

纯标准库：`kaas_common` 由 `scripts/sync-shared.ps1` 镜像进 Worker（Pyodide），
不能引第三方依赖。
"""
from __future__ import annotations

from typing import Any, Mapping

#: 全部英文名（主名在前）
LIST_KEY = "name_en_list"
#: 主英文名（= 列表第一个）
PRIMARY_KEY = "name_en_primary"
#: 历史单值英文名（早期前端 / 手工 SQL 的写法；只读兼容，不作为新写入形状）
LEGACY_SINGLE_KEY = "name_en"


def clean_name(value: Any) -> str:
    """单个英文名归一化：只去两端空白；非字符串按字符串处理；None/空串 → `""`。"""
    if value is None:
        return ""
    if not isinstance(value, str):
        value = str(value)
    return value.strip()


def normalize_names(values: Any) -> list[str]:
    """`["Chain Link", "chain link ", "", None]` → `["Chain Link"]`。

    接受单个字符串、list / tuple / set；顺序保留（第一个是主名）；重复按
    `casefold()` 去重（大小写不同的同名视为同一个名字，保留首次出现的写法）。
    """
    if values is None:
        return []
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, (list, tuple, set)):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for raw in values:
        name = clean_name(raw)
        if not name:
            continue
        folded = name.casefold()
        if folded in seen:
            continue
        seen.add(folded)
        out.append(name)
    return out


def _as_info(info: Any) -> dict:
    """`info` 既可能是 dict，也可能是坏值（None / list / 字符串）⇒ 一律当空 dict。"""
    if isinstance(info, Mapping):
        return dict(info)
    return {}


def name_en_list_from_info(info: Any) -> list[str]:
    """读：全部英文名（主名在前；兼容历史单值 `name_en`）。"""
    data = _as_info(info)
    names = normalize_names(data.get(LIST_KEY))
    if not names:
        legacy = clean_name(data.get(LEGACY_SINGLE_KEY))
        if legacy:
            names = [legacy]
    primary = clean_name(data.get(PRIMARY_KEY))
    if primary:
        matched = next((n for n in names if n.casefold() == primary.casefold()), None)
        if matched is None:
            names.insert(0, primary)
        else:
            names.remove(matched)
            names.insert(0, matched)
    return names


def primary_name_en_from_info(info: Any) -> str:
    """读：主英文名；没配 → `""`（调用方回落到 `spec.name_en`）。"""
    names = name_en_list_from_info(info)
    return names[0] if names else ""


def has_name_en_info(info: Any) -> bool:
    """这份 `info` 里是否出现过任何形式的英文名（新形状或历史单值）。"""
    data = _as_info(info)
    if any(key in data for key in (LIST_KEY, PRIMARY_KEY)):
        return True
    return bool(clean_name(data.get(LEGACY_SINGLE_KEY)))


def apply_name_en_info(
    info: Any, *, names: Any = None, primary: Any = None
) -> dict:
    """写：返回归一化后的**完整 info**（保留其它键），落库用这个返回值。

    - `names` 为 None ⇒ 用 info 里现有的英文名（含历史单值）作为名单；
    - `primary` 为 None ⇒ 用 info 里现有的 `name_en_primary`（没有则列表第一个）；
    - `primary` 必须落进名单：名单里已有（大小写不敏感）就把它挪到最前，
      没有就插到最前 —— 主名永远 = `name_en_list[0]`，两个键不会互相矛盾。
    """
    data = _as_info(info)
    explicit = names is not None or primary is not None
    had_keys = any(
        key in data for key in (LIST_KEY, PRIMARY_KEY, LEGACY_SINGLE_KEY))
    if names is None:
        current = name_en_list_from_info(data)
        if primary is not None:
            current = normalize_names(list(current) + [primary])
    else:
        current = normalize_names(names)

    wanted = clean_name(primary) if primary is not None else clean_name(data.get(PRIMARY_KEY))
    if wanted and current:
        matched = next((n for n in current if n.casefold() == wanted.casefold()), None)
        if matched is not None:
            current.remove(matched)
            current.insert(0, matched)

    # 完全没配英文名、也不是"显式来改英文名"的请求 ⇒ 一个键都不加。
    # 理由：`PUT /products/{key}/profile` 也承载用途/产地/材质（老前端只发这些），
    # 不能因为一次资料保存就凭空给每行塞两个空英文名键（响应会跟着变形）。
    if not (current or explicit or had_keys):
        return data

    data[LIST_KEY] = current
    data[PRIMARY_KEY] = current[0] if current else ""
    if LEGACY_SINGLE_KEY in data:
        # 历史单值读者（旧前端 / 手工 SQL）跟着主名走，避免两个值不一致
        data[LEGACY_SINGLE_KEY] = current[0] if current else ""
    return data


def normalized_info(info: Any) -> dict:
    """读端点用：有英文名时补出规范形状（`name_en_list` + `name_en_primary`），
    其它键原样返回；完全没配英文名时**一个键都不加**（保持旧响应逐字不变）。"""
    data = _as_info(info)
    if not has_name_en_info(data):
        return data
    return apply_name_en_info(data)
