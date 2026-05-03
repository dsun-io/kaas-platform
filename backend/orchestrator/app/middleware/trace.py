import uuid
from opentelemetry import trace
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

class TraceMiddleware(BaseHTTPMiddleware):
    """
    OpenTelemetry 追踪中间件。
    提取或生成 trace_id 并注入 request.state 及 Response Header。
    """
    async def dispatch(self, request: Request, call_next):
        span = trace.get_current_span()
        if span and span.is_recording():
            trace_id_int = span.get_span_context().trace_id
            trace_id = f"{trace_id_int:032x}"
        else:
            trace_id = uuid.uuid4().hex
            
        request.state.trace_id = trace_id
        response = await call_next(request)
        response.headers["X-Trace-Id"] = trace_id
        return response
