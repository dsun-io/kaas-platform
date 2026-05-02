"""
Kaas v2 · 租户配置加载器
──────────────────────
v2 修正：使用 cachetools.TTLCache（不用 functools.lru_cache + ttl）
缓存 5 分钟过期，避免热重载需要重启服务。

Phase 1: 从 config/tenants.yaml 静态加载
Phase 2+: 迁移至 PostgreSQL 动态加载
"""

import os
from pathlib import Path
from typing import Dict, Any, Optional

import yaml
from cachetools import TTLCache, cached

# 5 分钟缓存（v2 修正: 使用 cachetools.TTLCache 而非 functools.lru_cache）
_tenant_cache: TTLCache = TTLCache(maxsize=32, ttl=300)

# tenants.yaml 路径
_CONFIG_DIR = Path(__file__).resolve().parent.parent.parent / "config"
_TENANTS_FILE = _CONFIG_DIR / "tenants.yaml"


def _load_tenants_yaml() -> Dict[str, Any]:
    """从 YAML 文件加载租户配置（内部方法，不带缓存）。"""
    config_path = os.environ.get("TENANTS_CONFIG_PATH", str(_TENANTS_FILE))
    with open(config_path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    return data.get("tenants", {})


@cached(cache=_tenant_cache)
def get_all_tenants() -> Dict[str, Any]:
    """获取所有租户配置（带 5 分钟 TTL 缓存）。"""
    return _load_tenants_yaml()


def load_tenant_config(tenant_id: str) -> Optional[Dict[str, Any]]:
    """
    获取指定租户配置。

    Args:
        tenant_id: 租户标识（对应 X-Tenant-Id header）

    Returns:
        租户配置字典，不存在则返回 None

    Raises:
        无 - 返回 None 时由调用方决定是否 403
    """
    tenants = get_all_tenants()
    tenant = tenants.get(tenant_id)
    if tenant and not tenant.get("enabled", True):
        return None
    return tenant


def get_tenant_datasets(tenant_id: str) -> Dict[str, str]:
    """
    获取租户的 FastGPT dataset ID 映射。
    用于 Orchestrator 代码层拼 datasetIds（铁律1: AI 不参与范围决策）。
    """
    tenant = load_tenant_config(tenant_id)
    if not tenant:
        return {}
    return tenant.get("fastgpt", {}).get("datasets", {})


def reload_all_tenants() -> None:
    """手动清除租户缓存（用于管理接口热更新）。"""
    _tenant_cache.clear()
