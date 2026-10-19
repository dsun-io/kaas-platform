# PPG 迁移脚本（scripts/migrate-ppg）

> 一次性迁移工具，**不是产品代码**；运行前先读 `docs/HANDOVER_2026-10-19_P1_PPG_MIGRATION.md`。
> 所有脚本从 `D:\projects\kaas-platform\.env.local` 读 `DATABASE_URL`（Neon 生产）与
> `DATABASE_URL_PPG`（PPG）；输出里不打印凭据。

| 脚本 | 用途 | 幂等 |
|---|---|---|
| `01_reset_ppg_schema.py` | 清空 PPG public schema（仅重建时用） | 是（会丢数据！） |
| `03_copy_data.py` | 6 线程 CSV 复制全部表 → setval → 行数校验 | 是（先 delete 再 copy） |
| `04_fix_schema_drift.py` | 补 `market_ports`/`trade_docs` 漂移列并补拷 | 是 |
| `05_verify_ppg_vs_neon.py` | 表/列/约束/索引/行数全量校验 | 只读 |

推荐执行顺序：`05_verify` →（如需修）`04_fix` → `03_copy` → `05_verify` 直到漂移清零。

**注意**：
- PPG 用**直连** `db.prisma.io`（Accelerate 的 `pooled.db.prisma.io` 停用中）；脚本已自动替换 host。
- PPG 区域 us-east-1，单条语句往返数秒；批量操作建议并发（脚本已实现）。
- 本机无 pg_dump/PG 客户端：表结构由 alembic 快径 + 目录复制构建，数据用 CSV COPY。
