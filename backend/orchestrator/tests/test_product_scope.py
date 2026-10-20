"""`kaas_common/workstation/product_scope.py` 的单测（**纯逻辑、无 DB、无 skip**）。

对应 `docs/archive/2026-10-20-closeout/PRODUCT_MODULE_IMPL_PLAN.md` 的 **P11**，口径以 **§8.1 裁决后的版本**为准：

- **Q1 = B 全私式**：定义人人可读；产品**相关信息**（图片/基础信息）**一律团队私有**，
  **系统级也不例外**；历史 `team_id IS NULL` 的行 **仅管理员可见**；
- **Q5 = 团队任意成员**：另立 `is_same_team` 一把尺，与 `is_team_admin` **并存**；
- **Q6 = 两层不许压平**：本模块**只**管"数据可见性"，**不**管"工位可见性"。

最后两条用**结构断言**钉住（签名里不许出现 `is_system` / 工位参数），
避免以后有人"顺手加个后门"而测试还是绿的。
"""
from __future__ import annotations

import inspect

import pytest

from kaas_common.workstation import product_scope
from kaas_common.workstation.product_scope import (
    REASON_ADMIN,
    REASON_LEGACY_UNATTRIBUTED,
    REASON_NO_TEAM,
    REASON_OK,
    REASON_OTHER_TEAM,
    can_view_product_info,
    can_write_product_info,
    definition_readable,
    is_same_team,
    product_info_access,
)
from kaas_common.workstation.scope import can_view

# 纯逻辑、无外部服务 ⇒ 必须进 `-m unit` 门禁
# ⚠️ 上一轮我漏了这行 ⇒ 42 条被 `-m unit` **静默 deselected**（等于没测）
pytestmark = pytest.mark.unit


ADMIN = "system_admin"
LEGACY_ADMIN = "admin"          # 历史角色，映射后同样是管理员
MEMBER = "customer_member"
OWNER = "customer_owner"        # 团队负责人：在本尺下与普通成员**同权**（Q5）


# ── 1. 产品相关信息：三层可见性 ──────────────────────────────────────────────

class TestProductInfoVisibility:
    def test_本团队成员可见(self):
        d = product_info_access(role=MEMBER, viewer_team_id=7, row_team_id=7)
        assert d.allowed is True
        assert d.reason == REASON_OK
        assert d.http_status == 200
        assert bool(d) is True

    def test_别家团队不可见_且是404不泄露存在性(self):
        d = product_info_access(role=MEMBER, viewer_team_id=7, row_team_id=9)
        assert d.allowed is False
        assert d.reason == REASON_OTHER_TEAM
        assert d.http_status == 404

    def test_历史NULL行_对普通成员不可见(self):
        """Q1=B + D3/D4：保留 NULL，但**仅管理员可见**。"""
        d = product_info_access(role=MEMBER, viewer_team_id=7, row_team_id=None)
        assert d.allowed is False
        assert d.reason == REASON_LEGACY_UNATTRIBUTED
        assert d.http_status == 404

    def test_历史NULL行_对管理员可见(self):
        d = product_info_access(role=ADMIN, viewer_team_id=None, row_team_id=None)
        assert d.allowed is True
        assert d.reason == REASON_ADMIN

    def test_平台管理员可见别家团队的行(self):
        d = product_info_access(role=ADMIN, viewer_team_id=7, row_team_id=9)
        assert d.allowed is True
        assert d.reason == REASON_ADMIN

    def test_历史角色admin按管理员处理(self):
        d = product_info_access(role=LEGACY_ADMIN, viewer_team_id=1, row_team_id=2)
        assert d.allowed is True

    def test_访问者没有团队_403_NO_TEAM_且优先于404(self):
        # 顺序：401 → 403 NO_TEAM → 404 → 403（§1.5）。没有团队时先给 403，
        # 而不是把"别家团队"的 404 混进来。
        for row_team in (None, 9):
            d = product_info_access(role=MEMBER, viewer_team_id=None, row_team_id=row_team)
            assert d.allowed is False
            assert d.reason == REASON_NO_TEAM, row_team
            assert d.http_status == 403, row_team
        # 空串等同于"没有团队"
        assert product_info_access(
            role=MEMBER, viewer_team_id="", row_team_id=7).reason == REASON_NO_TEAM

    def test_team_id类型宽松_字符串与整数视为同一团队(self):
        # 库里 BIGINT、token 里 str 是常态（scope._same 也是这个口径）
        assert product_info_access(
            role=MEMBER, viewer_team_id="7", row_team_id=7).allowed is True
        assert product_info_access(
            role=MEMBER, viewer_team_id=7, row_team_id="7").allowed is True

    def test_系统级产品不是例外_签名里没有is_system后门(self):
        """Q1=B 明确"系统级也不例外" ⇒ 判定函数里**不该存在** is_system 开关。

        结构断言（而不是只测几个值）：只要有人日后加一个"系统级放行"的参数，
        本条立刻红。
        """
        params = set(inspect.signature(product_info_access).parameters)
        assert not {p for p in params if "system" in p.lower()}, params
        # 系统级产品的信息行同样按团队判：别家团队照样看不到
        d = product_info_access(role=MEMBER, viewer_team_id=7, row_team_id=9)
        assert d.allowed is False and d.http_status == 404

    def test_与客户域can_view刻意分叉_NULL行的语义相反(self):
        """产品域**故意**不复用 `scope.can_view`：

        `can_view` 对 `team_id IS NULL` 的行**不因团队规则改变可见性**（可能放行）；
        产品域裁决是"历史 NULL **仅管理员**可见"。
        本用例把这个分叉钉死 —— 谁把产品域改回 `can_view` 就会红。
        """
        # 客户域：owner_id == 我 的 NULL-team 行 ⇒ 可见
        assert can_view(role=MEMBER, owner_id="5", viewer_id="5",
                        team_id=None, viewer_team_id=7) is True
        # 产品域：同样的"空 team_id" ⇒ 不可见（仅管理员）
        assert can_view_product_info(
            role=MEMBER, viewer_team_id=7, row_team_id=None) is False


