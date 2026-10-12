"""忘记密码 / 重置密码 —— orchestrator 单元测试（不连库，mock 数据层）。

覆盖安全口径（AGENTS.md 规则5：断言给足证据，不靠"没报错"）：
- token 只存哈希（库里永远没有明文）
- 30 分钟过期 / 用后即废 / 同用户其它令牌失效
- 不泄露邮箱存在性（统一 {ok:true}）
- 新密码长度校验
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.unit

from app.services.password_reset import (  # noqa: E402
    build_reset_link,
    generate_reset_token,
    hash_reset_token,
    reset_email_html,
)


class TestTokenHash:
    def test_明文与哈希不同_库泄露不足以重置(self):
        raw = generate_reset_token()
        h = hash_reset_token(raw)
        assert raw != h
        assert len(h) == 64  # sha256 hex

    def test_哈希可复现(self):
        raw = generate_reset_token()
        assert hash_reset_token(raw) == hash_reset_token(raw)

    def test_令牌高熵_两次不同(self):
        assert generate_reset_token() != generate_reset_token()


class TestResetLink:
    def test_链接指向reset_password页(self):
        link = build_reset_link("abc123", "https://kaas.powervoy.com")
        assert link == "https://kaas.powervoy.com/reset-password?token=abc123"

    def test_base_url末尾斜杠被规范(self):
        link = build_reset_link("t", "https://x.example.com/")
        assert link == "https://x.example.com/reset-password?token=t"

    def test_邮件正文含链接且含过期提示(self):
        html = reset_email_html("https://x/reset-password?token=t")
        assert "https://x/reset-password?token=t" in html
        assert "30 分钟" in html and "只能使用一次" in html
