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

from .models import ProductSpec, Axis, VariantGroup, FormulaSpec, Column, Invariant, SpaceDeduction


def spec_from_dict(data: dict) -> ProductSpec:
    """JSONB dict → ProductSpec（数据库加载用）。"""
    return ProductSpec(
        key=data["key"],
        name=data.get("name", ""),
        name_en=data.get("name_en", ""),
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


class TenantProductLoader:
    """租户级产品加载器：先查数据库，再回退 Python 定义。

    团队谓词（2026-10-12，task-4）：`load()` 现在接收 `team_id`（可为 None），
    由 `_fetch_tenant_product` 按团队收敛候选行（本团队优先，历史 NULL 仅管理员）。
    注意：**权限矩阵（is_system / 工位开通）仍未完成**（is_system/is_active
    只做基础过滤），详见 docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md。
    """

    def __init__(self, db_session_factory=None):
        self._db = db_session_factory
        self._cache: dict[str, ProductSpec] = {}

    async def load(self, tenant_id: str, product_key: str,
                   team_id: Any = None, *, role: Optional[str] = None,
                   db_session: Optional[Any] = None) -> Optional[ProductSpec]:
        """加载产品定义：租户级（按团队收敛）优先，回退系统级 Python 定义。

        参数：
        - `tenant_id`：租户（目前恒为 `"default"`，隔离边界是 team）。
        - `product_key`：产品 key。
        - `team_id`：调用者归属的团队（`None`/空 = 未归属团队）。
        - `role`：调用者角色，**仅**用于判定「历史 `team_id IS NULL` 行是否可见」
          （仅平台管理员可见，D3/D4）；不传时按非管理员处理（历史 NULL 行跳过）。
        - `db_session`：**已注入的 SQLAlchemy `AsyncSession`**（可选）。
          与 `db_session_factory` 二选一 —— 有 `db_session` 时直接用它（不开新连接），
          否则回退到 `db_session_factory()`。`_effective_product`（P13 接线）用的是
          FastAPI 注入的 session，不再另起会话。

        P13 接线（`_effective_product`）已把 `auth.team_id` / `auth.role` / `db`
        传进来。
        """
        cache_key = f"{tenant_id}:{team_id}:{role}:{product_key}"
        if cache_key in self._cache:
            return self._cache[cache_key]

        # 1. 查 tenant_products 表（团队收敛后的那一行）
        if db_session is not None or self._db is not None:
            row = await self._fetch_tenant_product(
                tenant_id, product_key, team_id, role=role, db_session=db_session)
            if row is not None:
                # P13：基线 + 差异 → 有效 ProductSpec（差异带 base_spec_hash 且
                # 与基线不一致时抛 SpecUpstreamChanged，绝不静默套用）
                from .effective_spec import resolve_effective_product
                spec, _warnings = resolve_effective_product(
                    row["spec"], row.get("override"))
                if spec is not None:
                    self._cache[cache_key] = spec
                    return spec

        # 2. 回退 Python 定义（系统级兜底）
        from .products import get as get_product, has as has_product
        if has_product(product_key):
            spec = get_product(product_key)
            self._cache[cache_key] = spec
            return spec

        return None

    async def _fetch_tenant_product(self, tenant_id: str, product_key: str,
                                    team_id: Any = None, *, role: Optional[str] = None,
                                    db_session: Optional[Any] = None):
        """按团队谓词取 tenant_products 的一行（本团队优先，历史 NULL 仅管理员）。

        返回 `None` = 没有可见的行（调用方回退 Python 定义）。
        **不再**用 `scalar_one_or_none()` —— 同租户同 key 的多团队行是**合法**的
        （迁移 202610110019 放宽了唯一键），`scalar_one_or_none` 会抛
        `MultipleResultsFound`。这里按可见性排序后取第一行：
        本团队行（`team_id == viewer`）> 历史 NULL 行（仅管理员）。

        `db_session`：已注入的 `AsyncSession`（不新开连接）；为 None 时回退
        `self._db()` 会话工厂。
        """
        from sqlalchemy import select
        from app.db.models import TenantProduct  # noqa: F401 - 延迟导入避免循环
        from kaas_common.workstation.product_scope import is_same_team

        if db_session is not None:
            result = await db_session.execute(
                select(TenantProduct).where(
                    TenantProduct.tenant_id == tenant_id,
                    TenantProduct.product_key == product_key,
                    TenantProduct.is_active == True,  # noqa: E712
                )
            )
            rows = result.scalars().all()
        else:
            async with self._db() as session:
                result = await session.execute(
                    select(TenantProduct).where(
                        TenantProduct.tenant_id == tenant_id,
                        TenantProduct.product_key == product_key,
                        TenantProduct.is_active == True,  # noqa: E712
                    )
                )
                rows = result.scalars().all()
        # 优先级：本团队行（`team_id == viewer`）> 历史 NULL 行（仅管理员）。
        # 多行时按这个优先级取**第一行**，而不是"按返回顺序随便取一条"。
        from kaas_common.workstation.scope import is_admin_role

        for row in rows:
            row_team = getattr(row, "team_id", None)
            if row_team is not None and is_same_team(
                role=role, viewer_team_id=team_id, row_team_id=row_team
            ):
                return {"spec": row.spec, "team_id": row_team,
                        "override": getattr(row, "override", None)}
        # 没有本团队行 ⇒ 只剩历史 NULL 行兜底（仅管理员可见，D3/D4）
        if is_admin_role(role):
            for row in rows:
                if getattr(row, "team_id", None) is None:
                    return {"spec": row.spec, "team_id": None,
                            "override": getattr(row, "override", None)}
        return None

    def list_keys(self, tenant_id: str) -> list[str]:
        """列出该租户可用的产品 key（含系统级兜底）。

        ⚠️ 无调用方的遗留方法（2026-10-17 核实）；发现层合并请用
        `list_available`（含团队可见性谓词）。此方法只返回 Python 注册表、
        看不到 tenant 新增的产品，且历史上相对导入就写错过 —— 留存仅兼容，
        新代码勿用。
        """
        from .products import keys as product_keys
        return product_keys()

    async def list_available(
        self, tenant_id: str, team_id: Any = None, *,
        role: Optional[str] = None, db_session: Optional[Any] = None,
    ) -> list[ProductSpec]:
        """列出调用者**可见**的全部产品定义（tenant 级优先，Python 兜底，按 key 去重）。

        发现层合并（2026-10-17，缺口 1）：`tenant_products` 里运行时新增的产品
        此前只存在于数据库 —— 算价接口按 key 能加载（`_effective_product`），
        但产品下拉/媒体列表只迭代 Python 注册表，新建的产品**看不见、不可选**。
        本方法把「租户可见的 tenant 行」与「Python 注册表」并成一个按 key 去重的
        列表：同 key 时 本团队 tenant 行 > 历史 NULL 行（仅管理员）> Python 定义。

        可见性谓词与 `load()`/`_fetch_tenant_product` 完全同口径（复用
        `is_same_team` / `is_admin_role`，不另写一套）。
        """
        from .products import keys as product_keys, get as get_product

        specs: dict[str, ProductSpec] = {}
        # Python 注册表先全量放入（tenant 行随后按 key 覆盖）
        for key in product_keys():
            specs[key] = get_product(key)

        rows = await self._fetch_visible_tenant_rows(
            tenant_id, team_id, role=role, db_session=db_session)
        from .effective_spec import resolve_effective_product
        for row in rows:
            spec, _warnings = resolve_effective_product(
                row["spec"], row.get("override"))
            if spec is not None:
                specs[spec.key] = spec
        return list(specs.values())

    async def _fetch_visible_tenant_rows(self, tenant_id: str, team_id: Any = None, *,
                                         role: Optional[str] = None,
                                         db_session: Optional[Any] = None) -> list:
        """tenant_products 中调用者可见的行（每个 key 取优先级最高的一行）。

        每 key 优先级：本团队行 > 历史 NULL 行（仅管理员）。谓词与
        `_fetch_tenant_product` 相同，只是从「取单个 key」扩成「取全部 key」。
        """
        from sqlalchemy import select
        from app.db.models import TenantProduct  # noqa: F401 - 延迟导入避免循环
        from kaas_common.workstation.product_scope import is_same_team
        from kaas_common.workstation.scope import is_admin_role

        if db_session is None and self._db is None:
            return []
        if db_session is not None:
            result = await db_session.execute(
                select(TenantProduct).where(
                    TenantProduct.tenant_id == tenant_id,
                    TenantProduct.is_active == True,  # noqa: E712
                )
            )
            rows = result.scalars().all()
        else:
            async with self._db() as session:
                result = await session.execute(
                    select(TenantProduct).where(
                        TenantProduct.tenant_id == tenant_id,
                        TenantProduct.is_active == True,  # noqa: E712
                    )
                )
                rows = result.scalars().all()

        best: dict[str, dict] = {}
        for row in rows:
            key = row.product_key
            row_team = getattr(row, "team_id", None)
            if row_team is not None and is_same_team(
                role=role, viewer_team_id=team_id, row_team_id=row_team
            ):
                # 本团队行：最高优先级，直接覆盖
                best[key] = {"spec": row.spec, "team_id": row_team,
                             "override": getattr(row, "override", None)}
            elif row_team is None and is_admin_role(role):
                # 历史 NULL 行：仅管理员，且已有本团队行时不覆盖
                best.setdefault(key, {"spec": row.spec, "team_id": None,
                                      "override": getattr(row, "override", None)})
        return list(best.values())
