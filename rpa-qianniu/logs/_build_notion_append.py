"""One-off: build old_str/new_str for Notion Runner log append."""
from __future__ import annotations

from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parent
    old = (root / "_notion_old_str.txt").read_text(encoding="utf-8")
    logp = root / "rpa-qianniu.log"
    lines = logp.read_text(encoding="utf-8", errors="replace").splitlines()
    start = None
    for i in range(len(lines) - 1, -1, -1):
        if "Legacy UIA 流水线启动" in lines[i] and "b4c00862" in lines[i]:
            start = i
            break
    chunk = lines[start:] if start is not None else lines[-40:]
    filtered: list[str] = []
    for ln in chunk:
        if ln.strip().startswith('File "'):
            continue
        if "During handling" in ln and "exception" in ln.lower():
            continue
        if ln.strip().startswith("^"):
            continue
        if "Traceback (most recent call last)" in ln:
            continue
        if len(ln) > 500:
            ln = ln[:500] + "..."
        filtered.append(ln)
    if len(filtered) > 70:
        filtered = (
            filtered[:35]
            + [f"...（省略中间 {len(filtered) - 70} 行）..."]
            + filtered[-35:]
        )

    def indent_block(title: str, arr: list[str]) -> str:
        out = [f"\t\t**{title}**", "\t\t```"]
        for x in arr:
            safe = x.replace("```", "'''")
            out.append("\t\t" + safe)
        out.append("\t\t```")
        return "\n".join(out)

    body: list[str] = []
    body.append(
        "\t\t[Cursor] 2026-03-29 19:15 功能测试：最后一次运行日志摘录（来源：rpa-qianniu/logs）"
    )
    body.append("\t\t## 说明")
    body.append(
        "\t\t- 会话：Legacy UIA，`session_id=b4c00862`，启动 `2026-03-29 18:56:12`，"
        "窗口 `radiobalabala-接待中心`，AI 桩固定回复已开启。"
    )
    body.append(
        "\t\t- 现象：循环「监听 | 访客用账号 | 等待未读或新消息」；"
        "SOAK 显示「已处理 0 条消息」；该段内未出现「收到消息 / 兜底 / vision fallback / 已发送」。"
    )
    body.append(
        "\t\t- 备注：`rpa-qianniu.log` 中曾出现 `OSError: [Errno 22] Invalid argument`"
        "（logger 向 stdout flush），多见于管道/重定向关闭控制台，文件 Handler 仍写入。"
    )
    body.append("\t\t## 原文摘录")
    body.append(indent_block("rpa-qianniu.log（自本次会话启动起，已过滤长 traceback）", filtered))

    cons = (root / "console.log").read_text(encoding="utf-8", errors="replace").splitlines()
    cstart = None
    for i in range(len(cons) - 1, -1, -1):
        if "18:56:12" in cons[i] and "Legacy UIA" in cons[i]:
            cstart = i
            break
    cchunk = cons[cstart : cstart + 50] if cstart is not None else cons[-40:]
    body.append(indent_block("console.log（同会话）", cchunk))

    append = "\n".join(body)
    new_str = old + "\n\n" + append
    (root / "_notion_new_str.txt").write_text(new_str, encoding="utf-8")
    print("wrote", root / "_notion_new_str.txt", "len", len(new_str))


if __name__ == "__main__":
    main()
