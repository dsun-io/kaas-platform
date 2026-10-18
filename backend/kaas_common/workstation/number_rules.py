"""单据/报价/询盘编号的编辑规则（两端共用，纯函数）。

用户口径（2026-10-18）：
  · 编号默认由系统**自动生成**（生成时即带出）；
  · 下游单据/报价生成之前，可以手动修改，但必须经过二次确认；
  · 一旦下游已生成，编号锁定，不可再改：
      - 询盘：生成报价（报价单）后锁定；
      - 报价：生成 PI 等后续单证后锁定（仅报价单本身不算下游）；
      - 单证：同一链条上生成更晚的单证后锁定。
"""
from __future__ import annotations

import re
from typing import Optional

__all__ = ["normalize_number", "NumberError"]

# 编号允许：字母/数字/中文 + 常见分隔符；不允许空白与控制字符
_NUMBER_RE = re.compile(r"^[\w\u4e00-\u9fff][\w\u4e00-\u9fff._/#-]*$", re.UNICODE)
MAX_LEN = 64


class NumberError(ValueError):
    """编号不合法。"""


def normalize_number(value: Optional[str]) -> str:
    """去空白并校验；空/非法 → NumberError。

    手改也允许中文（如“报价-张工”），但不允许空格和换行 —— 单据号进单证/文件名，
    空白会让打印与文件命名出现不可见差异。
    """
    text = str(value or "").strip()
    if not text:
        raise NumberError("编号不能为空；留空时应由系统自动生成")
    if len(text) > MAX_LEN:
        raise NumberError(f"编号不能超过 {MAX_LEN} 个字符")
    if not _NUMBER_RE.match(text):
        raise NumberError("编号只能包含字母/数字/中文及 . _ / # -，不能含空格或控制字符")
    return text
