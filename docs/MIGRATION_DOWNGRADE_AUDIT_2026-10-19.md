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
