"""翻译 prompt 构造与响应解析（纯函数；LLM HTTP 调用在适配层）。

单证场景：业务员中文/中英混输 → AI 输出外贸正式英文（凭据/单证措辞），
数字、单位、专有名词（公司名/港口/唛头）保持不变。
"""
from __future__ import annotations

import json
import re
from typing import Any, Mapping

SYSTEM_PROMPT = (
    "You are a senior foreign-trade documentation specialist. "
    "Translate the given document fields into professional, formal trade English "
    "suitable for commercial invoices, packing lists and certificates of origin. "
    "Rules: keep ALL numbers, units, company names, ports, marks and SWIFT codes unchanged; "
    "use conventional trade phrasing (e.g. 'The buyer shall arrange...'); "
    'return STRICT JSON mapping each input key to its English string: {"<key>": "<english>", ...}.'
)


def build_messages(fields: Mapping[str, str]) -> list[dict[str, str]]:
    """把 {字段名: 中文/混输文本} 编成 chat messages。"""
    payload = {k: str(v) for k, v in fields.items() if str(v or "").strip()}
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": "Translate these trade document fields to English:\n"
            + json.dumps(payload, ensure_ascii=False),
        },
    ]


def parse_translation(content: str, original: Mapping[str, str]) -> dict[str, str]:
    """容错解析 LLM 返回：优先 JSON；失败时回退原文（不丢数据）。

    返回与 original 同键的 dict；未翻译到的键回退原值。
    """
    text = (content or "").strip()
    # 剥掉可能的 ```json 围栏
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    parsed: dict[str, Any] = {}
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            parsed = {str(k): v for k, v in obj.items()}
    except (json.JSONDecodeError, ValueError):
        pass

    out: dict[str, str] = {}
    for key, value in original.items():
        translated = parsed.get(key)
        out[key] = str(translated).strip() if translated is not None and str(translated).strip() else value
    return out
