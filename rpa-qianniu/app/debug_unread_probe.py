"""
未读检测调试：遍历左侧会话行子树，将 ControlType / Name / ClassName / AutomationId / 矩形写入 debug 目录。
启用：.env 设 DEBUG_UNREAD_PROBE=true
"""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path

import uiautomation as auto

from app.config import settings
from app.qianniu_driver import capture_window_frame_bgr, list_session_list_items
from app.ui_selectors import get_selectors

log = logging.getLogger("debug_unread_probe")

_CONTROL = auto.Control

_KEYWORD_HINTS = (
    "unread",
    "badge",
    "count",
    "dot",
    "未读",
    "待回复",
    "新消息",
    "条未读",
    "红点",
)


def _fmt_rect(r: auto.Rect) -> str:
    try:
        return (
            f"L={r.left:.0f} T={r.top:.0f} R={r.right:.0f} B={r.bottom:.0f} "
            f"W={r.right - r.left:.0f} H={r.bottom - r.top:.0f}"
        )
    except Exception:
        return "(rect err)"


def _hint_suffix(name: str, aid: str, cn: str) -> str:
    blob = f"{name}\t{aid}\t{cn}".lower()
    hits = [k for k in _KEYWORD_HINTS if k.lower() in blob]
    return f"  <<<< MATCH: {', '.join(hits)}" if hits else ""


def _walk_limited(root: _CONTROL, *, max_depth: int) -> list[tuple[int, _CONTROL]]:
    out: list[tuple[int, _CONTROL]] = []

    def rec(c: _CONTROL, d: int) -> None:
        if d > max_depth:
            return
        out.append((d, c))
        ch = c.GetFirstChildControl()
        while ch:
            rec(ch, d + 1)
            ch = ch.GetNextSiblingControl()

    rec(root, 0)
    return out


def _dump_control_line(c: _CONTROL, depth: int) -> str:
    try:
        ct_name = str(c.ControlType)
    except Exception:
        ct_name = "?"
    try:
        name = (c.Name or "").replace("\r", " ").replace("\n", " ")
    except Exception:
        name = ""
    try:
        cn = (getattr(c, "ClassName", None) or "") or ""
    except Exception:
        cn = ""
    try:
        aid = (getattr(c, "AutomationId", None) or "") or ""
    except Exception:
        aid = ""
    try:
        r = c.BoundingRectangle
        rect_s = _fmt_rect(r)
    except Exception:
        rect_s = "(no rect)"
    suf = _hint_suffix(name, aid, cn)
    ind = "  " * min(depth, 24)
    return f"{ind}[d={depth}] {ct_name} | Name={name!r} | ClassName={cn!r} | AutomationId={aid!r} | {rect_s}{suf}"


def run_unread_probe(win: _CONTROL) -> Path | None:
    """
    生成 debug/{timestamp}_unread_probe.log，并保存左侧列截图 {timestamp}_unread_left_panel.png。
    返回日志路径；失败返回 None。
    """
    if not settings.debug_unread_probe:
        return None
    root = Path(settings.debug_probe_dir)
    try:
        root.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        log.warning("无法创建调试目录 %s: %s", root, exc)
        return None

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = root / f"{ts}_unread_probe.log"
    lines: list[str] = []
    sel = get_selectors()
    lines.append(f"=== 千牛未读探针 {ts} ===")
    lines.append(f"selectors_path={settings.selectors_path}")
    lines.append(f"session_left_panel_ratio={sel.session_left_panel_ratio}")
    lines.append(f"unread_markers={sel.unread_markers}")
    lines.append(f"unread_badge_numeric={sel.unread_badge_numeric}")
    lines.append("")

    items = list_session_list_items(win)
    lines.append(f"list_session_list_items: count={len(items)}")
    max_sub_depth = min(18, max(10, sel.tree_walk_max_depth // 2))

    for i, item in enumerate(items):
        try:
            iname = (item.Name or "").strip()
        except Exception:
            iname = ""
        lines.append("")
        lines.append(f"--- 会话行 #{i} Name={iname!r} ---")
        try:
            lines.append(_dump_control_line(item, 0))
        except Exception as exc:
            lines.append(f"(row dump err: {exc})")
        for depth, c in _walk_limited(item, max_depth=max_sub_depth):
            if depth == 0:
                continue
            try:
                lines.append(_dump_control_line(c, depth))
            except Exception as exc:
                lines.append(f"  (child err: {exc})")

    # 左侧整带截图（窗口坐标）
    bgr = capture_window_frame_bgr(win)
    shot_name = f"{ts}_unread_left_panel.png"
    shot_path = root / shot_name
    if bgr is not None and bgr.size > 0:
        try:
            import cv2

            wr = win.BoundingRectangle
            ww = max(1, int(wr.right - wr.left))
            wh = max(1, int(wr.bottom - wr.top))
            ratio = float(sel.session_left_panel_ratio)
            x1 = max(2, int(ww * ratio))
            left_strip = bgr[0:wh, 0:x1]
            cv2.imwrite(str(shot_path), left_strip)
            lines.append("")
            lines.append(f"左侧列表截图已保存: {shot_path} (crop width={x1}px / window={ww}px)")
        except Exception as exc:
            lines.append(f"左侧截图失败: {exc}")
    else:
        lines.append("整窗截图为空，跳过左侧条带保存")

    try:
        log_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except Exception as exc:
        log.warning("写入探针日志失败: %s", exc)
        return None

    log.info("未读探针已写入 %s", log_path)
    print(f"[调试] 未读探针日志: {log_path}")
    print(f"[调试] 若需改未读规则，请把日志中含 <<<< MATCH 或角标相关行发给维护者，并同步改 config/selectors.json")
    return log_path
