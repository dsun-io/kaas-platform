"""产品域的「两把尺 + 三层可见性」—— **纯函数、零三方依赖**（orchestrator 与 worker 共用）。

为什么不复用 `workstation/scope.py` 的 `can_view`
=================================================

`can_view` 是**客户域**口径：它认 `owner_scope == "tenant"` 与 `owner_id == 我`。
产品行**没有 `owner_scope` 列**，且 `owner_id` 存的是**产品 key**（不是用户 id）
（分析文档 §1.4 已核实）⇒ 照抄会得到一个**语义错误的放行条件**。
所以产品域单独一个模块，而不是改客户域那把尺。

两把尺**并存**，用途不同（2026-10-11 用户裁决 Q5）
=================================================

===================  ==========================  ==========================================
尺                    定义                        谁用它
===================  ==========================  ==========================================
`is_team_admin`      团队**管理员**（团队创建者    团队档位（`/product-options/overrides`）、
（`workstation/teams.py`，已存在）  或平台管理员）                 团队 / 成员 / 订阅类
`is_same_team`       **团队成员**（同团队即可）     **产品 / 产品图**相关端点
（本模块，新立）
===================  ==========================  ==========================================

裁决明确"**不能复用 `is_team_admin`**"⇒ 这里**另立一把**，**不动那一把**。
仍然**必须管理员**的（不受本模块影响，由各自既有守卫负责）：
团队档位 `/product-options/overrides`（`is_team_admin`）、团队 / 成员 / 订阅类、
`is_system` 行（403）、`calculate-internal` / `verify`（`require_tenant_admin`）。

三层可见性（Q1 = **B 全私式**）
==============================

============================  ==========================================
对象                           谁能读
============================  ==========================================
产品**定义**（代码注册表）        **人人可读**（`definition_readable`）
产品**相关信息**（图片 /          **只有本团队**；⚠️ **系统级也不例外**
`product_profiles` / 图片行）
历史 `team_id IS NULL` 的行      **仅平台管理员**（Q1=B + D3/D4）
============================  ==========================================

⚠️ **Q6 的两层不要压平**（用户原话里的关键区分）
------------------------------------------------

- **工位可见性** = 「`/products` 工位**人人可见**」⇒ 属**契约层**
  （`shared/contracts/workstations.ts` 的 `adminOnly: false`），由 P15 落地，**不在本模块**。
- **数据可见性** = 「**用户创建的业务数据仅团队内部可见**」⇒ **就是本模块**。

本模块**刻意不提供**任何"工位可见性"函数或参数 —— 把两者合成一个判断，
正是那条裁决要避免的错误（合成之后，"人人可见"会被误当成"数据人人可见"）。

失败语义（沿用仓库既有口径，§1.5）
==================================

顺序固定：**401（未登录）→ 403 `NO_TEAM` → 404（不泄露存在性）→ 403**。
401 由鉴权层决定（`auth.py:227` 等），不归本模块；
`product_info_access()` 把「结论 + 原因 + 建议状态码」一起回出来，
避免每个端点在 13+ 个落点上各写一遍判断（分析文档 §1.4 的落点清单）。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from .scope import is_admin_role

__all__ = [
    "REASON_OK",
    "REASON_ADMIN",
    "REASON_NO_TEAM",
    "REASON_LEGACY_UNATTRIBUTED",
    "REASON_OTHER_TEAM",
    "ProductInfoAccess",
    "product_info_access",
    "can_view_product_info",
    "can_write_product_info",
    "is_same_team",
    "definition_readable",
]

# ── 判定原因（+ 建议状态码）──────────────────────────────────────────────────

REASON_OK = "ok"
REASON_ADMIN = "admin"
REASON_NO_TEAM = "no_team"
REASON_LEGACY_UNATTRIBUTED = "legacy_unattributed"
REASON_OTHER_TEAM = "other_team"

#: 原因 → 建议 HTTP 状态码（401 由鉴权层负责，不在本表）
_STATUS_BY_REASON = {
    REASON_OK: 200,
    REASON_ADMIN: 200,
    REASON_NO_TEAM: 403,                 # 403 NO_TEAM：有登录但没团队
    REASON_LEGACY_UNATTRIBUTED: 404,     # 历史 NULL 行：对非管理员**当不存在**
    REASON_OTHER_TEAM: 404,              # 别家团队：**不泄露存在性**
}


@dataclass(frozen=True)
class ProductInfoAccess:
    """一次可见性判定的完整结论：能不能看 / 为什么 / 该回什么状态码。

    `bool(decision)` 直接给"能不能"，调用方也可以读 `reason` 做更细的分支
    （例如把 `legacy_unattributed` 记一条审计，而不是悄悄 404）。
    """

    allowed: bool
    reason: str
    http_status: int

    def __bool__(self) -> bool:  # 便于 `if access:`
        return self.allowed


def _same_non_null(a: Any, b: Any) -> bool:
    """宽松相等：`team_id` 在库里可能是 BIGINT、在 token 里可能是 str。

    任一侧为空都**不算相同**（NULL 不是"某个团队"）。
    """
    if a is None or b is None:
        return False
    sa, sb = str(a), str(b)
    if sa == "" or sb == "":
        return False
    return sa == sb


# ── 判定 1：产品**相关信息**（图片 / 基础信息）的可见性 ────────────────────────

def product_info_access(
    *,
    role: Optional[str],
    viewer_team_id: Any,
    row_team_id: Any,
) -> ProductInfoAccess:
    """产品**相关信息**（产品图 / `product_profiles` 基础信息）对该访问者可见吗。

    **判定顺序**（与 §1.5 一致，三条分支的先后都有意义）：

    1. **平台管理员** ⇒ 允许（运维兜底，与 `scope.is_admin_role` 同一份角色映射）。
    2. **访问者没有团队** ⇒ 拒绝 `no_team` / **403** —— 比 404 更准确：
       不是"这条数据不可见"，而是"你没有团队，压根无法拥有团队数据"。
    3. **行的 `team_id` 为空**（历史无法归因的行）⇒ 拒绝 `legacy_unattributed` / **404**：
       裁决 Q1=B + D3/D4 定的是"**保留 NULL + 仅管理员可见**"
       —— ⚠️ 这与客户域 `scope.can_view` 的"NULL 维持旧可见性"**相反**，是本模块刻意分叉的地方。
    4. **团队不同** ⇒ 拒绝 `other_team` / **404**（**不泄露存在性**）。
    5. 否则允许。

    ⚠️ **没有 `is_system` 参数**，这是**故意的**：Q1=B 明确"系统级也不例外"，
    所以这里**不存在**任何"系统级产品放行所有人"的后门可走。
    """
    if is_admin_role(role):
        return ProductInfoAccess(True, REASON_ADMIN, _STATUS_BY_REASON[REASON_ADMIN])
    if viewer_team_id is None or str(viewer_team_id) == "":
        return ProductInfoAccess(False, REASON_NO_TEAM, _STATUS_BY_REASON[REASON_NO_TEAM])
    if row_team_id is None or str(row_team_id) == "":
        return ProductInfoAccess(
            False, REASON_LEGACY_UNATTRIBUTED, _STATUS_BY_REASON[REASON_LEGACY_UNATTRIBUTED])
    if not _same_non_null(row_team_id, viewer_team_id):
        return ProductInfoAccess(False, REASON_OTHER_TEAM, _STATUS_BY_REASON[REASON_OTHER_TEAM])
    return ProductInfoAccess(True, REASON_OK, _STATUS_BY_REASON[REASON_OK])


def can_view_product_info(
    *,
    role: Optional[str],
    viewer_team_id: Any,
    row_team_id: Any,
) -> bool:
    """`product_info_access(...)` 的布尔便捷版（读）。"""
    return product_info_access(
        role=role, viewer_team_id=viewer_team_id, row_team_id=row_team_id
    ).allowed


def can_write_product_info(
    *,
    role: Optional[str],
    viewer_team_id: Any,
    row_team_id: Any,
) -> bool:
    """写产品/产品图：**团队任意成员**（Q5）—— 即"**看得到就能改**"。

    ⚠️ 适用范围**只有**产品 / 产品图相关端点。以下**仍须管理员**，由各自的既有守卫负责，
    **不要**用本函数代替：团队档位 `/product-options/overrides`（`is_team_admin`）、
    团队 / 成员 / 订阅类、`is_system` 行（403）、`calculate-internal` / `verify`
    （`require_tenant_admin`）。

    写与读的判定**暂时相同**（裁决没要求写更严）；刻意留成**两个函数名**，
    以便将来某一侧单独收紧时不必改调用方语义。
    """
    return product_info_access(
        role=role, viewer_team_id=viewer_team_id, row_team_id=row_team_id
    ).allowed


# ── 判定 2：新立的「团队成员尺」（与 is_team_admin 并存）──────────────────────

def is_same_team(
    *,
    role: Optional[str],
    viewer_team_id: Any,
    row_team_id: Any,
) -> bool:
    """**团队成员尺**（Q5 新立的那把）—— 与 `is_team_admin`（团队管理员尺）**并存**。

    - 平台管理员恒 `True`（运维兜底，与 `teams.is_team_admin` 的平台管理员分支一致）；
    - 其余人：**双方 team 都非空且相同**才 `True`。

    ⚠️ 名字**不是** `can_write`（那个名字已被客户域的"属主尺"占用，
    见 `workstation/scope.py:can_write`）—— 两者语义不同：属主尺要求 `owner_id == 我`，
    本尺是"同团队即可"。**同团队可见 ≠ 同团队可改**是客户域的规则；
    产品是**团队资产**，所以产品域的写权就是同团队（Q5）。
    """
    if is_admin_role(role):
        return True
    return _same_non_null(row_team_id, viewer_team_id)


# ── 判定 3：产品**定义**人人可读（Q1=B）─────────────────────────────────────

def definition_readable(*, role: Optional[str] = None) -> bool:
    """产品**定义**（代码注册表里的 `ProductSpec`）**人人可读**（Q1=B）。

    定义在代码里、不按团队隔离 —— 所以这里**恒 `True`**。
    "未登录"由鉴权层拦（401），不归本函数管。

    ⚠️ 它**不**适用于产品**相关信息**（图片 / 基础信息）：那要走 `product_info_access`。
    把两者混用就等于把"定义人人可读"误当成"产品信息人人可读"。
    """
    return True
