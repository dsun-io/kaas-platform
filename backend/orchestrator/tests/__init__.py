"""Kaas v2 · test suite.

导入时**抢先固定**真实的 `AuthContextMiddleware.dispatch`：
本包在 conftest 之前被导入，此时 `app.middleware.auth` 还是原始实现；
conftest 的 autouse fixture 随后会把 `dispatch` 换成"注入测试 AuthContext"的替身，
而本次拆分的**关键行为**（customer 账号没有 `user_customers` 绑定不再被 403）
恰恰发生在真实中间件里 —— 没有这个锚点，测试就只能复制一遍中间件逻辑来断言，
而复制品测不出"真实实现到底改没改"。
"""
from app.middleware.auth import AuthContextMiddleware as _AuthContextMiddleware

_REAL_AUTH_DISPATCH = _AuthContextMiddleware.dispatch
if getattr(_REAL_AUTH_DISPATCH, "__name__", "") != "dispatch":
    raise RuntimeError("tests/__init__.py 必须在 conftest 之前被导入：拿到的不是真实 dispatch")
