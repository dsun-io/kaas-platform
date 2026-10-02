"""PNG 校验与尺寸解析 —— 纯 Python（替代 Pillow，stdlib only）。

为什么不用 Pillow（2026-09-30 设计裁决）：
- 图像**格式转换/透明底/裁边**全部挪到前端 Canvas 完成（浏览器原生能力），
  后端只负责收 PNG 字节 + 校验 + 落库 —— 于是后端不再需要任何图像库，
  orchestrator 与 Worker 行为完全一致（Worker 的 Pyodide 环境也无需装 Pillow）。
- 尺寸解析手写 IHDR：PNG 头部 8 字节魔数 + 首块必为 IHDR（宽/高各 4 字节大端）。
"""
from __future__ import annotations

import struct

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
MAX_SEAL_BYTES = 5 * 1024 * 1024   # 5MB，印章图足够
IHDR_TYPE = b"IHDR"


class PngError(ValueError):
    def __init__(self, code: str, detail: str):
        self.code = code
        self.detail = detail
        super().__init__(f"{code}: {detail}")


def is_png(data: bytes) -> bool:
    return bool(data) and data[:8] == PNG_MAGIC


def png_size(data: bytes) -> tuple[int, int]:
    """解析 IHDR 得宽高。结构：魔数(8) + len(4) + 'IHDR'(4) + width(4) + height(4)。"""
    if not is_png(data):
        raise PngError("BAD_IMAGE", "不是 PNG 文件（请用上传框的自动转换，或直接上传 PNG）")
    if len(data) < 24:
        raise PngError("BAD_IMAGE", "PNG 数据不完整")
    length, chunk_type = struct.unpack(">I4s", data[8:16])
    if chunk_type != IHDR_TYPE or length != 13:
        raise PngError("BAD_IMAGE", "PNG 首块不是 IHDR，文件已损坏")
    width, height = struct.unpack(">II", data[16:24])
    return width, height


def validate_seal_image(data: bytes, *, max_bytes: int = MAX_SEAL_BYTES) -> tuple[int, int]:
    """公章图校验：非空、大小上限、PNG 格式；返回 (width, height)。"""
    if not data:
        raise PngError("EMPTY_FILE", "上传内容为空")
    if len(data) > max_bytes:
        raise PngError("FILE_TOO_LARGE", f"图片不能超过 {max_bytes // (1024 * 1024)}MB")
    return png_size(data)
