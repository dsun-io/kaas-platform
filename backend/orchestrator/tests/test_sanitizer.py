"""Kaas v2 · 敏感信息脱敏测试 (§15.3)"""
import pytest
pytestmark = pytest.mark.unit
from app.core.sanitizer import sanitize_log_value


class TestSanitizer:
    """敏感信息正则脱敏。"""

    def test_redact_api_key(self):
        """api_key=sk-xxx 被脱敏。"""
        result = sanitize_log_value("api_key=sk-proj-123456789012")
        assert "sk-proj-123456789012" not in result
        assert "***REDACTED***" in result

    def test_redact_bearer_token(self):
        """Bearer token 被脱敏。"""
        result = sanitize_log_value("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.xxx")
        assert "eyJhbGciOiJIUzI1NiJ9.xxx" not in result
        assert "Bearer ***REDACTED***" in result

    def test_redact_fastgpt_token(self):
        """fastgpt token 被脱敏。"""
        result = sanitize_log_value("fastgpt-a1b2c3d4e5f6g7h8i9")
        assert "fastgpt-a1b2c3d4e5f6g7h8i9" not in result
        assert "fastgpt-***REDACTED***" in result

    def test_no_sensitive_fields_passthrough(self):
        """无敏感字段时原样返回。"""
        result = sanitize_log_value("普通日志消息没有任何敏感信息")
        assert result == "普通日志消息没有任何敏感信息"

    def test_redact_password_equals(self):
        """password=xxx 被脱敏。"""
        result = sanitize_log_value("database: password=supersecret123")
        assert "supersecret123" not in result
        assert "***REDACTED***" in result

    def test_redact_token_colon(self):
        """token: xxx 被脱敏。"""
        result = sanitize_log_value("token: abc123def456")
        assert "abc123def456" not in result
        assert "***REDACTED***" in result

    def test_redact_secret_key_value(self):
        """secret=xxx 被脱敏。"""
        result = sanitize_log_value("SECRET=my-private-key-12345")
        assert "my-private-key-12345" not in result
        assert "***REDACTED***" in result
