"""P9 的**跨文件一致性**守卫：唯一索引的键 ↔ 三处 `ON CONFLICT` 的目标。

为什么需要这条用例（它挡的是本项目最贵的一类错）
================================================

`INSERT ... ON CONFLICT (…)` 的目标必须能被某个**唯一索引**"推断"出来
（PG16 文法：`conflict_target := ( { index_column_name | ( index_expression ) } [, …] )`）。
只要库里的索引与代码里的冲突目标**差一个字**，运行时就是
`there is no unique or exclusion constraint matching the ON CONFLICT specification` ——
**保存产品基础信息 / 启用产品直接 500**，而且**单元测试全绿也发现不了**
（两端测试都用假连接，不碰真 SQL 语义）。

P9 把唯一键按团队收敛（`COALESCE(team_id, 0)`）时，正好把"库"和"两端代码"分在 4 个文件里：

| 唯一索引（迁移 019 渲染出的 DDL） | 冲突目标（代码字面量） |
|---|---|
| `uq_product_profiles_scope (tenant_id, COALESCE(team_id,0), product_key)` | `app/api/files.py`、`backend/worker/src/ws_files.py` |
| `uq_tenant_ws_product (tenant_id, COALESCE(team_id,0), workstation, product_key)` | `backend/worker/src/ws_products.py` |

本用例**离线**把两边读出来逐元素比对，并断言**旧形态已彻底消失** ——
既挡"改了一半"，也挡"两端各改各的"。

⚠️ 它不替代真库验证：这是**结构性**证明（形状一致）。**行为**证明（真能插两行）
需要 Postgres ⇒ 属 §1.4 的 L2 通路（CI `db-tests`）。
"""
from __future__ import annotations

import ast
import io
import os
import re
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config

pytestmark = pytest.mark.unit

_ROOT = Path(__file__).resolve().parents[3]          # 仓库根
_ORCH = _ROOT / "backend" / "orchestrator"
_DUMMY_URL = "postgresql+asyncpg://kaas:kaas_dev@localhost:5432/kaas_v2_test"

#: 参与一致性的两端文件（**都在本任务写入范围内或只读引用**）
_SRC_FILES = {
    "files.py": _ORCH / "app" / "api" / "files.py",
    "ws_files.py": _ROOT / "backend" / "worker" / "src" / "ws_files.py",
    "ws_products.py": _ROOT / "backend" / "worker" / "src" / "ws_products.py",
}


# ── 工具 ────────────────────────────────────────────────────────────────────

def _offline_ddl() -> str:
    """把 019 的 DDL 离线渲染出来（不连库）。"""
    cfg = Config(str(_ORCH / "alembic.ini"))
    cfg.set_main_option("script_location", str(_ORCH / "alembic"))
    cfg.set_main_option("sqlalchemy.url", _DUMMY_URL)
    buf = io.StringIO()
    cfg.output_buffer = buf
    old = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = _DUMMY_URL
    try:
        command.upgrade(cfg, "202610110018:202610110019", sql=True)
    finally:
        if old is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = old
    return buf.getvalue()