# ── 2. 写权：团队任意成员（Q5）──────────────────────────────────────────────

class TestWriteIsAnyTeamMember:
    def test_写等于读_团队成员可写(self):
        for role in (MEMBER, OWNER):
            assert can_write_product_info(
                role=role, viewer_team_id=7, row_team_id=7) is True

    def test_团队负责人不因角色更宽_与普通成员同权(self):
        # Q5 是"团队任意成员"；不是"团队管理员"。负责人没有额外写权，
        # 普通成员也没有被降级 —— 两者在本尺下相同。
        for row_team in (7, 9, None):
            assert (can_write_product_info(role=OWNER, viewer_team_id=7, row_team_id=row_team)
                    == can_write_product_info(role=MEMBER, viewer_team_id=7, row_team_id=row_team))

    def test_别家团队写不了(self):
        assert can_write_product_info(
            role=MEMBER, viewer_team_id=7, row_team_id=9) is False

    def test_没有团队写不了(self):
        assert can_write_product_info(
            role=MEMBER, viewer_team_id=None, row_team_id=7) is False

    def test_管理员可写(self):
        assert can_write_product_info(
            role=ADMIN, viewer_team_id=None, row_team_id=9) is True

    def test_读写判定一致_且各自有函数名(self):
        # 写与读**暂时**同判定；刻意保留两个名字，便于将来单侧收紧
        cases = [
            dict(role=MEMBER, viewer_team_id=7, row_team_id=7),
            dict(role=MEMBER, viewer_team_id=7, row_team_id=9),
            dict(role=MEMBER, viewer_team_id=None, row_team_id=7),
            dict(role=ADMIN, viewer_team_id=None, row_team_id=None),
        ]
        for kw in cases:
            assert can_write_product_info(**kw) == can_view_product_info(**kw), kw


# ── 3. 新尺 is_same_team：与 is_team_admin 并存，不互相替代 ─────────────────

class TestIsSameTeamRuler:
    def test_同团队为真_异团队为假(self):
        assert is_same_team(role=MEMBER, viewer_team_id=7, row_team_id=7) is True
        assert is_same_team(role=MEMBER, viewer_team_id=7, row_team_id=9) is False

    def test_任一侧为空都为假(self):
        assert is_same_team(role=MEMBER, viewer_team_id=None, row_team_id=7) is False
        assert is_same_team(role=MEMBER, viewer_team_id=7, row_team_id=None) is False
        assert is_same_team(role=MEMBER, viewer_team_id="", row_team_id="") is False

    def test_平台管理员恒真(self):
        for role in (ADMIN, LEGACY_ADMIN):
            assert is_same_team(role=role, viewer_team_id=None, row_team_id=9) is True

    def test_类型宽松(self):
        assert is_same_team(role=MEMBER, viewer_team_id="7", row_team_id=7) is True

    def test_与is_team_admin并存_是两把不同的尺(self):
        """Q5：**不能**复用 `is_team_admin` ⇒ 两把尺都能 import，且语义不同。

        `is_team_admin` 要"团队创建者"；`is_same_team` 只要求"同团队"。
        对同一个"非创建者的普通成员"，两者的答案**必须不同** ——
        否则说明有人把新尺实现成了旧尺。
        """
        from kaas_common.workstation.teams import is_team_admin

        team_created_by = 100      # 团队创建者
        plain_member = 200         # 普通成员
        # 旧尺（团队管理员）：成员不是创建者 ⇒ False
        assert is_team_admin(team_created_by, plain_member, role=MEMBER) is False
        # 新尺（团队成员）：同一个成员、同一个团队 ⇒ True
        assert is_same_team(
            role=MEMBER, viewer_team_id=7, row_team_id=7) is True
        # 两把尺都仍可用（并存），没有被互相替换
        assert callable(is_team_admin) and callable(is_same_team)


