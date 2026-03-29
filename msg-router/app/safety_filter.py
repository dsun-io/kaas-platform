"""AI回复安全过滤管道模块.

实现AI回复发送前的多层安全检查：
1. 敏感词黑名单过滤（分词+完整词匹配）
2. 价格合理性检查
3. 承诺合规检查
4. 兜底逻辑（修改比例过高时转人工）
"""

import re
import time
from dataclasses import dataclass, field
from typing import Any

import jieba

from app.safety_config import (
    get_fallback_config,
    get_price_config,
    get_rules,
    get_sensitive_words,
)

# 添加自定义词典，确保敏感词能被正确分词
_jieba_initialized = False


def _init_jieba() -> None:
    """初始化 jieba 分词，添加敏感词到词典."""
    global _jieba_initialized
    if _jieba_initialized:
        return

    # 添加敏感词到 jieba 词典（这些词会被优先识别为完整词）
    custom_words = [
        # 竞品品牌
        "小客服", "客服宝", "晓多", "美洽", "智齿客服", "UDESK",
        "容联七陌", "网易七鱼", "环信", "Live800", "53客服",
        # 承诺用语
        "假一赔十", "无效退款", "包满意",
        # 其他敏感词
        "法轮功", "台独", "疆独", "藏独", "港独",
    ]

    for word in custom_words:
        jieba.add_word(word, freq=1000)  # 高频确保优先识别

    _jieba_initialized = True


@dataclass
class FilterResult:
    """过滤结果数据类."""

    original_reply: str = ""
    filtered_reply: str = ""
    is_filtered: bool = False
    should_transfer: bool = False
    transfer_reason: str = ""
    filter_log: dict[str, Any] = field(default_factory=dict)
    elapsed_ms: int = 0


def _segment_text(text: str) -> list[tuple[str, int, int]]:
    """对文本进行分词，返回 (词, 起始位置, 结束位置) 列表.

    Args:
        text: 原始文本

    Returns:
        分词结果列表
    """
    # 确保 jieba 已初始化
    _init_jieba()

    words = jieba.lcut(text)
    result = []
    pos = 0
    for word in words:
        start = text.find(word, pos)
        if start >= 0:
            end = start + len(word)
            result.append((word, start, end))
            pos = end
        else:
            # 如果找不到（理论上不会发生），跳过
            pos += len(word)
    return result


def _filter_sensitive_words(text: str, rules: dict[str, Any]) -> tuple[str, list[dict]]:
    """敏感词过滤（分词+完整词匹配）.

    Args:
        text: 原始文本
        rules: 敏感词规则配置

    Returns:
        (过滤后文本, 过滤动作列表)
    """
    actions = []
    filtered_text = text
    offset = 0

    # 获取分词结果
    segments = _segment_text(text)

    # 处理各个敏感词类别
    sensitive_words = rules.get("sensitive_words", {})

    for category, config in sensitive_words.items():
        if not isinstance(config, dict):
            continue

        action_type = config.get("action", "replace")

        if action_type == "replace":
            # 获取替换规则
            patterns = config.get("patterns", [])
            replacement_map = {p["word"]: p["replacement"] for p in patterns if "word" in p and "replacement" in p}
            words_list = config.get("words", [])

            # 处理分词结果
            for word, start, end in segments:
                if word in replacement_map:
                    # 记录动作
                    actions.append({
                        "type": "replace",
                        "category": category,
                        "original": word,
                        "replacement": replacement_map[word],
                        "position": (start, end),
                    })
                    # 执行替换（需要考虑前面替换导致的偏移）
                    actual_start = start + offset
                    actual_end = end + offset
                    filtered_text = (filtered_text[:actual_start] +
                                   replacement_map[word] +
                                   filtered_text[actual_end:])
                    # 更新偏移
                    offset += len(replacement_map[word]) - len(word)

                elif word in words_list:
                    # 使用统一替换文本
                    replacement = config.get("replacement", "【过滤】")
                    actions.append({
                        "type": "replace",
                        "category": category,
                        "original": word,
                        "replacement": replacement,
                        "position": (start, end),
                    })
                    actual_start = start + offset
                    actual_end = end + offset
                    filtered_text = (filtered_text[:actual_start] +
                                   replacement +
                                   filtered_text[actual_end:])
                    offset += len(replacement) - len(word)

        elif action_type == "block":
            # 拦截类敏感词
            block_words = config.get("words", [])
            for word, start, end in segments:
                if word in block_words:
                    actions.append({
                        "type": "block",
                        "category": category,
                        "word": word,
                        "position": (start, end),
                    })
                    # 返回拦截信息和空文本
                    block_message = config.get("block_message", "内容被拦截")
                    return "", actions + [{"type": "block_triggered", "message": block_message}]

    return filtered_text, actions


def _extract_prices(text: str, config: dict[str, Any]) -> list[dict]:
    """从文本中提取价格信息.

    Args:
        text: 原始文本
        config: 价格校验配置

    Returns:
        价格信息列表
    """
    prices = []
    pattern = config.get("price_pattern", r"\d+\.?\d*")
    unit_suffixes = config.get("unit_suffixes", ["元", "块"])

    # 构建匹配模式（数字 + 可选的单位后缀）
    unit_pattern = "|".join(re.escape(u) for u in unit_suffixes)
    full_pattern = f"({pattern})(?:{unit_pattern})?"

    for match in re.finditer(full_pattern, text):
        price_str = match.group(1)
        try:
            price_val = float(price_str)
            prices.append({
                "value": price_val,
                "text": match.group(0),
                "position": (match.start(), match.end()),
            })
        except ValueError:
            continue

    return prices


