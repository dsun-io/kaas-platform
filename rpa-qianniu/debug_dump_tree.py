#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
独立调试：dump 千牛「接待中心」窗口控件树（最多 5 层），写入 debug/control_tree.txt。

运行（在 rpa-qianniu 目录下）:
  python debug_dump_tree.py

无业务依赖，仅需: pip install uiautomation
"""

from __future__ import annotations

import sys
from pathlib import Path

import uiautomation as auto

# 仅遍历 5 个层级：depth 0..4
_MAX_DEPTH = 5
# 窗口标题需包含（与业务里「接待中心」一致）
_TITLE_SUBSTRING = "接待中心"
_OUT_REL = Path("debug/control_tree.txt")


def _truncate(s: str, n: int = 50) -> str:
    s = (s or "").replace("\r", " ").replace("\n", " ")
    if len(s) <= n:
        return s
    return s[: n - 1] + "…"


def _rect_xywh(r: auto.Rect) -> tuple[int, int, int, int]:
    try:
        w = int(r.right - r.left)
        h = int(r.bottom - r.top)
        return (int(r.left), int(r.top), max(0, w), max(0, h))
    except Exception:
        return (0, 0, 0, 0)


def _find_reception_window() -> auto.Control | None:
    try:
        root = auto.GetRootControl()
    except Exception:
        return None
    for c in root.GetChildren():
        try:
            if c.ControlType != auto.ControlType.WindowControl:
                continue
            name = c.Name or ""
            if _TITLE_SUBSTRING in name:
                return c
        except Exception:
            continue
    return None


def _is_star(
    ct: auto.ControlType,
    name: str,
    class_name: str,
    automation_id: str,
) -> bool:
    """在行首加 ★ 的重点标记规则。"""
    n = name or ""
    cn = class_name or ""
    aid = (automation_id or "").lower()

    try:
        if ct == auto.ControlType.EditControl:
            return True
    except Exception:
        pass

    if "发送" in n:
        return True
    if "未读" in n:
        return True
    # 常见角标/未读相关文案（无视觉时近似「红色角标特征」）
    for hint in ("待回复", "新消息", "条未读", "条新消息", "秒前", "分钟前", "刚刚"):
        if hint in n:
            return True
    if aid:
        for h in ("unread", "badge", "dot", "count", "newmsg", "tip", "remind"):
            if h in aid:
                return True

    cn_l = cn.lower()
    if "richedit" in cn_l or "textbox" in cn_l:
        return True

    return False


def _line_for_control(c: auto.Control, depth: int) -> str:
    try:
        ct = str(c.ControlType)
    except Exception:
        ct = "?"
    try:
        cn = (getattr(c, "ClassName", None) or "") or ""
    except Exception:
        cn = ""
    try:
        name = _truncate((c.Name or ""), 50)
    except Exception:
        name = ""
    try:
        aid = (getattr(c, "AutomationId", None) or "") or ""
    except Exception:
        aid = ""
    try:
        r = c.BoundingRectangle
        x, y, w, h = _rect_xywh(r)
        rect_s = f"x={x} y={y} w={w} h={h}"
    except Exception:
        rect_s = "x=? y=? w=? h=?"

    star = "★ " if _is_star(c.ControlType, c.Name or "", cn, aid) else "  "
    indent = "  " * depth
    return (
        f"{star}{indent}[{depth}] {ct} | ClassName={cn!r} | "
        f"Name={name!r} | AutomationId={aid!r} | {rect_s}"
    )


def _walk(c: auto.Control, depth: int, lines: list[str]) -> None:
    if depth >= _MAX_DEPTH:
        return
    try:
        lines.append(_line_for_control(c, depth))
    except Exception as exc:
        lines.append(f"  {'  ' * depth}[{depth}] <dump err: {exc}>")

    try:
        ch = c.GetFirstChildControl()
    except Exception:
        return
    while ch:
        _walk(ch, depth + 1, lines)
        try:
            ch = ch.GetNextSiblingControl()
        except Exception:
            break


def main() -> int:
    out = Path(_OUT_REL)
    out.parent.mkdir(parents=True, exist_ok=True)

    win = _find_reception_window()
    if win is None:
        msg = (
            f"未找到标题含 {_TITLE_SUBSTRING!r} 的顶层窗口。"
            "请确认「接待中心」已打开且窗口标题可见。"
        )
        out.write_text(msg + "\n", encoding="utf-8")
        print(msg, file=sys.stderr)
        print(f"已写入: {out.resolve()}")
        return 1

    try:
        wtitle = win.Name or ""
    except Exception:
        wtitle = ""

    lines: list[str] = [
        f"# 千牛控件树 dump | 窗口: {wtitle!r}",
        f"# 最大深度: {_MAX_DEPTH}（depth 0..{_MAX_DEPTH - 1}）",
        "",
    ]
    _walk(win, 0, lines)
    text = "\n".join(lines) + "\n"
    out.write_text(text, encoding="utf-8")
    print(f"已写入 {len(lines)} 行 -> {out.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
