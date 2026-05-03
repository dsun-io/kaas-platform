"""Kaas v2 · Prometheus 指标 (§8.3)

业务指标 + FastAPI Instrumentator 自动 expose /metrics。
"""
from prometheus_fastapi_instrumentator import Instrumentator
from prometheus_client import Counter, Histogram, Gauge

# 业务指标
QUOTE_REQUESTS = Counter(
    "kaas_quote_requests_total",
    "Total quote requests",
    ["tenant_id", "path", "status"],
)

QUOTE_LATENCY = Histogram(
    "kaas_quote_latency_seconds",
    "Quote E2E latency",
    ["tenant_id", "path"],
    buckets=[0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0],
)

LLM_LATENCY = Histogram(
    "kaas_llm_latency_seconds",
    "LLM API call latency",
    ["provider", "operation"],
    buckets=[0.5, 1.0, 2.0, 5.0, 10.0, 15.0],
)

KB_LATENCY = Histogram(
    "kaas_kb_latency_seconds",
    "KB search latency",
    ["tenant_id"],
    buckets=[0.1, 0.5, 1.0, 2.0, 5.0, 10.0],
)

LLM_FALLBACK_TOTAL = Counter(
    "kaas_llm_fallback_total",
    "LLM fallback triggers",
    ["primary", "fallback", "outcome"],
)

ACTIVE_SESSIONS = Gauge(
    "kaas_active_sessions",
    "Active session count",
)

ARCHIVE_RUN_TOTAL = Counter(
    "kaas_archive_run_total",
    "Archive job runs",
    ["status"],
)

ARCHIVE_ROWS_AFFECTED = Counter(
    "kaas_archive_rows_affected",
    "Archive rows processed",
)


def setup_metrics(app):
    """注册 Prometheus Instrumentator + expose /metrics。"""
    Instrumentator(
        should_group_status_codes=False,
        excluded_handlers=["/health", "/health/ready", "/health/deep", "/metrics"],
    ).instrument(app).expose(app, endpoint="/metrics")
