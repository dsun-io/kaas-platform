"""三张单据表真正关联业务客户：customer_id TEXT → BIGINT + 外键

Revision ID: 202610110009
Revises: 202610110008
Create Date: 2026-10-11

背景（业务确认）
----------------
`quote_orders` / `orders` / `trade_docs` 的 `customer_id` 一直是 **TEXT、无外键**，
值是自由文本甚至垃圾（实测生产库里有 `'3'`（该客户已删）与 `'lianjia-demo'`（演示串））。
后果：客户详情页**列不出该客户的报价/订单/单证** —— 因为单据与业务客户之间没有任何
可靠的关联键，"业务客户粒度"的聚合根本无从谈起。

本迁移把这三张表的 `customer_id` 变成**真外键**：`BIGINT REFERENCES customers(id)
ON DELETE SET NULL`，让"单据属于哪个客户"由数据库保证，而不是靠约定。

执行顺序（**顺序本身就是正确性的一部分**）
------------------------------------------
离线上线时最容易踩的坑是：直接 `ALTER COLUMN ... TYPE BIGINT` —— 只要有一条脏值
（`'lianjia-demo'`），整个迁移就会因 `invalid input syntax for type bigint` 失败，
而且是在**已经改了半张表之后**失败。所以必须：

1. **先尽力回填**：按 `(tenant_id, team_id, customer_name)` 找现有业务客户，
   把 `customers.id` 写回 `customer_id`（历史数据因此也能按客户聚合）；
2. **再清洗**：非数字、或指向不存在的客户（含已软删的）→ `NULL`；
3. **最后改类型 + 加外键**：此时列里只剩合法 id 或 NULL，转换不可能失败；
4. 加索引（按 `customer_id` 聚合要用）。

回填规则的两个关键取舍
----------------------
- **只认唯一匹配**：同一团队里可能有多条同名客户（重复录入）。猜错会把单据挂到
  别的客户名下，而"挂错客户"比"留空待人工认领"更难发现、更难纠正 ——
  `HAVING count(DISTINCT c.id) = 1` 只回填唯一匹配的行。
- **不覆盖已有有效关联**：只有当现值不是"指向未软删客户"的有效 id 时才回填。
  否则一次按名字的猜测会覆盖掉一条本来正确的关联。

`team_id` 匹配用 `IS NOT DISTINCT FROM`
----------------------------------------
单据 `team_id` 为 NULL 时要匹配 `customers.team_id IS NULL` 的客户（未分组对未分组），
而 `NULL = NULL` 在 SQL 里是 NULL（不成立）—— 必须用 `IS NOT DISTINCT FROM`。

`trade_docs` 没有 `customer_name` 列
------------------------------------
其余两表有 `customer_name` 快照列，单证表没有：它的客户名只在开单时冻结进
`raw_payload.sources.<order|quote>.customer_name`（派生单证还会再深一层：
`sources.<源单据类型>.sources.<order|quote>.customer_name`）。
本迁移从**快照**里取这个名字来做匹配 —— 快照就是"开单当时的客户名"，
与另两张表的语义一致，且**不需要给单证表补列**。

downgrade
---------
删外键/索引、类型改回 TEXT。**不还原**被清洗掉的脏值（`'3'` / `'lianjia-demo'` 这类
自由文本是本次要清掉的东西，还原它等于把问题装回去）；也**不还原**被回填的 id
（回填是按名字匹配的结果，改回文本没有额外信息）。
需要数据级回退请从备份恢复（与 202610110004 / 202610110005 / 202610110008 同一口径）。

幂等
----
**重复执行 upgrade 不会炸**（Alembic 用版本表保证不重跑，这里额外做一层防御：
有人手工补跑、或上一个迁移半途失败后重试，都不该炸）：

- 数据两步（回填/清洗）只在列还是 **TEXT** 时执行 ——
  `customer_id ~ '^[0-9]{1,18}$'` 在 BIGINT 列上会直接报
  `operator does not exist: bigint ~ unknown`；
- 改类型放进 `DO` 块里先判类型（已是 bigint 就跳过）——
  这是必须的，`NULLIF(customer_id,'')` 这类表达式在 bigint 列上同样会报错；
- 外键先 `DROP CONSTRAINT IF EXISTS` 再建；索引 `CREATE INDEX IF NOT EXISTS`。

（不支持 `alembic upgrade --sql` 离线出 SQL：数据清洗要看当前列类型。
本仓库没有任何地方用离线模式，见 README/DEPLOY 里的迁移步骤。）
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610110009"
down_revision: Union[str, None] = "202610110008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# 三张单据表。downgrade 逆序处理（与 upgrade 严格对称）。
DOC_TABLES = ("quote_orders", "orders", "trade_docs")

# 合法 customer_id 的形状：纯数字、且不超过 18 位。
# 18 位上限不是洁癖：`'99999999999999999999999'` 这种"看起来是数字"的脏值
# 能过正则却超出 bigint 范围，强转照样让迁移失败。
ID_PATTERN = "^[0-9]{1,18}$"


def _fk_name(table: str) -> str:
    return f"fk_{table}_customer_id"


def _index_name(table: str) -> str:
    return f"idx_{table}_customer_id"


def _column_type(conn, table: str, column: str = "customer_id"):
    """取列的实际类型（没这列时返回 None）。**只在线模式下可调用**。"""
    return conn.execute(sa.text(
        "SELECT format_type(a.atttypid, NULL) FROM pg_attribute a"
        " WHERE a.attrelid = to_regclass(:t) AND a.attname = :c AND a.attnum > 0"
    ), {"t": table, "c": column}).scalar()


def _safe_id(alias: str) -> str:
    """TEXT 列 → BIGINT 的**安全**转换表达式：形状不对 → NULL。

    这是"不会让迁移挂掉"的关键：整个迁移里凡是要按 id 比较/转换的地方，
    都走这个表达式，而不是直接 `customer_id::bigint`。
    """
    return f"(CASE WHEN {alias}.customer_id ~ '{ID_PATTERN}' THEN {alias}.customer_id::bigint END)"


def _name_expr(table: str, alias: str) -> str:
    """取"开单当时的客户名"：两张表有快照列，单证表从 raw_payload 快照里取。"""
    if table != "trade_docs":
        return f"{alias}.customer_name"
    # 只认 object 形态的 sources（历史脏 payload 可能是数组/标量，jsonb_each 会报错）
    sources = (f"(CASE WHEN jsonb_typeof({alias}.raw_payload->'sources') = 'object'"
               f" THEN {alias}.raw_payload->'sources' ELSE '{{}}'::jsonb END)")
    direct_order = f"NULLIF(btrim({alias}.raw_payload->'sources'->'order'->>'customer_name'), '')"
    direct_quote = f"NULLIF(btrim({alias}.raw_payload->'sources'->'quote'->>'customer_name'), '')"
    nested = (
        "(SELECT min(NULLIF(btrim(nested_snap->'sources'->'{kind}'->>'customer_name'), ''))"
        " FROM jsonb_each({sources}) AS nested(k, nested_snap)"
        " WHERE jsonb_typeof(nested_snap) = 'object')"
    )
    return (
        f"COALESCE({direct_order}, {direct_quote},"
        f" {nested.format(kind='order', sources=sources)},"
        f" {nested.format(kind='quote', sources=sources)})"
    )


def _backfill_by_name(conn, table: str) -> None:
    """按 (tenant_id, team_id, customer_name) 把匹配到的 customers.id 回填进 customer_id。

    只回填"现值无效"的行（见模块 docstring 的取舍说明）。
    """
    name = _name_expr(table, "d2")
    conn.execute(sa.text(f"""
        WITH src AS (
            SELECT d2.id AS doc_id, d2.tenant_id AS tenant_id, d2.team_id AS team_id,
                   {name} AS cname,
                   {_safe_id('d2')} AS cur_id
            FROM {table} AS d2
        ), matched AS (
            SELECT s.doc_id AS doc_id, min(c.id) AS cid
            FROM src AS s
            JOIN customers AS c
              ON c.tenant_id = s.tenant_id
             AND c.team_id IS NOT DISTINCT FROM s.team_id
             AND c.name = s.cname
             AND c.is_deleted = false
            WHERE s.cname IS NOT NULL AND btrim(s.cname) <> ''
              -- 现值已是有效关联 → 不覆盖（名字匹配只是猜测，不能盖过事实）
              AND NOT (s.cur_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM customers AS x
                    WHERE x.id = s.cur_id AND x.is_deleted = false))
            GROUP BY s.doc_id
            -- 同名多条 → 无法判断是哪一家，宁可留空（NULL）等人工认领
            HAVING count(DISTINCT c.id) = 1
        )
        UPDATE {table} AS d
        SET customer_id = m.cid::text
        FROM matched AS m
        WHERE d.id = m.doc_id
    """))


def _null_out_invalid(conn, table: str) -> None:
    """无效关联置 NULL：非数字 / 指向不存在的客户 / 指向已软删的客户。"""
    conn.execute(sa.text(f"""
        WITH src AS (
            SELECT d.id AS doc_id, {_safe_id('d')} AS cur_id
            FROM {table} AS d
            WHERE d.customer_id IS NOT NULL
        )
        UPDATE {table} AS d
        SET customer_id = NULL
        FROM src AS s
        WHERE d.id = s.doc_id
          AND (s.cur_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM customers AS x
                WHERE x.id = s.cur_id AND x.is_deleted = false))
    """))


def _to_bigint(conn, table: str) -> None:
    """TEXT → BIGINT（幂等：已是 bigint 就跳过）。

    为什么把"当前类型"的判断放进 `DO` 块交给 Postgres，而不是先 SELECT 再决定：
      · 幂等是**必须**的，不是"大概没事"—— `NULLIF(customer_id,'')` 这类表达式
        在 bigint 列上会直接报错，所以得真的跳过；
      · 判断与 ALTER 在**同一个语句**里完成，不存在"查完到改之间被别人改了"的窗口。
    """
    # 与 `NULLIF(customer_id,'')::bigint` 等价，但把**任何**形状不对的值都安全转成 NULL
    # （不只是空串）—— 上游清洗万一漏了一条，这里也不会让整个迁移失败。
    #
    # 判类型用 pg_attribute/pg_type + `to_regclass`（按 search_path 解析到**这张**表），
    # 不用 information_schema.columns：后者不带 schema 过滤，同名表会互相干扰。
    conn.execute(sa.text(f"""
        DO $do$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_attribute a
                JOIN pg_class c ON c.oid = a.attrelid
                JOIN pg_type ty ON ty.oid = a.atttypid
                WHERE c.oid = to_regclass('{table}')
                  AND a.attname = 'customer_id'
                  AND a.attnum > 0
                  AND ty.typname <> 'int8'
            ) THEN
                ALTER TABLE {table} ALTER COLUMN customer_id TYPE BIGINT
                USING CASE WHEN customer_id ~ '{ID_PATTERN}'
                           THEN customer_id::bigint END;
            END IF;
        END
        $do$
    """))


def _add_fk(conn, table: str) -> None:
    """加外键。`ON DELETE SET NULL`：客户被硬删时单据保留、只是不再挂客户
    （单据是历史凭证，绝不能因为客户行没了就跟着消失）。"""
    conn.execute(sa.text(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {_fk_name(table)}"))
    conn.execute(sa.text(
        f"ALTER TABLE {table} ADD CONSTRAINT {_fk_name(table)}"
        f" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL"
    ))


def _drop_fk(conn, table: str) -> None:
    """删外键（幂等：不存在也不报错）。downgrade 与用例都走这里。"""
    conn.execute(sa.text(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {_fk_name(table)}"))


def _to_text(conn, table: str) -> None:
    """BIGINT → TEXT（幂等：已是 text 就跳过）。**不还原**被清洗掉的脏值。

    判类型同样交给 Postgres（理由见 `_to_bigint`）。
    """
    conn.execute(sa.text(f"""
        DO $do$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_attribute a
                JOIN pg_class c ON c.oid = a.attrelid
                JOIN pg_type ty ON ty.oid = a.atttypid
                WHERE c.oid = to_regclass('{table}')
                  AND a.attname = 'customer_id'
                  AND a.attnum > 0
                  AND ty.typname <> 'text'
            ) THEN
                ALTER TABLE {table} ALTER COLUMN customer_id TYPE TEXT
                USING customer_id::text;
            END IF;
        END
        $do$
    """))


def upgrade() -> None:
    conn = op.get_bind()

    for table in DOC_TABLES:
        # 数据两步只对 **TEXT** 列有意义（也已经跑过就不该再跑）：
        # `customer_id ~ '...'` 在 BIGINT 列上是"operator does not exist"，会直接炸。
        if (_column_type(conn, table) or "text") == "text":
            # ① 尽力回填（必须在改类型之前：此时列还是 TEXT，写回 id 用文本形态）
            _backfill_by_name(conn, table)
            # ② 清洗无效值（在回填之后：回填进来的 id 本就有效，不会被这一步误清）
            _null_out_invalid(conn, table)
        # ③ 改类型 + 外键（此时不可能再遇到非法值；内部各自幂等）
        _to_bigint(conn, table)
        _add_fk(conn, table)
        # ④ 索引：客户详情页要按 customer_id 聚合三类单据
        op.execute(f"CREATE INDEX IF NOT EXISTS {_index_name(table)} ON {table} (customer_id)")


def downgrade() -> None:
    conn = op.get_bind()
    for table in reversed(DOC_TABLES):
        op.execute(f"DROP INDEX IF EXISTS {_index_name(table)}")
        _drop_fk(conn, table)
        # 类型改回 TEXT，但**不还原**被清洗掉的脏值 / 被回填的 id（见模块 docstring）
        _to_text(conn, table)
