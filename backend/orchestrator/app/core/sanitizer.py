"""Kaas v2 · 敏感信息脱敏 (§15.3)

在日志输出前脱敏 API key / token / password 等字段。
"""
import re

SENSITIVE_PATTERNS = [
    (re.compile(r"(api[_-]?key|token|password|secret)[=:]\s*\S+", re.I), r"\1=***REDACTED***"),
    (re.compile(r"Bearer\s+\S+", re.I), "Bearer ***REDACTED***"),
    (re.compile(r"sk-[a-zA-Z0-9]{12,}"), "sk-***REDACTED***"),
    (re.compile(r"fastgpt-[a-zA-Z0-9]{12,}"), "fastgpt-***REDACTED***"),
]


def sanitize_log_value(value: str) -> str:
    result = value
    for pattern, replacement in SENSITIVE_PATTERNS:
        result = pattern.sub(replacement, result)
    return result


def escape_like(value: str) -> str:
    """转义 SQL LIKE 通配符 % _ 和转义符 \\。

    与 SQLAlchemy ilike(..., escape="\\") 配合使用。
    """
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
