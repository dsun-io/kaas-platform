# 迁移链 downgrade 审计（静态 · 2026-10-19）

> 生成方式：`python scripts/audit-migrations.py`（AST 静态分析，不连数据库）。
> 用途：README §8 已知问题 #6 —— 历史迁移链有结构性断点，downgrade 需逐版本审计。

## 总览

- 版本文件：**70**
- 计算 head：**202610180010**
- upgrade 含破坏性操作（drop_table/drop_column/drop_constraint/drop_index）：**10**
  - 其中含 `drop_table`：**3**
- downgrade 函数体为空（无回滚实现）：**0**
- 含 drop_table 且 downgrade 未重建表（回滚会丢数据）：**3**

## 含 drop_table 的版本（逐条）

| revision | 文件 | upgrade 破坏操作 | downgrade 有无回滚 | 备注 |
|---|---|---|---|---|
| `202609230001` | 202609230001_drop_conversation_tables.py | drop_table(conversation_messages) [重建成本高], drop_table(conversations) [重建成本高] | 无重建 |  |
| `202609230002` | 202609230002_drop_wechat_tables.py | drop_table(wechat_message_events) [重建成本高], drop_table(wechat_conversations) [重建成本高], drop_table(wechat_bot_accounts) [重建成本高] | 无重建 |  |
| `202609230004` | 202609230004_merge_customers.py | drop_table(cust_customers) [重建成本高], drop_constraint(?) | 有 |  |

## downgrade 为空的版本（回滚只能靠 upgrade 的反向脚本）

| revision | 文件 |
|---|---|

## 结论与建议

1. 历史链**不能从 base 重放**（`f82ac951b473` 与 `202605030002` 重复建表），空库一律走
   `metadata.create_all + stamp head` 快径（`app/db/migration_bootstrap.py`）；因此 downgrade 审计的
   实际用途是「灾难回滚时知道哪些版本不可逆」，不是日常回滚。
2. 含 `drop_table` 的版本默认**不可逆**：回滚会丢业务数据；发布前应对该批表做冷备（CSV/快照）。
3. 后续新迁移要求：`upgrade` 有破坏性操作时，`downgrade` 必须要么真正恢复结构，要么在
   docstring 显式写 `IRREVERSIBLE: <原因>`（由本脚本 grep 即可审计）。
4. 本审计不修改任何迁移文件；历史链保持冻结（README §5）。
5. **与旧口径的差异**：PLAN_B §5 曾估「70 versions 中 35 个含 drop_table」；本次按 AST 精确统计
   `upgrade()` 内的 `op.drop_table` 调用仅 **3** 个（含任意破坏性调用共 10 个）。旧估算可能把
   `downgrade` 里的重建语句 / 字符串出现也计入 → **以本次精确口径为准**。

---

## 实测补充（2026-10-19 夜场 · S4 后的一致性验证）

静态审计之外，本轮在**一次性空库**（`kaas_downtest`：先从 base 重放不得，改用
`alembic upgrade head` 建到 102 表 / head `202610190020`）上实跑降级链，结论如下。

### 已修：两个真实 downgrade bug

| 版本 | 问题 | 修复 |
|---|---|---|
| `202610180004`（删 product_cost_history） | `downgrade()` 是 `pass` ⇒ 降到 002 时表已不存在，002 的 `drop_index` 直接 `UndefinedObject` | downgrade 按 002 的 upgrade 形态**重建表 + 两个索引**；降级到 002 后 schema 自洽（实测索引 `idx_product_cost_history_lookup/_spec` 均存在） |
| `202610180002` | `downgrade` 用严格 `op.drop_index/drop_column`，生产存在历史手工漂移时会中断整条链 | 改为 `DROP INDEX/TABLE IF EXISTS` + `ALTER TABLE ... DROP COLUMN IF EXISTS`（PG-only 项目；语义不变） |

验证：`alembic downgrade 202610180002` → 表/索引存在 → `upgrade head` 成功 → `alembic check` 无漂移；
`alembic downgrade -1`（head→010）→ `upgrade head` 往返成功。CI 已加「最新迁移可逆」门禁。

### 未修：全链 `downgrade base` 仍不支持（与静态审计一致）

实测继续往 base 降级时在 **`202610170004` 的 downgrade** 处失败：

```
Running downgrade 202610170004 -> 202610170003 ...
psycopg2.errors.UndefinedTable: relation "cust_customers" does not exist
```

原因：早期迁移把 `cust_customers` 合并/改名为 `customers`，但更早版本的 downgrade 仍按旧表名
重建外键；这是 2026-09 历史链的结构性断点（与 §结论-1 的「不能从 base 重放」同源）。
**处理策略（本次定稿）**：
- 历史链**保持冻结**，不逐个版本回填降级逻辑（风险高于收益）；
- 生产回滚**一律用 Neon 分支 / 时间点恢复（PITR）或冷备**，不用 `alembic downgrade base`；
- 新迁移必须通过 CI 的 `downgrade -1 → upgrade head` 往返门禁；
- 破坏性迁移在 downgrade 里显式写 `IRREVERSIBLE: 原因`（审计脚本可 grep）。
