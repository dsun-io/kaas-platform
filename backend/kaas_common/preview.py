"""S5 预览环境前缀规则（共享内核）——orchestrator 与 Worker **共用一份**。

背景（README §2.3 规则 5/6）：
  预览与生产**物理隔离**：预览 R2 桶 ``kaas-preview-storage`` / 预览 KV namespace
  由所有 PR 共享，PR 之间靠键前缀区分：

    R2 对象键  ``pr-<slug>/`` + 常规 object_key
    KV 键      ``pr-<slug>:`` + 常规键名

  ``PR_SLUG`` 由 CI 在部署预览 Worker 时经 vars 注入；**空 / 未设置 = 生产行为，
  前缀为空串**（生产零影响）。代码不得硬编码 bucket/namespace，本模块只负责
  「从 env 值推导前缀」这一段纯函数。

slug 口径：slug = **PR 号**（1-9 位纯数字）。PR 号天然唯一、确定、无注入面；
因此 Neon 分支 ``preview-pr-<num>``、Hyperdrive ``kaas-preview-<num>``、
worker ``kaas-preview-pr-<num>``、键前缀 ``pr-<num>`` 全套同名同源。
"""
from __future__ import annotations

import re
from typing import Optional

__all__ = [
    "PR_SLUG_RE", "normalize_pr_slug", "storage_prefix",
    "apply_storage_prefix", "kv_key",
]

# 与 scripts/preview/preview_lib.py 的 PR_SLUG_RE 保持同步（脚本侧只做防御性重复校验）
PR_SLUG_RE = re.compile(r"^[0-9]{1,9}$")


def normalize_pr_slug(raw: Optional[str]) -> Optional[str]:
    """把 env 里的 PR_SLUG 归一成合法 slug；非法/空一律返回 ``None``（=生产行为）。

    为什么非法值降级为 None 而不是报错：env 由部署管道注入，正常不会错；
    但「宁可无前缀也不写错前缀」—— 一个脏值把生产键名改出前缀是污染事故，
    静默退回生产行为（配合 S5-d 断言兜底：预览断言 PR_SLUG 已注入且匹配）。
    """
    slug = (raw or "").strip()
    if not slug:
        return None
    if PR_SLUG_RE.match(slug):
        return slug
    return None


def storage_prefix(slug: Optional[str]) -> str:
    """R2 对象键前缀。``None`` → 空串（生产零影响）。"""
    return f"pr-{slug}/" if slug else ""


def apply_storage_prefix(key: str, slug: Optional[str]) -> str:
    """给 object_key 加 ``pr-<slug>/`` 前缀（幂等：已有前缀不重复加）。"""
    prefix = storage_prefix(slug)
    if not prefix or key.startswith(prefix):
        return key
    return prefix + key


def kv_key(name: str, slug: Optional[str]) -> str:
    """KV 键名。预览：``pr-<slug>:<name>``；生产（slug=None）：原样返回。

    当前尚无业务 KV 消费方；本函数是首个消费方的唯一合法入口（S5-c 落地规则），
    新增 KV 读写必须走这里，不得自行拼前缀。
    """
    if not slug:
        return name
    return f"pr-{slug}:{name}"
