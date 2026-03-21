"""
直连 FastGPT OpenAPI，打印 HTTP 状态与 JSON 顶层结构，便于排查「只有兜底话术」问题。

用法（在 msg-router 目录下）:
  .venv\\Scripts\\python scripts\\probe_fastgpt.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# 保证可导入 app.*
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import httpx  # noqa: E402

from app.config import settings  # noqa: E402
from app import fastgpt_client  # noqa: E402


def main() -> None:
    if not settings.fastgpt_api_key.strip():
        print("FASTGPT_API_KEY 为空，请在 msg-router/.env 配置")
        sys.exit(1)

    base = settings.fastgpt_api_base.rstrip("/")
    url = f"{base}/v1/chat/completions"
    payload = {
        "chatId": "conv_probe_cli",
        "stream": False,
        "detail": settings.fastgpt_chat_detail,
        "messages": [{"role": "user", "content": "你好，牛栏网1.8米高大概多少钱？"}],
        "variables": {},
    }
    headers = {
        "Authorization": f"Bearer {settings.fastgpt_api_key}",
        "Content-Type": "application/json",
    }

    print("POST", url)
    print("detail=", payload["detail"])

    try:
        r = httpx.post(url, json=payload, headers=headers, timeout=60.0)
    except httpx.HTTPError as exc:
        print("请求异常:", repr(exc))
        sys.exit(2)

    print("HTTP", r.status_code)
    try:
        data = r.json()
    except ValueError:
        print("响应非 JSON，前 500 字符:")
        print(r.text[:500])
        sys.exit(3)

    print("顶层 keys:", list(data.keys()))
    if data.get("error"):
        print("error 字段:", json.dumps(data.get("error"), ensure_ascii=False)[:800])
    ch = data.get("choices") or []
    print("choices 数量:", len(ch))
    if ch:
        msg = (ch[0] or {}).get("message") or {}
        print("message keys:", list(msg.keys()))
        c = msg.get("content")
        print("content 类型:", type(c).__name__, "预览:", str(c)[:200])
    if data.get("responseData") is not None:
        rd = data.get("responseData")
        print("responseData 类型:", type(rd).__name__)
        print("responseData 预览:", json.dumps(rd, ensure_ascii=False)[:600])

    parsed = fastgpt_client._extract_any_reply(data)  # noqa: SLF001
    print("---")
    print("本客户端解析结果长度:", len(parsed))
    print("解析预览:", parsed[:400] if parsed else "(空)")


if __name__ == "__main__":
    main()