def _sql_literals(path: Path) -> list[str]:
    """取源码里的**字符串常量值**（空白归一）。

    ⚠️ 必须走 AST 而不是"对原始源码做正则"：仓库里的 SQL 普遍写成
    **相邻字符串字面量隐式拼接**（`"INSERT INTO x"` 换行 `" (a, b)"`），
    原始文本里夹着引号与换行 ⇒ 任何"拿整串去 in 一下"的写法都会**假阴性**。
    `ast.parse` 会把隐式拼接**合并成一个 Constant**，正好是我们要的形态。
    （本文件第一版就踩了这个坑：工位那条 upsert 的两处断言全红。）
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            out.append(" ".join(node.value.split()))
    return out


def _index_keys(ddl: str, index_name: str) -> list[str]:
    """从 DDL 里取出某个唯一索引的键列表（按顶层逗号切分，去空白）。"""
    m = re.search(
        rf"CREATE UNIQUE INDEX {re.escape(index_name)} ON \w+ \((.*?)\);",
        ddl, re.S)
    assert m, f"DDL 里找不到唯一索引 {index_name}"
    return _split_top_level(m.group(1))


def _conflict_targets(path: Path) -> list[str]:
    """取出源码里所有 `ON CONFLICT ( … ) DO …` 的目标（可含嵌套括号）。"""
    out = []
    for lit in _sql_literals(path):
        out.extend(re.findall(r"ON CONFLICT \((.*?)\)\s*DO (?:UPDATE|NOTHING)", lit))
    return out


def _split_top_level(text: str) -> list[str]:
    """按**顶层**逗号切分；每个元素去掉最外层多余括号并归一空白。"""
    parts, depth, cur = [], 0, ""
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)

    out = []
    for raw in parts:
        el = " ".join(raw.split()).strip()
        # 冲突目标里表达式**必须**写成 (expr)（PG 文法要求）；索引里是裸 expr
        # ⇒ 比对时把最外层括号剥掉，让两种写法可比。
        while el.startswith("(") and el.endswith(")") and _balanced(el[1:-1]):
            el = el[1:-1].strip()
        out.append(" ".join(el.split()))
    return [e for e in out if e]


def _balanced(inner: str) -> bool:
    depth = 0
    for ch in inner:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth < 0:
                return False
    return depth == 0


# ── 1. 库侧索引形状（P9 收敛后的形态）──────────────────────────────────────

class TestIndexShape:
    def test_product_profiles唯一索引按团队收敛(self):
        keys = _index_keys(_offline_ddl(), "uq_product_profiles_scope")
        assert keys == ["tenant_id", "COALESCE(team_id, 0)", "product_key"], keys

    def test_tenant_ws_product唯一索引按团队收敛(self):
        keys = _index_keys(_offline_ddl(), "uq_tenant_ws_product")
        assert keys == ["tenant_id", "COALESCE(team_id, 0)", "workstation", "product_key"], keys

    def test_product_profiles主键已被替换掉(self):
        ddl = " ".join(_offline_ddl().split())
        assert "DROP CONSTRAINT product_profiles_pkey" in ddl, "旧主键必须去掉（否则两团队同 key 建不出来）"
        assert "PRIMARY KEY" not in ddl.upper() or "product_profiles_pkey" not in ddl


# ── 2. 代码侧的冲突目标与索引**逐元素一致**（核心）──────────────────────────

class TestConflictTargetsMatchIndexes:
    def test_两处put_profile的冲突目标等于product_profiles索引(self):
        want = _index_keys(_offline_ddl(), "uq_product_profiles_scope")
        for name in ("files.py", "ws_files.py"):
            targets = _conflict_targets(_SRC_FILES[name])
            assert targets, f"{name} 里没有 ON CONFLICT"
            got = _split_top_level(targets[0])
            assert got == want, f"{name} 的冲突目标 {got} 与索引 {want} 不一致"

    def test_set_workstation_product的冲突目标等于uq_tenant_ws_product索引(self):
        want = _index_keys(_offline_ddl(), "uq_tenant_ws_product")
        targets = _conflict_targets(_SRC_FILES["ws_products.py"])
        assert targets, "ws_products.py 里没有 ON CONFLICT"
        got = _split_top_level(targets[0])
        assert got == want, f"ws_products.py 的冲突目标 {got} 与索引 {want} 不一致"

    def test_表达式必须带括号_PG文法要求(self):
        """`index_expression` 在冲突目标里要写成 `( expr )`（PG16 INSERT 文法）。

        少了括号 ⇒ 推断失败 ⇒ 运行时报
        `there is no unique or exclusion constraint matching the ON CONFLICT specification`。
        这里直接检查**代码字面量**里 `COALESCE` 被一层括号包着。
        """
        for name, path in _SRC_FILES.items():
            for target in _conflict_targets(path):
                if "COALESCE" in target:
                    assert "(COALESCE(team_id, 0))" in target, (name, target)


# ── 3. 挡住"改了一半"与"两端各改各的" ──────────────────────────────────────

class TestOldFormsAreGone:
    def test旧冲突目标字面量已彻底消失(self):
        banned = [
            "ON CONFLICT (tenant_id, product_key)",
            "ON CONFLICT (tenant_id, workstation, product_key)",
        ]
        for name, path in _SRC_FILES.items():
            for lit in _sql_literals(path):
                for bad in banned:
                    assert bad not in lit, f"{name} 里还留着旧冲突目标：{bad}"

    def test两条put_profile的INSERT都写入了team_id(self):
        """唯一键按团队收敛后，**写入不带 team 等于没收窄**（全落进 team_key=0 桶）。"""
        for name in ("files.py", "ws_files.py"):
            lits = _sql_literals(_SRC_FILES[name])
            assert any(
                lit.startswith("INSERT INTO product_profiles (tenant_id, team_id, product_key")
                for lit in lits), f"{name} 的 INSERT 没写 team_id"

    def test工位upsert的INSERT也写入了team_id(self):
        lits = _sql_literals(_SRC_FILES["ws_products.py"])
        assert any(
            lit.startswith("INSERT INTO tenant_workstation_products "
                           "(tenant_id, team_id, workstation, product_key, is_enabled)")
            for lit in lits), "ws_products.py 的 INSERT 没写 team_id"

    def testworker那条断言字面量的测试也同步更新了(self):
        """`test_ws_products_seals.py` 断言了这个 SQL 字面量 —— 它必须与代码一起改，
        否则 worker 门禁会红（这正是"同批"的可见信号）。"""
        p = _ROOT / "backend" / "worker" / "tests" / "test_ws_products_seals.py"
        lits = _sql_literals(p)
        assert any(
            "ON CONFLICT (tenant_id, (COALESCE(team_id, 0)), workstation, product_key)" in lit
            for lit in lits), "断言还没同步成新目标"
        assert not any(
            "ON CONFLICT (tenant_id, workstation, product_key)" in lit for lit in lits
        ), "断言里还留着旧目标"
