"""SSRF 加固（TODO C11）：`kaas_common.net` 的 DNS 解析后校验。

背景：`is_safe_crawl_url` 原先是纯字符串判定，挡不住「域名解析到内网 IP」
（DNS rebinding / 恶意 A 记录）。2026-10-21 加**可选**解析后校验：
- 默认 `resolve=False`，两端（worker/Pyodide 无 socket）行为不变；
- 具备 socket 的运行时传 `resolve=True`，解析出的每个 IP 都要过私网/回环/链路本地/
  保留/组播/未指定判定（含 IPv4-mapped IPv6 与 169.254.169.254 云元数据）；
- 解析不到时不额外阻断（避免把网络抖动变成安全误杀）。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from kaas_common.net import (  # noqa: E402
    is_safe_crawl_url,
    next_redirect_url,
    resolve_host_ips,
)

pytestmark = pytest.mark.unit


def _resolver(*ips: str):
    calls: list[str] = []

    def resolve(host: str) -> list[str]:
        calls.append(host)
        return list(ips)

    resolve.calls = calls  # type: ignore[attr-defined]
    return resolve


def test_string_checks_unchanged_without_resolve():
    assert is_safe_crawl_url("https://shop.example.com/products") is True
    for bad in (
        "file:///etc/passwd",
        "ftp://example.com/x",
        "http://localhost/admin",
        "http://127.0.0.1:8080/",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.5/",
        "http://192.168.1.1/",
        "http://172.16.0.1/",
        "http://[::1]/",
        "http://internal/",
        "http:///nohost",
    ):
        assert is_safe_crawl_url(bad) is False, bad


def test_resolve_false_never_calls_resolver():
    resolver = _resolver("10.0.0.5")
    assert is_safe_crawl_url("https://evil.example.com/x", resolver=resolver) is True
    assert resolver.calls == []  # type: ignore[attr-defined]


def test_resolve_blocks_domain_pointing_to_private_ip():
    assert is_safe_crawl_url(
        "https://evil.example.com/x", resolve=True, resolver=_resolver("10.0.0.5"),
    ) is False
    assert is_safe_crawl_url(
        "https://rebind.example.com/", resolve=True,
        resolver=_resolver("127.0.0.1", "93.184.216.34"),
    ) is False  # 任一解析结果不安全即拒绝
    assert is_safe_crawl_url(
        "https://example.com/", resolve=True, resolver=_resolver("93.184.216.34"),
    ) is True


def test_resolve_blocks_metadata_and_ipv4_mapped():
    assert is_safe_crawl_url(
        "https://meta.example.com/", resolve=True,
        resolver=_resolver("169.254.169.254"),
    ) is False
    assert is_safe_crawl_url(
        "https://mapped.example.com/", resolve=True,
        resolver=_resolver("::ffff:192.168.1.10"),
    ) is False
    assert is_safe_crawl_url(
        "https://linklocal.example.com/", resolve=True, resolver=_resolver("fe80::1"),
    ) is False


def test_resolve_failure_does_not_block():
    """解析不到（DNS 抖动/无 socket）时不额外阻断 —— 请求本身会失败。"""
    assert is_safe_crawl_url(
        "https://example.com/", resolve=True, resolver=_resolver(),
    ) is True


def test_redirect_hop_uses_resolution_when_enabled():
    resolver = _resolver("169.254.169.254")
    assert next_redirect_url(
        "https://example.com/a", "http://metadata.example.com/latest/meta-data/",
        resolve=True, resolver=resolver,
    ) is None
    assert next_redirect_url(
        "https://example.com/a", "/b", resolve=True, resolver=_resolver("93.184.216.34"),
    ) == "https://example.com/b"


def test_resolve_host_ips_injected_and_deduped():
    assert resolve_host_ips("example.com", _resolver("1.1.1.1", "1.1.1.1", "8.8.8.8")) == [
        "1.1.1.1", "8.8.8.8",
    ]
