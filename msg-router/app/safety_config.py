"""安全过滤配置加载与热重载模块."""

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

from app.config import settings

# 全局配置缓存和锁
_config_cache: dict[str, Any] = {}
_config_mtime: float = 0.0
_config_lock = threading.RLock()


def _get_config_path() -> Path:
    """获取配置文件路径."""
    # 优先使用配置中的路径，否则使用默认路径
    if hasattr(settings, 'safety_rules_path') and settings.safety_rules_path:
        return Path(settings.safety_rules_path)
    # 默认路径：msg-router/data/safety_rules.json
    base_dir = Path(__file__).parent.parent
    return base_dir / "data" / "safety_rules.json"


def _load_config_file(path: Path) -> dict[str, Any]:
    """从文件加载配置."""
    if not path.exists():
        raise FileNotFoundError(f"安全规则配置文件不存在: {path}")

    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def _check_and_reload() -> None:
    """检查文件修改时间并热重载配置."""
    global _config_cache, _config_mtime

    path = _get_config_path()
    if not path.exists():
        return

    try:
        current_mtime = os.path.getmtime(path)
        with _config_lock:
            if current_mtime > _config_mtime:
                _config_cache = _load_config_file(path)
                _config_mtime = current_mtime
    except (OSError, json.JSONDecodeError) as e:
        # 热重载失败时保持现有配置
        pass


def get_rules() -> dict[str, Any]:
    """获取安全规则配置（带热重载）.

    Returns:
        安全规则配置字典
    """
    global _config_cache

    with _config_lock:
        # 首次加载或热重载
        if not _config_cache:
            path = _get_config_path()
            _config_cache = _load_config_file(path)
            _config_mtime = os.path.getmtime(path)
        else:
            # 检查是否需要热重载
            _check_and_reload()

        return _config_cache.copy()


def reload_rules() -> dict[str, Any]:
    """强制重新加载配置.

    Returns:
        最新配置字典
    """
    global _config_cache, _config_mtime

    path = _get_config_path()
    with _config_lock:
        _config_cache = _load_config_file(path)
        _config_mtime = os.path.getmtime(path)
        return _config_cache.copy()


def get_sensitive_words(category: str | None = None) -> list[str]:
    """获取敏感词列表.

    Args:
        category: 敏感词类别，None 返回所有

    Returns:
        敏感词列表
    """
    rules = get_rules()
    sensitive_words = rules.get("sensitive_words", {})

    if category is None:
        # 返回所有类别中的 words
        all_words = []
        for cat_config in sensitive_words.values():
            if isinstance(cat_config, dict):
                if "words" in cat_config:
                    all_words.extend(cat_config["words"])
        return all_words

    cat_config = sensitive_words.get(category, {})
    return cat_config.get("words", []) if isinstance(cat_config, dict) else []


def get_price_config() -> dict[str, Any]:
    """获取价格校验配置."""
    rules = get_rules()
    return rules.get("price_validation", {})


def get_fallback_config() -> dict[str, Any]:
    """获取兜底配置."""
    rules = get_rules()
    return rules.get("fallback", {})


def get_performance_config() -> dict[str, Any]:
    """获取性能配置."""
    rules = get_rules()
    return rules.get("performance", {})
