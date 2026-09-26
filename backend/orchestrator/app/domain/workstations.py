"""Kaas v2 · 工位元数据（后端镜像）

⚠️ 这是 `shared/contracts/workstations.ts` 的【镜像】，两者必须一致。
   · 权威源：`shared/contracts/workstations.ts`
   · 校验：`pnpm contracts:check`（scripts/contracts-check.ts 的 R2 规则）
   · 修改任一侧后必须同步另一侧，否则 CI 会失败。

用途（后端侧）：
  1. 订阅门禁：`app/api/subs.py` 的工位 → 订阅编码映射以此为准
  2. 审计/埋点：校验上报的 resource_id 是否属于已知工位
  3. 路由一致性：与前端侧边栏对齐，避免「菜单有但后端没有」或反之
"""
from typing import Optional

# ─── 分组（顺序即业务推进顺序） ───

NAV_GROUPS = [
    {"key": "overview", "label": "", "order": 0, "internal_only": False},
    {"key": "business", "label": "业务", "order": 10, "internal_only": False},
    {"key": "intel", "label": "情报", "order": 20, "internal_only": True},
    {"key": "data", "label": "数据", "order": 30, "internal_only": False},
    {"key": "customer", "label": "客户", "order": 90, "internal_only": False},
    {"key": "admin", "label": "管理", "order": 99, "internal_only": True},
]

# ─── 工位清单 ───
# 字段：key / name / route / group / order / admin_only / status / subscription
# status: active(已上线) | placeholder(占位) | planned(待建) | hidden(无侧边栏入口)

WORKSTATIONS = [
    # 概览
    {
        "key": "dashboard", "name": "仪表盘", "route": "/dashboard",
        "group": "overview", "order": 0,
        "admin_only": False, "status": "placeholder", "subscription": None,
    },
    # 业务主链（按业务推进排序）
    {
        "key": "research", "name": "市场调研", "route": "/research",
        "group": "business", "order": 10,
        "admin_only": True, "status": "active", "subscription": None,
    },
    {
        "key": "leadgen", "name": "地图源客户信息获取", "route": "/leadgen",
        "group": "business", "order": 20,
        "admin_only": True, "status": "active", "subscription": "leadgen_starter",
    },
    {
        "key": "outreach", "name": "客户触达", "route": "/outreach",
        "group": "business", "order": 30,
        "admin_only": False, "status": "active", "subscription": "outreach_starter",
    },
    {
        "key": "quotes", "name": "报价", "route": "/quotes",
        "group": "business", "order": 40,
        "admin_only": False, "status": "active", "subscription": None,
    },
    {
        "key": "quote-records", "name": "报价记录", "route": "/quotations",
        "group": "business", "order": 45,
        "admin_only": False, "status": "hidden", "subscription": None,
    },
    {
        "key": "trade-docs", "name": "单证", "route": "/trade-docs",
        "group": "business", "order": 50,
        "admin_only": False, "status": "active", "subscription": None,
    },
    {
        "key": "orders", "name": "订单", "route": "/orders",
        "group": "business", "order": 60,
        "admin_only": False, "status": "active", "subscription": None,
    },
    {
        "key": "shipments", "name": "出货", "route": "/shipments",
        "group": "business", "order": 70,
        "admin_only": False, "status": "active", "subscription": None,
    },
    # 情报
    {
        "key": "intel", "name": "市场情报", "route": "/intel",
        "group": "intel", "order": 10,
        "admin_only": True, "status": "active", "subscription": None,
    },
    # 数据
    {
        "key": "pricing-data", "name": "定价数据", "route": "/pricing-data",
        "group": "data", "order": 10,
        "admin_only": False, "status": "hidden", "subscription": None,
    },
    {
        "key": "market", "name": "产品市场对照", "route": "/market",
        "group": "data", "order": 20,
        "admin_only": True, "status": "hidden", "subscription": None,
    },
    # 客户（固定在最后、设置之前）
    {
        "key": "customers", "name": "客户管理", "route": "/customers",
        "group": "customer", "order": 10,
        "admin_only": False, "status": "active", "subscription": None,
    },
    # 管理
    {
        "key": "settings", "name": "系统设置", "route": "/settings",
        "group": "admin", "order": 10,
        "admin_only": True, "status": "active", "subscription": None,
    },
    {
        "key": "ai-providers", "name": "AI Providers", "route": "/settings/ai-providers",
        "group": "admin", "order": 20,
        "admin_only": True, "status": "active", "subscription": None,
    },
    # 不上侧边栏
    {
        "key": "billing", "name": "升级订阅", "route": "/billing",
        "group": "account", "order": 10,
        "admin_only": False, "status": "hidden", "subscription": None,
    },
    {
        "key": "spec-config", "name": "规格配置", "route": "/spec-config",
        "group": "data", "order": 90,
        "admin_only": True, "status": "hidden", "subscription": None,
    },
    {
        "key": "spec-proposals", "name": "属性提案审核", "route": "/admin/spec-proposals",
        "group": "admin", "order": 90,
        "admin_only": True, "status": "hidden", "subscription": None,
    },
    {
        "key": "onboarding", "name": "新手引导", "route": "/onboarding",
        "group": "account", "order": 20,
        "admin_only": False, "status": "hidden", "subscription": None,
    },
    {
        "key": "kb", "name": "知识库", "route": "/kb",
        "group": "account", "order": 30,
        "admin_only": True, "status": "hidden", "subscription": None,
    },
    {
        "key": "events", "name": "事件审计", "route": "/events",
        "group": "audit", "order": 10,
        "admin_only": True, "status": "hidden", "subscription": None,
    },
    {
        "key": "audit-log", "name": "操作日志", "route": "/audit-log",
        "group": "audit", "order": 20,
        "admin_only": True, "status": "hidden", "subscription": None,
    },
    {
        "key": "gray-release", "name": "灰度切换", "route": "/admin/gray-release",
        "group": "admin", "order": 80,
        "admin_only": True, "status": "hidden", "subscription": None,
    },
]


def workstation_by_key(key: str) -> Optional[dict]:
    """按稳定 key 取工位。"""
    for w in WORKSTATIONS:
        if w["key"] == key:
            return w
    return None


def workstation_by_route(pathname: str) -> Optional[dict]:
    """按路由取工位（最长前缀匹配，支持 /settings/ai-providers 这类子路由）。"""
    hits = [
        w for w in WORKSTATIONS
        if pathname == w["route"] or pathname.startswith(w["route"] + "/")
    ]
    if not hits:
        return None
    return max(hits, key=lambda w: len(w["route"]))


def visible_workstations() -> list[dict]:
    """侧边栏可见工位（排除 planned / hidden），按分组顺序 + 组内顺序。"""
    group_order = {g["key"]: g["order"] for g in NAV_GROUPS}
    items = [w for w in WORKSTATIONS if w["status"] in ("active", "placeholder")]
    return sorted(items, key=lambda w: (group_order.get(w["group"], 999), w["order"]))


def required_subscription(key: str) -> Optional[str]:
    """该工位所需订阅编码；None = 免费。

    付费墙当前【未启用】（先免费），此函数供未来启用时使用，
    与 `app/api/subs.py` 的 WORKSTATION_CODES 口径一致。
    """
    w = workstation_by_key(key)
    return w["subscription"] if w else None
