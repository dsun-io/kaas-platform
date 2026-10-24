"""租户级产品定义 —— 运行时从数据库加载 ProductSpec（租户级优先，系统级兜底）。

加载优先级：
1. tenant_products 表（租户级，按 tenant_id + team_id + is_active 过滤）
2. products/ 目录的 Python 定义（系统级兜底）

团队谓词（2026-10-12，task-4 / 迁移 `202610110019`）
===================================================

`tenant_products` 自迁移 `202610110019` 起有可空 `team_id` 列，唯一键收敛为
`(tenant_id, COALESCE(team_id, 0), product_key)` ⇒ 同一租户同一 key **可有多行**
（不同团队各一行 + 至多一行历史 NULL）。原查询用 `scalar_one_or_none()` 且**不**
按 team 过滤 ⇒ 多行时直接抛 `MultipleResultsFound`。

加载口径（与 `kaas_common/workstation/product_scope.py` 的 `is_same_team` 同源）：

| 情形 | 期望 | 依据 |
|---|---|---|
| 本团队行（`team_id == viewer_team_id`） | 优先返回 | Q1=B / Q6 |
| 别团队行 | **不返回**（回退到历史 NULL 行或 Python 定义） | Q6 + §1.5（不泄露存在性） |
| 历史 `team_id IS NULL` | **仅管理员可见**（非管理员跳过） | D3/D4 |

判定**复用** `kaas_common.workstation.product_scope.is_same_team` —— 本文件是
**数据加载器**（不是 HTTP 端点），所以不走 `product_info_access` 的 HTTP 语义
（403/404），而是走它的团队成员判定 `is_same_team`；两者共享同一份
`is_admin_role` 角色映射与 `_same_non_null` 松弛相等。**不另写一套判断**。

⚠️ 权限矩阵（`is_system` / 工位开通多对多关系）仍**未完成**（与本改动无关），
详见 docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md。
"""
from __future__ import annotations

from typing import Any, Optional

from .models import (
    ProductSpec, Axis, VariantGroup, FormulaSpec, Column, Invariant,
    SpaceDeduction, NumericInput, PieceInput,
)


def spec_from_dict(data: dict) -> ProductSpec:
    """JSONB dict → ProductSpec（数据库加载用）。"""
    return ProductSpec(
        key=data["key"],
        name=data.get("name", ""),
        name_en=data.get("name_en", ""),
        # 缺键 = 旧数据（没有多英文名概念）⇒ 空表；不能因为多了这个可选键就拒载
        name_en_aliases=list(data.get("name_en_aliases") or []),
        category_code=data.get("category_code", ""),
        cost_field=data.get("cost_field", "raw_price"),
        cost_basis=data.get("cost_basis", "pretax"),
        cost_unit=data.get("cost_unit", ""),
        constants=data.get("constants") or {},
        axes=[Axis(**a) for a in data.get("axes") or []],
        variants=[VariantGroup(**v) for v in data.get("variants") or []],
        derived=[FormulaSpec(**f) for f in data.get("derived") or []],
        space_deduction=SpaceDeduction(**data["space_deduction"]) if data.get("space_deduction") else SpaceDeduction(),
        piece_metrics=[FormulaSpec(**f) for f in data.get("piece_metrics") or []],
        order_metrics=[FormulaSpec(**f) for f in data.get("order_metrics") or []],
        columns=[Column(**c) for c in data.get("columns") or []],
        invariants=[Invariant(**i) for i in data.get("invariants") or []],
        # 2026-10-18：此前漏掉这三类 —— 租户产品（尤其"复制系统定义"来的）
        # 会丢掉自由数值参数（网高/丝径…）、按件改写参数与展示参数，
        # 表现为「派生公式求值失败：未定义变量 height_m」。
        numeric_inputs=[NumericInput(**n) for n in data.get("numeric_inputs") or []],
        piece_inputs=[PieceInput(**p) for p in data.get("piece_inputs") or []],
        params=data.get("params") or [],
        pricing_key=data.get("pricing_key") or [],
        notes=data.get("notes") or [],
        hs_codes=data.get("hs_codes") or [],
        profit_mode=data.get("profit_mode", "margin_on_price"),
        profit_value=data.get("profit_value", 0.06),
        misc_fee_rate=data.get("misc_fee_rate", 0.03),
        packaging=data.get("packaging") or [],
    )


def spec_to_dict(spec: ProductSpec) -> dict:
    """ProductSpec → JSONB dict（数据库存储用）。"""
    from dataclasses import asdict
    return asdict(spec)



# 2026-10-19 S4：TenantProductLoader（ORM + sqlalchemy 延迟导入）已删除：
# 它在 orchestrator 侧就无调用者，且违反「kaas_common 纯标准库」运行时约束；
# worker 用裸 asyncpg 自行查 tenant_products 后调 spec_from_dict/spec_to_dict。
