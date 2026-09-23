"""KaaS Worker 平台基础设施包。

本包存放跨接口复用的底层封装。当前只有 db（统一数据库访问）。
⚠️ 本包与 Python 标准库模块 `platform` 同名，因此 main.py 按文件加载
platform/db.py（见该文件顶部说明），不要用 `from platform.db import ...`。
"""
