"""Kaas v2 · 结构化日志配置 (§8.1)

dev: ConsoleRenderer（彩色 human-readable）
prod: JSONRenderer（给 ELK / CloudWatch 消费）
"""
import os
import sys
import logging
import structlog
from app.core.sanitizer import sanitize_log_value


def sanitize_processor(logger, method_name, event_dict):
    """脱敏 processor：扫描所有 string 值，替换敏感字段。"""
    for key, value in list(event_dict.items()):
        if isinstance(value, str):
            event_dict[key] = sanitize_log_value(value)
    return event_dict


def setup_logging():
    """配置 structlog 全局日志系统。"""
    shared_processors = [
        structlog.contextvars.merge_contextvars,
        sanitize_processor,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]

    env = os.getenv("APP_ENV", "development")
    if env == "production":
        renderer = structlog.processors.JSONRenderer()
    else:
        renderer = structlog.dev.ConsoleRenderer()

    structlog.configure(
        processors=[
            *shared_processors,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(structlog.stdlib.ProcessorFormatter(
        processors=[*shared_processors, renderer],
    ))

    root = logging.getLogger()
    root.handlers = []
    root.addHandler(handler)
    root.setLevel(os.getenv("LOG_LEVEL", "INFO"))
