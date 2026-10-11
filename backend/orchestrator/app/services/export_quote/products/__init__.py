"""产品类注册表。

产品知识（规格轴、变体、公式、列、说明）集中在 `products/` 下，
引擎不认识任何具体产品，报价政策也不认识任何产品。
换产品 = 换一个 ProductSpec；加规格/改公式 = 改对应产品类。
"""
from __future__ import annotations

from typing import Callable, Iterable

from ..models import ProductSpec

_REGISTRY: dict[str, Callable[[], ProductSpec]] = {}


def register(key: str):
    """把返回 ProductSpec 的工厂函数登记进注册表。"""

    def deco(fn: Callable[[], ProductSpec]):
        _REGISTRY[key] = fn
        return fn

    return deco


def get(key: str) -> ProductSpec:
    if key not in _REGISTRY:
        raise KeyError(
            f"未注册的产品模型 {key!r}；已注册: {', '.join(sorted(_REGISTRY)) or '（空）'}"
        )
    return _REGISTRY[key]()


def has(key: str) -> bool:
    return key in _REGISTRY


def keys() -> list[str]:
    return sorted(_REGISTRY)


def all_specs() -> Iterable[ProductSpec]:
    for k in keys():
        yield get(k)


# 导入即注册（放在末尾避免循环导入）
# 只注册**真实业务产品**；引擎通用性由测试里的内联探针 spec 验证，
# 不为了验证而往产品表里挂一个假产品（假产品会出现在业务的产品清单里）。
from . import field_fence  # noqa: E402,F401
from . import chain_link  # noqa: E402,F401
