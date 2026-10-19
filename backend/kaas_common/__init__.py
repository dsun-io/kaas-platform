"""KaaS 共享业务内核（orchestrator 与线上 Worker 共用）

为什么存在
----------
本项目的线上后端是**单文件 Worker**（Pyodide + 裸 asyncpg），开发后端是
完整的 orchestrator（SQLAlchemy）。历史上业务规则被**手写两遍**，导致同类
接口行为漂移（详见 `docs/WORKER_ORCHESTRATOR_DRIFT.md`）。

本包是**唯一实现**：两侧各自只负责数据访问，业务规则只在这里写一次。

铁律（违反会导致 Worker 无法加载）
----------------------------------
1. **只允许标准库 + pydantic**。任何 C 扩展（psycopg2/oss2/bcrypt…）或重库
   都会让 Pyodide 打包失败或拖垮冷启动。
2. **零 I/O**：不连数据库、不发 HTTP、不读文件、不读环境变量。
   需要这些能力的函数不属于内核，留在各自的 `api/` 层。
3. **纯函数优先**：输入 dict / dataclass，输出 dict，便于两侧共用同一份单测。

唯一例外：`kaas_common/db.py` 是**运行时数据访问适配层**（方案 B 阶段二 S1）。它不建连接、
不读环境变量、不做业务判断，只把入口层传入的 asyncpg 连接包成 Session/事务语义
（嵌套事务 = SAVEPOINT，用于测试的 savepoint 回滚隔离）。它同样不 import 任何
第三方驱动，因此不破坏上面两条铁律。

同步方式
--------
`scripts/sync-shared.ps1` 把本目录自动复制到 `backend/worker/src/kaas_common/`，
两侧 import 语句完全一致（`from kaas_common.xxx import ...`），
因此不必手工维护两份。
"""
from kaas_common.version import CORE_VERSION, core_health

__all__ = ["CORE_VERSION", "core_health"]
