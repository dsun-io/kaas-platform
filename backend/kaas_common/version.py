"""共享内核版本与自检标记。

存在的意义：用于**实证**共享内核真的被加载进了线上 Worker
（在 `/health` 里回显 `core_health()`，能回显即说明打包链路通了），
而不是靠"应该能行"的推断。
"""

CORE_VERSION = "0.1.0"


def core_health() -> dict:
    """返回共享内核自检信息（纯函数，无 I/O）。"""
    return {"core": "kaas_common", "core_version": CORE_VERSION, "loaded": True}