# ── 4. 产品定义人人可读（Q1=B），但**不等于**相关信息人人可读 ────────────────

class TestDefinitionReadable:
    def test_定义人人可读(self):
        for role in (None, MEMBER, OWNER, ADMIN):
            assert definition_readable(role=role) is True

    def test_定义可读不等于信息可读_这一点必须分开(self):
        """Q1=B 的第一句与第二句是**两件事**：定义人人可读 ≠ 产品信息人人可读。"""
        assert definition_readable(role=MEMBER) is True
        # 同一个成员，对别家团队的产品图片/基础信息：读不了
        assert can_view_product_info(
            role=MEMBER, viewer_team_id=7, row_team_id=9) is False


# ── 5. Q6：两层不许压平（结构断言）────────────────────────────────────────

class TestQ6TwoLayersNotConflated:
    def test_本模块不提供工位可见性判定(self):
        """「工位可见性」（人人可见）属**契约层**，不由本模块回答。

        若有人把两者合成一个函数，本条会红 —— 那正是 Q6 要避免的错误。
        """
        for name in ("workstation_visible", "can_view_workstation",
                     "workstation_visible_to_all", "can_see_products_page"):
            assert not hasattr(product_scope, name), name

    def test_判定签名里没有工位参数(self):
        for fn in (product_info_access, is_same_team):
            params = set(inspect.signature(fn).parameters)
            for banned in ("workstation", "route", "path", "page"):
                assert banned not in params, (fn.__name__, banned)

    def test_数据可见性只由团队决定_与工位无关(self):
        # 同一个访问者：工位可见性恒为真（契约层），数据可见性仍按团队裁决
        assert product_info_access(
            role=MEMBER, viewer_team_id=7, row_team_id=7).allowed is True
        assert product_info_access(
            role=MEMBER, viewer_team_id=7, row_team_id=9).allowed is False


# ── 6. 原因与状态码表（§1.5 的映射）────────────────────────────────────────

class TestReasonAndStatusMapping:
    def test_四种原因与状态码一一对应(self):
        assert REASON_OK != REASON_ADMIN != REASON_NO_TEAM
        assert product_info_access(role=ADMIN, viewer_team_id=1, row_team_id=2).reason == REASON_ADMIN
        assert product_info_access(role=MEMBER, viewer_team_id=1, row_team_id=1).reason == REASON_OK
        assert product_info_access(role=MEMBER, viewer_team_id=None, row_team_id=1).reason == REASON_NO_TEAM
        assert product_info_access(
            role=MEMBER, viewer_team_id=1, row_team_id=None).reason == REASON_LEGACY_UNATTRIBUTED
        assert product_info_access(role=MEMBER, viewer_team_id=1, row_team_id=2).reason == REASON_OTHER_TEAM

    def test_允许的原因没有404(self):
        for kw in (dict(role=ADMIN, viewer_team_id=1, row_team_id=2),
                   dict(role=MEMBER, viewer_team_id=1, row_team_id=1)):
            d = product_info_access(**kw)
            assert d.allowed is True and d.http_status == 200

    def test_拒绝的原因都是403或404(self):
        for kw in (dict(role=MEMBER, viewer_team_id=None, row_team_id=1),
                   dict(role=MEMBER, viewer_team_id=1, row_team_id=None),
                   dict(role=MEMBER, viewer_team_id=1, row_team_id=2)):
            d = product_info_access(**kw)
            assert d.allowed is False and d.http_status in (403, 404)

    def test_判定是纯函数_同样输入永远同样输出(self):
        d1 = product_info_access(role=MEMBER, viewer_team_id=7, row_team_id=9)
        d2 = product_info_access(role=MEMBER, viewer_team_id=7, row_team_id=9)
        assert d1 == d2