def _validate_prices(text: str, prices: list[dict], config: dict[str, Any]) -> tuple[str, list[dict]]:
    """校验价格合理性.

    Args:
        text: 原始文本
        prices: 提取的价格列表
        config: 价格校验配置

    Returns:
        (处理后文本, 动作列表)
    """
    if not config.get("enabled", True):
        return text, []

    actions = []
    ranges = config.get("ranges", [])
    out_of_range_action = config.get("out_of_range_action", "replace")
    out_of_range_message = config.get("out_of_range_message", "价格相关问题已转人工")

    # 默认范围
    default_range = {"min": 0.01, "max": 999999}
    for r in ranges:
        if r.get("category") == "default":
            default_range = r
            break

    min_price = default_range.get("min", 0.01)
    max_price = default_range.get("max", 999999)

    for price_info in prices:
        price_val = price_info["value"]
        if price_val < min_price or price_val > max_price:
            # 价格超出范围
            if out_of_range_action == "replace":
                actions.append({
                    "type": "price_out_of_range",
                    "price": price_val,
                    "range": (min_price, max_price),
                    "action": "transfer",
                    "message": out_of_range_message,
                })
                # 价格异常时，返回转人工话术，文本清空
                return "", actions

    return text, actions


def _calculate_modification_ratio(original: str, filtered: str) -> float:
    """计算文本修改比例.

    Args:
        original: 原文
        filtered: 过滤后文本

    Returns:
        修改比例 (0.0 - 1.0)
    """
    if not original:
        return 0.0

    # 使用编辑距离思想简化计算
    original_len = len(original)
    filtered_len = len(filtered)

    # 计算差异字符数
    diff_chars = abs(original_len - filtered_len)
    min_len = min(original_len, filtered_len)

    # 计算相同位置的差异
    for i in range(min_len):
        if original[i] != filtered[i]:
            diff_chars += 1

    return min(diff_chars / original_len, 1.0) if original_len > 0 else 0.0


def run_safety_pipeline(reply: str) -> FilterResult:
    """执行完整的安全过滤管道.

    Args:
        reply: AI生成的原始回复

    Returns:
        FilterResult 包含过滤结果和日志
    """
    started = time.perf_counter()
    result = FilterResult(original_reply=reply, filtered_reply=reply)

    if not reply:
        result.elapsed_ms = int((time.perf_counter() - started) * 1000)
        return result

    try:
        # 加载配置
        rules = get_rules()
        fallback_config = get_fallback_config()

        all_actions = []
        current_text = reply

        # 1. 敏感词过滤
        current_text, sw_actions = _filter_sensitive_words(current_text, rules)
        all_actions.extend(sw_actions)

        # 检查是否被拦截
        if any(a.get("type") == "block_triggered" for a in sw_actions):
            block_msg = next((a.get("message", "") for a in sw_actions if a.get("type") == "block_triggered"), "内容被拦截")
            result.filtered_reply = ""
            result.is_filtered = True
            result.should_transfer = True
            result.transfer_reason = block_msg
            result.filter_log = {
                "actions": all_actions,
                "modification_ratio": 1.0,
                "pipeline_stages": ["sensitive_words"],
            }
            result.elapsed_ms = int((time.perf_counter() - started) * 1000)
            return result

        # 2. 价格校验
        price_config = get_price_config()
        prices = _extract_prices(current_text, price_config)
        if prices:
            current_text, price_actions = _validate_prices(current_text, prices, price_config)
            all_actions.extend(price_actions)

            # 检查是否因价格异常转人工
            if any(a.get("type") == "price_out_of_range" for a in price_actions):
                transfer_action = next(a for a in price_actions if a.get("type") == "price_out_of_range")
                result.filtered_reply = ""
                result.is_filtered = True
                result.should_transfer = True
                result.transfer_reason = transfer_action.get("message", "价格异常")
                result.filter_log = {
                    "actions": all_actions,
                    "modification_ratio": 1.0,
                    "pipeline_stages": ["sensitive_words", "price_validation"],
                }
                result.elapsed_ms = int((time.perf_counter() - started) * 1000)
                return result

        # 3. 兜底检查：修改比例
        modification_ratio = _calculate_modification_ratio(reply, current_text)
        max_ratio = fallback_config.get("max_modification_ratio", 0.4)

        if modification_ratio > max_ratio:
            fallback_action = fallback_config.get("fallback_action", "transfer")
            fallback_message = fallback_config.get("fallback_message", "回复内容需要人工审核")

            if fallback_action == "transfer":
                result.filtered_reply = ""
                result.is_filtered = True
                result.should_transfer = True
                result.transfer_reason = fallback_message
                result.filter_log = {
                    "actions": all_actions + [{"type": "fallback_triggered", "reason": "modification_ratio_exceeded", "ratio": modification_ratio}],
                    "modification_ratio": modification_ratio,
                    "max_ratio": max_ratio,
                    "pipeline_stages": ["sensitive_words", "price_validation", "fallback"],
                }
                result.elapsed_ms = int((time.perf_counter() - started) * 1000)
                return result

        # 正常完成过滤
        result.filtered_reply = current_text
        result.is_filtered = len(all_actions) > 0
        result.filter_log = {
            "actions": all_actions,
            "modification_ratio": modification_ratio,
            "pipeline_stages": ["sensitive_words", "price_validation"],
        }

    except Exception as e:
        # 过滤过程中出现异常，保守起见转人工
        result.filtered_reply = ""
        result.is_filtered = True
        result.should_transfer = True
        result.transfer_reason = "安全过滤异常，转人工处理"
        result.filter_log = {
            "error": str(e),
            "pipeline_stages": ["error"],
        }

    result.elapsed_ms = int((time.perf_counter() - started) * 1000)
    return result
