"""关键词匹配引擎 - 支持同义词匹配、热更新、模板变量替换"""

import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class MatchResult:
    """匹配结果"""
    matched: bool
    reply: str = ""
    rule_name: str = ""
    should_transfer: bool = False
    source: str = ""  # "faq" | "safety"
    match_type: str = ""  # "exact" | "synonym" | "regex"


@dataclass
class KeywordRule:
    """关键词规则定义"""
    name: str
    keywords: list[str]  # 主关键词列表
    synonyms: dict[str, list[str]] = field(default_factory=dict)  # 同义词映射
    reply_template: str = ""
    priority: int = 100  # 优先级，数字越小越优先
    should_transfer: bool = False  # 是否触发转人工
    enabled: bool = True
    match_mode: str = "contains"  # "contains" | "exact" | "regex"


class KeywordMatcher:
    """关键词匹配器 - 支持热更新"""

    def __init__(
        self,
        faq_config_path: str | Path | None = None,
        safety_config_path: str | Path | None = None,
        reload_interval_seconds: float = 30.0,
    ):
        self.faq_path = Path(faq_config_path) if faq_config_path else None
        self.safety_path = Path(safety_config_path) if safety_config_path else None
        self.reload_interval = reload_interval_seconds

        self._faq_rules: list[KeywordRule] = []
        self._safety_rules: list[KeywordRule] = []
        self._last_reload: dict[str, float] = {}
        self._file_mtime: dict[str, float] = {}

        # 初始加载
        self._reload_if_needed(force=True)

    def _load_json_config(self, path: Path) -> dict[str, Any]:
        """加载JSON配置文件"""
        if not path.exists():
            return {}
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, UnicodeDecodeError, IOError) as e:
            print(f"[KeywordMatcher] 加载配置失败 {path}: {e}")
            return {}

    def _parse_rules(self, data: dict[str, Any]) -> list[KeywordRule]:
        """解析配置数据为规则列表"""
        rules = []
        for name, rule_data in data.items():
            if not isinstance(rule_data, dict):
                continue
            synonyms = rule_data.get("synonyms", {})
            # 确保 synonyms 是 dict[str, list[str]]
            if isinstance(synonyms, list):
                # 如果是列表，转换为 {keyword: [synonyms]}
                synonyms = {name: synonyms}
            elif not isinstance(synonyms, dict):
                synonyms = {}

            rule = KeywordRule(
                name=name,
                keywords=rule_data.get("keywords", []),
                synonyms=synonyms,
                reply_template=rule_data.get("reply_template", ""),
                priority=rule_data.get("priority", 100),
                should_transfer=rule_data.get("should_transfer", False),
                enabled=rule_data.get("enabled", True),
                match_mode=rule_data.get("match_mode", "contains"),
            )
            rules.append(rule)
        # 按优先级排序
        rules.sort(key=lambda r: r.priority)
        return rules

    def _reload_if_needed(self, force: bool = False) -> bool:
        """检查文件修改时间，必要时重新加载配置"""
        reloaded = False
        for path_attr, rules_attr in [
            ("faq_path", "_faq_rules"),
            ("safety_path", "_safety_rules"),
        ]:
            path = getattr(self, path_attr)
            if path is None:
                continue

            path_str = str(path)
            now = time.time()

            # 检查是否需要重新加载
            need_reload = force
            if not need_reload:
                last_check = self._last_reload.get(path_str, 0)
                if now - last_check >= self.reload_interval:
                    try:
                        current_mtime = os.path.getmtime(path)
                        if path_str not in self._file_mtime or current_mtime > self._file_mtime.get(path_str, 0):
                            need_reload = True
                            self._file_mtime[path_str] = current_mtime
                    except OSError:
                        pass
                    self._last_reload[path_str] = now

            if need_reload:
                data = self._load_json_config(path)
                rules = self._parse_rules(data)
                setattr(self, rules_attr, rules)
                reloaded = True
                print(f"[KeywordMatcher] 已重新加载配置: {path} ({len(rules)} 条规则)")

        return reloaded

    def reload(self) -> bool:
        """强制重新加载配置"""
        return self._reload_if_needed(force=True)

    def _check_keyword_match(
        self, text: str, rule: KeywordRule
    ) -> tuple[bool, str, str]:
        """
        检查文本是否匹配规则
        返回: (是否匹配, 匹配到的关键词, 匹配类型)
        """
        normalized = text.strip().lower()

        # 1. 检查主关键词
        for kw in rule.keywords:
            kw_lower = kw.lower()
            if rule.match_mode == "exact":
                if normalized == kw_lower:
                    return True, kw, "exact"
            elif rule.match_mode == "regex":
                try:
                    if re.search(kw, text, re.IGNORECASE):
                        return True, kw, "regex"
                except re.error:
                    continue
            else:  # contains
                if kw_lower in normalized:
                    return True, kw, "contains"

        # 2. 检查同义词
        for main_kw, synonym_list in rule.synonyms.items():
            for syn in synonym_list:
                syn_lower = syn.lower()
                if rule.match_mode == "exact":
                    if normalized == syn_lower:
                        return True, f"{main_kw}({syn})", "synonym"
                elif rule.match_mode == "regex":
                    try:
                        if re.search(syn, text, re.IGNORECASE):
                            return True, f"{main_kw}({syn})", "synonym"
                    except re.error:
                        continue
                else:  # contains
                    if syn_lower in normalized:
                        return True, f"{main_kw}({syn})", "synonym"

        return False, "", ""

    def _render_template(self, template: str, variables: dict[str, str]) -> str:
        """渲染回复模板，支持 {var_name} 占位符"""
        result = template
        for key, value in variables.items():
            result = result.replace(f"{{{key}}}", str(value))
        return result

    def match(
        self,
        text: str,
        buyer_name: str = "",
        platform: str = "",
    ) -> MatchResult:
        """
        执行关键词匹配
        匹配顺序: 先FAQ规则，再Safety规则
        """
        if not text or not text.strip():
            return MatchResult(matched=False)

        # 检查是否需要重新加载配置
        self._reload_if_needed()

        variables = {
            "buyer_name": buyer_name or "亲",
            "platform": platform or "",
        }

        # 1. 先匹配 FAQ 规则（第一级分流）
        for rule in self._faq_rules:
            if not rule.enabled:
                continue
            is_match, matched_kw, match_type = self._check_keyword_match(text, rule)
            if is_match:
                reply = self._render_template(rule.reply_template, variables)
                return MatchResult(
                    matched=True,
                    reply=reply,
                    rule_name=rule.name,
                    should_transfer=rule.should_transfer,
                    source="faq",
                    match_type=match_type,
                )

        # 2. 再匹配 Safety 规则（第二级分流）
        for rule in self._safety_rules:
            if not rule.enabled:
                continue
            is_match, matched_kw, match_type = self._check_keyword_match(text, rule)
            if is_match:
                reply = self._render_template(rule.reply_template, variables)
                return MatchResult(
                    matched=True,
                    reply=reply,
                    rule_name=rule.name,
                    should_transfer=rule.should_transfer,
                    source="safety",
                    match_type=match_type,
                )

        # 未命中任何规则
        return MatchResult(matched=False)

    def get_stats(self) -> dict[str, Any]:
        """获取匹配器统计信息"""
        return {
            "faq_rules_count": len(self._faq_rules),
            "safety_rules_count": len(self._safety_rules),
            "faq_config_path": str(self.faq_path) if self.faq_path else None,
            "safety_config_path": str(self.safety_path) if self.safety_path else None,
            "reload_interval_seconds": self.reload_interval,
        }


# 全局匹配器实例（单例模式，延迟初始化）
_matcher_instance: KeywordMatcher | None = None


def get_matcher(
    faq_config_path: str | Path | None = None,
    safety_config_path: str | Path | None = None,
    reload_interval_seconds: float = 30.0,
) -> KeywordMatcher:
    """获取全局关键词匹配器实例"""
    global _matcher_instance
    if _matcher_instance is None:
        _matcher_instance = KeywordMatcher(
            faq_config_path=faq_config_path,
            safety_config_path=safety_config_path,
            reload_interval_seconds=reload_interval_seconds,
        )
    return _matcher_instance


def reset_matcher() -> None:
    """重置全局匹配器实例（用于测试）"""
    global _matcher_instance
    _matcher_instance = None
