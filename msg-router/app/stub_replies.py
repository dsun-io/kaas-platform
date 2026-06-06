"""桩模式话术池 - 分类回复 + 关键词匹配 + 随机选取

避免单一固定回复被平台风控识别为机器人。
"""

import json
import os
import random
import time
from pathlib import Path
from typing import Any

# 默认回复（兜底）
DEFAULT_REPLY = "亲，收到您的消息了，我这边看下怎么帮您~"


class StubRepliesPool:
    """话术池 - 按场景分类，支持热更新"""

    def __init__(
        self,
        config_path: str | Path | None = None,
        reload_interval_seconds: float = 30.0,
    ):
        self.config_path = Path(config_path) if config_path else None
        self.reload_interval = reload_interval_seconds

        self._scenes: dict[str, dict[str, Any]] = {}
        self._last_reload = 0.0
        self._file_mtime = 0.0

        # 初始加载
        self._reload_if_needed(force=True)

    def _load_json(self, path: Path) -> dict[str, Any]:
        """加载JSON配置"""
        if not path.exists():
            return {}
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, UnicodeDecodeError, IOError) as e:
            print(f"[StubRepliesPool] 加载配置失败 {path}: {e}")
            return {}

    def _reload_if_needed(self, force: bool = False) -> bool:
        """检查并重新加载配置"""
        if self.config_path is None:
            return False

        now = time.time()
        reloaded = False

        need_reload = force
        if not need_reload:
            if now - self._last_reload >= self.reload_interval:
                try:
                    current_mtime = os.path.getmtime(self.config_path)
                    if current_mtime > self._file_mtime:
                        need_reload = True
                        self._file_mtime = current_mtime
                except OSError:
                    pass
                self._last_reload = now

        if need_reload:
            data = self._load_json(self.config_path)
            if data:
                self._scenes = data
                reloaded = True
                print(f"[StubRepliesPool] 已加载话术池: {self.config_path} ({len(data)} 个场景)")

        return reloaded

    def reload(self) -> bool:
        """强制重新加载"""
        return self._reload_if_needed(force=True)

    def _match_scene(self, message: str) -> str:
        """
        根据消息内容匹配场景
        返回场景名称，匹配不到返回 'fallback'
        """
        if not message:
            return "fallback"

        normalized = message.strip().lower()

        # 按顺序匹配场景（按场景定义顺序）
        for scene_name, scene_data in self._scenes.items():
            if scene_name == "fallback":
                continue  # fallback 最后处理

            keywords = scene_data.get("keywords", [])
            for kw in keywords:
                if kw.lower() in normalized:
                    return scene_name

        return "fallback"

    def get_reply(self, message: str) -> str:
        """
        获取回复话术
        1. 匹配场景
        2. 随机选取该场景的一条话术
        """
        # 检查是否需要重新加载
        self._reload_if_needed()

        # 匹配场景
        scene = self._match_scene(message)

        # 获取该场景的话术列表
        scene_data = self._scenes.get(scene)
        if scene_data and "replies" in scene_data:
            replies = scene_data["replies"]
            if replies:
                return random.choice(replies)

        # 兜底：尝试从 fallback 场景获取
        fallback_data = self._scenes.get("fallback")
        if fallback_data and "replies" in fallback_data:
            replies = fallback_data["replies"]
            if replies:
                return random.choice(replies)

        return DEFAULT_REPLY

    def get_stats(self) -> dict[str, Any]:
        """获取话术池统计信息"""
        return {
            "scenes_count": len(self._scenes),
            "config_path": str(self.config_path) if self.config_path else None,
            "reload_interval_seconds": self.reload_interval,
            "scenes": {
                name: len(data.get("replies", []))
                for name, data in self._scenes.items()
            },
        }


# 全局话术池实例（单例）
_pool_instance: StubRepliesPool | None = None


def get_pool(
    config_path: str | Path | None = None,
    reload_interval_seconds: float = 30.0,
) -> StubRepliesPool:
    """获取全局话术池实例"""
    global _pool_instance
    if _pool_instance is None:
        _pool_instance = StubRepliesPool(
            config_path=config_path,
            reload_interval_seconds=reload_interval_seconds,
        )
    return _pool_instance


def get_stub_reply(message: str, config_path: str | Path | None = None) -> str:
    """
    获取桩模式回复话术

    便捷函数：自动初始化话术池并返回回复
    """
    pool = get_pool(config_path)
    return pool.get_reply(message)


def reset_pool() -> None:
    """重置全局话术池实例（用于测试）"""
    global _pool_instance
    _pool_instance = None
