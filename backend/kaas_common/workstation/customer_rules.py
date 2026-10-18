"""客户/询盘业务规则 —— 纯函数、零三方依赖（stdlib only）。

orchestrator 与 Worker 共用；任何适配层不得另写一份判定。

2026-10-18 口径变更（用户明确）
--------------------------------
**客户阶段与订单阶段是两层，不能混。**

* **客户阶段**只有三种：`active`（活跃）/ `inactive`（沉寂）/ `ordered`（已下单）。
  - `ordered` 是**推导值**：该客户名下存在「开启中的订单」时显示已下单；
  - `active` / `inactive` 是**手动状态**，存在 `customers.stage` 列里，
    由用户在客户页手动切换（沉寂 = 客户关系关闭状态）。
  - 不再有 lead / inquiry / quoted / won / lost ——
    那些是**订单/询盘（单据）阶段**，由 `orders.status` / `cust_inquiries.status`
    自己表达，不再往客户阶段上映射。
* **开启中的订单** = 状态属于 `OPEN_ORDER_STATUSES`
  （用户 2026-10-18 确认：pending / confirmed / producing / shipped；
  completed / cancelled 视为已关闭）。
* 不再按 30/90 天无活动自动改客户阶段（用户：「沉寂先手动切换」）。
"""
from typing import Any, Iterable, Optional

from .scope import is_admin_role

__all__ = [
    "OPEN_ORDER_STATUSES",
    "MANUAL_CUSTOMER_STAGES",
    "CUSTOMER_STAGES",
    "normalize_manual_stage",
    "is_manual_customer_stage",
    "validate_manual_stage",
    "has_open_order",
    "derive_customer_stage",
    "check_write_access",
    "can_see_all",
]

# 「开启中的订单」——决定客户是否显示为「已下单」。
# 用户 2026-10-18 明确：pending 也算（下单即算已下单），completed/cancelled 关闭。
OPEN_ORDER_STATUSES: tuple[str, ...] = (
    "pending",
    "confirmed",
    "producing",
    "shipped",
)

# 客户阶段可**手动**设置的值（`ordered` 是推导值，不允许手写）。
MANUAL_CUSTOMER_STAGES: tuple[str, ...] = ("active", "inactive")

# 客户阶段对外展示的全部取值（含推导值）。
CUSTOMER_STAGES: tuple[str, ...] = ("active", "inactive", "ordered")


def normalize_manual_stage(stage: Optional[str]) -> str:
    """把库里的客户阶段归一成手动值 active / inactive。

    为什么要归一：2026-10-18 之前库里存的是 lead / inquiry / quoted / won /
    lost / inactive 六个值。迁移会把存量改成 active / inactive，但**上线顺序
    可能反了**（代码先上、迁移后跑），且历史备份/其他分支的数据也可能还是旧值。
    所以读路径必须能容忍旧值：
      - `inactive` / `lost` → `inactive`（流失并入沉寂：用户口径「沉寂=关闭」）
      - 其余（lead / inquiry / quoted / won / 未知 / NULL）→ `active`
    """
    return "inactive" if stage in ("inactive", "lost") else "active"


def is_manual_customer_stage(stage: Optional[str]) -> bool:
    return stage in MANUAL_CUSTOMER_STAGES


def validate_manual_stage(target: Optional[str]) -> tuple[bool, str]:
    """校验**手动**客户阶段是否合法。返回 (合法, 错误信息)。

    `ordered` 故意不允许手动设置：它由「是否存在开启中的订单」推导，
    手动写会造成「客户阶段=已下单、但根本没有订单」这种自相矛盾的数据。
    """
    if target in MANUAL_CUSTOMER_STAGES:
        return True, ""
    if target == "ordered":
        return False, "「已下单」由开启中的订单自动推导，不能手动设置"
    return (
        False,
        f"客户阶段只能是 {list(MANUAL_CUSTOMER_STAGES)}（手动）或 ordered（订单推导）；"
        f"收到 {target!r}。询盘/报价/订单属于单据阶段，不是客户阶段",
    )


def has_open_order(order_statuses: Optional[Iterable[str]]) -> bool:
    """是否存在开启中的订单（`OPEN_ORDER_STATUSES` 里任一状态）。"""
    if not order_statuses:
        return False
    return any(status in OPEN_ORDER_STATUSES for status in order_statuses)


def derive_customer_stage(manual_stage: Optional[str],
                          has_open: bool) -> str:
    """客户阶段的**唯一**推导入口。

    有开启中的订单 ⇒ `ordered`；否则回落到手动状态 active / inactive。
    其它任何地方都不得再写一套判定。
    """
    if has_open:
        return "ordered"
    return normalize_manual_stage(manual_stage)


def check_write_access(row: Any, auth: Any) -> bool:
    """检查当前用户是否有写权限（owner_scope=tenant 或本人创建）。"""
    owner_scope = _get(row, "owner_scope") or "private"
    owner_id = _get(row, "owner_id") or _get(row, "created_by")
    if owner_scope == "tenant":
        return True
    auth_user_id = str(_get(auth, "user_id") or _get(auth, "id") or "")
    return str(owner_id) == auth_user_id


def can_see_all(auth: Any) -> bool:
    """是否可看全部（管理员）。

    **唯一真源** = `kaas_common.workstation.scope.is_admin_role`。

    本函数此前自成一派：认 `role in ("admin", "super_admin")` **或
    `account_type == "internal"`**。后者把「内部账号」等同于管理员 ——
    于是 `internal` + `role=user` 的账号（例如 QA 的 `qa_user`）能看**全部租户**数据。
    这同时违反两处已写明的期望：

      · `docs/QA_TEST_ACCOUNTS.md` 越权审计第 5 条：qa_user 列表**只见 qa_smoke**；
      · Worker 侧 `_can_see_all`（= `scope.is_admin_role`）只认 system_admin。

    三方不一致的后果是同一个账号在不同接口上可见范围不同。
    2026-10-11 收敛到 scope 一份：**管理员 = system_admin（含历史角色 admin），
    与 `account_type` 无关。**
    """
    return is_admin_role(_get(auth, "role"))


def _get(obj: Any, key: str):
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)
