"""工位订阅与开通判定 —— 纯函数、零三方依赖（stdlib only）。

授权模型（2026-10-11 业务确认）
------------------------------
**业务逻辑不以租户做鉴权边界**。真正的边界是：

    这个账号 / 这个团队开通了哪些**工位**

- 数据隔离靠**团队**（`scope.py`）；
- 能力边界靠**工位订阅**（本模块）；
- 订阅主体：**团队为主**（团队开通 = 全员可用），**个人可额外开通**。
- 平台管理员（system_admin）不受限（运维兜底）。

生效方式：未开通的工位 API 返回 **404**（不暴露工位存在性），
另外提供「我的工位」接口给前端隐藏入口 / 显示开通引导页。

工位清单来源
------------
`shared/contracts/workstations.ts` 是前端侧边栏的唯一真源（R2 契约校验），
本模块的工位 key 与它一一对应；路径前缀按后端路由归属划分。
"""
from __future__ import annotations

from typing import Iterable, Optional

__all__ = [
    "FULL_CHAIN", "WORKSTATION_PATHS", "ALWAYS_ALLOWED_PREFIXES",
    "workstation_of", "is_always_allowed", "has_workstation",
    "all_workstations", "normalize_codes",
]

# 全工位套餐：开通它等于开通所有工位（现有 tenant_subscriptions 用的就是这个编码）
FULL_CHAIN = "full_chain"

# 工位 key → 该工位覆盖的 API 路径前缀。
# key 与 shared/contracts/workstations.ts 的 workstation.key 对齐（前端侧边栏同一套）。
WORKSTATION_PATHS: dict[str, tuple[str, ...]] = {
    "customers": ("/api/v1/customers", "/api/v1/inquiries"),
    "quotes": (
        "/api/v1/quotes", "/api/v1/quotations", "/api/v1/export-quote",
        "/api/v1/quote-profiles", "/api/v1/pricing-data", "/api/v1/spec",
        # 门面供数 → 内核纯算的 RPC 入口（P2 切片）。**必须在此登记**：
        # 工位闸门是"按路径映射"的全局中间件（backend/worker/src/ws_workstations.py），
        # 内部路径不登记 ⇒ 闸门不放行/不拦截 = 未开通工位的账号可绕过商业限制算价
        # （2026-10-24 灰度实测踩到过，见 docs/P2_COUPLING_ENGINE_2026-10-24.md §8.5.2）。
        "/api/v1/internal/engine/quote",
    ),
    "orders": ("/api/v1/orders", "/api/v1/payment-schedules", "/api/v1/receivables"),
    "trade-docs": (
        "/api/v1/trade-docs", "/api/v1/tenant/company-profile",
        "/api/v1/tenant/company-seals", "/api/v1/external-docs",
        "/api/v1/fx-rates", "/api/v1/actual-costs",
    ),
    "shipments": ("/api/v1/shipments",),
    "leadgen": ("/api/v1/leadgen", "/api/v1/leads"),
    "outreach": ("/api/v1/outreach",),
    "intel": ("/api/v1/intel",),
    "research": ("/api/v1/research", "/api/v1/market"),
}

# 永不锁死的路径：账号/团队/订阅/管理/统一字典/健康检查。
# 这些一旦被锁，用户就没法"去开通工位"了 —— 死锁。
ALWAYS_ALLOWED_PREFIXES: tuple[str, ...] = (
    "/api/v1/auth",
    "/api/v1/teams",
    "/api/v1/me",
    "/api/v1/admin",
    "/api/v1/dashboard",
    "/api/v1/events",
    "/api/v1/capabilities",
    "/api/v1/enums",
    "/api/v1/tenant-products",   # 产品定义属"我的"配置，不按工位收费
    # 产品素材（产品图 + 基础信息）与文件域：单证/报价都要引用它们，
    # 锁掉等于让付费工位失去素材来源 ⇒ 同 tenant-products，不按工位收费。
    "/api/v1/products",
    "/api/v1/file-objects",
    "/health",
)


def _match_prefix(path: str, prefix: str) -> bool:
    """前缀匹配，且要求边界（`/api/v1/order` 不应匹配 `/api/v1/orders`）。"""
    return path == prefix or path.startswith(prefix + "/")


def is_always_allowed(path: str) -> bool:
    return any(_match_prefix(path, p) for p in ALWAYS_ALLOWED_PREFIXES)


def workstation_of(path: str) -> Optional[str]:
    """API 路径 → 工位 key；不属于任何收费工位的返回 None（= 不拦）。"""
    for key, prefixes in WORKSTATION_PATHS.items():
        if any(_match_prefix(path, p) for p in prefixes):
            return key
    return None


def normalize_codes(codes: Optional[Iterable[str]]) -> frozenset[str]:
    """把若干订阅编码规范化（去空白、小写、去重、丢空值）。"""
    out = set()
    for code in codes or ():
        if code is None:
            continue
        text = str(code).strip().lower()
        if text:
            out.add(text)
    return frozenset(out)


def has_workstation(enabled_codes: Optional[Iterable[str]], workstation: Optional[str]) -> bool:
    """是否开通了某工位。

    `full_chain` 是"全工位"套餐，命中等同于开通一切。
    `workstation is None`（不属于任何工位）时不拦。
    """
    if workstation is None:
        return True
    codes = normalize_codes(enabled_codes)
    return FULL_CHAIN in codes or workstation.strip().lower() in codes


def all_workstations() -> tuple[str, ...]:
    return tuple(sorted(WORKSTATION_PATHS))
