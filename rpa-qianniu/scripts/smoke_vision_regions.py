#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一次性：截取千牛窗口，在图上画出 vision 分区（左/聊/右、message_area、input_area），写入 debug/。
不进入主循环。联调步骤 1 用。

  cd rpa-qianniu
  .venv\\Scripts\\python.exe smoke_vision_regions.py
  .venv\\Scripts\\python.exe smoke_vision_regions.py --mode ratio
  .venv\\Scripts\\python.exe smoke_vision_regions.py --mode calibrate --fresh
  .venv\\Scripts\\python.exe smoke_vision_regions.py --mode unread
  .venv\\Scripts\\python.exe smoke_vision_regions.py --mode message
  .venv\\Scripts\\python.exe smoke_vision_regions.py --mode reply --text "测试"
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from app.config import settings
from app.logger import setup_logging
from app.qianniu_driver import (
    capture_window_frame_bgr,
    locate_main_window_with_retry,
    locate_window_title_hint,
)
from app.vision_message import OcrLineVisual, extract_latest_buyer_message_detail
from app.vision_reply import send_reply_vision
from app.vision_unread import UnreadDot, detect_unread_dots
from app.vision_layout import VisionLayout, build_vision_layout, layout_from_rect, rect_from_window


def _write_smoke_debug_log(out_png: Path, *, mode: str, lay: VisionLayout) -> Path:
    """与调试图同时间戳的文本日志，便于在 debug/ 目录对照查看。"""
    p = out_png.with_suffix(".log")

    def _line(name: str, r) -> str:
        wpx = max(0, int(r.right - r.left))
        hpx = max(0, int(r.bottom - r.top))
        return (
            f"{name}: ({r.left},{r.top})-({r.right},{r.bottom}) "
            f"screen | w={wpx}px h={hpx}px"
        )

    lines = [
        f"time_utc={datetime.now().astimezone().isoformat()}",
        f"mode={mode}",
        f"cal_source={lay.cal_source}",
        f"window: ({lay.window.left},{lay.window.top})-({lay.window.right},{lay.window.bottom}) "
        f"screen | w={lay.window.w} h={lay.window.h}",
        _line("left_nav_strip", lay.left_nav_strip),
        _line("left_panel", lay.left_panel),
        _line("chat_panel", lay.chat_panel),
        _line("right_panel", lay.right_panel),
        _line("message_area", lay.message_area),
        _line("input_area", lay.input_area),
        f"send_button_center_screen={lay.send_button_center_screen}",
        f"screenshot_png={out_png.resolve()}",
    ]
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return p


def _write_unread_smoke_log(
    out_png: Path,
    *,
    lay: VisionLayout,
    dots: list[UnreadDot],
) -> Path:
    p = out_png.with_suffix(".log")
    lines = [
        f"time_utc={datetime.now().astimezone().isoformat()}",
        f"mode=unread",
        f"cal_source={lay.cal_source}",
        f"left_panel=({lay.left_panel.left},{lay.left_panel.top})-"
        f"({lay.left_panel.right},{lay.left_panel.bottom})",
        f"dots_count={len(dots)}",
    ]
    for i, d in enumerate(dots):
        lines.append(
            f"  [{i}] screen=({d.cx_screen},{d.cy_screen}) buyer={d.buyer!r}"
        )
    lines.append(f"screenshot_png={out_png.resolve()}")
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return p


def _draw_unread_overlay(
    vis: np.ndarray,
    win,
    left,
    dots: list[UnreadDot],
) -> None:
    """在窗口坐标截图上画 left_panel 框与红点（win 为 ScreenRect）。"""
    wl, wt = win.left, win.top

    def _scr_to_img(sx: int, sy: int) -> tuple[int, int]:
        return int(sx - wl), int(sy - wt)

    x0, y0 = _scr_to_img(left.left, left.top)
    x1, y1 = _scr_to_img(left.right, left.bottom)
    h, w = vis.shape[:2]
    x0, x1 = max(0, x0), min(w - 1, x1)
    y0, y1 = max(0, y0), min(h - 1, y1)
    cv2.rectangle(vis, (x0, y0), (x1, y1), (255, 255, 0), 2)
    cv2.putText(
        vis,
        "left_panel (unread ROI)",
        (x0 + 4, max(18, y0 + 18)),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.5,
        (255, 255, 0),
        1,
        cv2.LINE_AA,
    )
    for i, d in enumerate(dots):
        ix, iy = _scr_to_img(d.cx_screen, d.cy_screen)
        ix = max(0, min(w - 1, ix))
        iy = max(0, min(h - 1, iy))
        cv2.circle(vis, (ix, iy), 14, (0, 0, 255), 2)
        cv2.drawMarker(vis, (ix, iy), (0, 255, 255), cv2.MARKER_CROSS, 20, 2)
        label = f"#{i}"
        if d.buyer:
            label += f" {d.buyer[:20]}"
        cv2.putText(
            vis,
            label,
            (ix + 16, max(16, iy - 6)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            (0, 0, 255),
            1,
            cv2.LINE_AA,
        )


def _write_message_smoke_log(
    out_png: Path,
    *,
    lay: VisionLayout,
    msg: dict | None,
    cluster_n: int,
) -> Path:
    p = out_png.with_suffix(".log")
    lines = [
        f"time_utc={datetime.now().astimezone().isoformat()}",
        f"mode=message",
        f"cal_source={lay.cal_source}",
        f"message_area=({lay.message_area.left},{lay.message_area.top})-"
        f"({lay.message_area.right},{lay.message_area.bottom})",
        f"latest_buyer_cluster_lines={cluster_n}",
    ]
    if msg:
        lines.append("latest_buyer_json=" + json.dumps(msg, ensure_ascii=False))
    else:
        lines.append("latest_buyer_json=null")
    lines.append(f"screenshot_png={out_png.resolve()}")
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return p


def _draw_message_overlay(
    vis: np.ndarray,
    win,
    message_area,
    visuals: list[OcrLineVisual],
    cluster: list,
) -> None:
    """在窗口截图上画 message_area 与各 OCR 框（买家绿 / 客服品红 / 未知灰；最新买家簇加粗青框）。"""
    wl, wt = win.left, win.top
    h, w_img = vis.shape[:2]

    def _scr_to_img(sx: int, sy: int) -> tuple[int, int]:
        return int(sx - wl), int(sy - wt)

    x0, y0 = _scr_to_img(message_area.left, message_area.top)
    x1, y1 = _scr_to_img(message_area.right, message_area.bottom)
    x0, x1 = max(0, x0), min(w_img - 1, x1)
    y0, y1 = max(0, y0), min(h - 1, y1)
    cv2.rectangle(vis, (x0, y0), (x1, y1), (0, 128, 255), 2)
    cv2.putText(
        vis,
        "message_area (OCR)",
        (x0 + 4, max(18, y0 + 18)),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.5,
        (0, 128, 255),
        1,
        cv2.LINE_AA,
    )

    cluster_ids = {id(b) for b in cluster}
    for v in visuals:
        b = v.box
        col = {
            "buyer": (0, 200, 0),
            "seller": (200, 80, 200),
            "unknown": (140, 140, 140),
        }.get(v.role, (140, 140, 140))
        a0, b0 = _scr_to_img(b.left, b.top)
        a1, b1 = _scr_to_img(b.right, b.bottom)
        th = 3 if id(b) in cluster_ids else 1
        cv2.rectangle(
            vis,
            (max(0, a0), max(0, b0)),
            (min(w_img - 1, a1), min(h - 1, b1)),
            col,
            th,
        )
        cv2.putText(
            vis,
            v.role[:1].upper(),
            (max(0, a0) + 2, max(14, b0 + 14)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.4,
            col,
            1,
            cv2.LINE_AA,
        )


def _to_img_xy(win, r) -> tuple[int, int, int, int]:
    wl, wt = win.left, win.top
    return (
        int(r.left - wl),
        int(r.top - wt),
        int(r.right - wl),
        int(r.bottom - wt),
    )


def main() -> int:
    setup_logging()
    ap = argparse.ArgumentParser(
        description="千牛 vision：ratio / calibrate / unread / message（消息区 OCR）"
    )
    ap.add_argument(
        "--mode",
        choices=("ratio", "calibrate", "unread", "message", "reply"),
        default="calibrate",
        help="message：OCR 买家消息；reply：输入框粘贴并点发送（真实发消息）",
    )
    ap.add_argument(
        "--fresh",
        action="store_true",
        help="calibrate/unread/message/reply：删除 vision 校准缓存后重新 OCR",
    )
    ap.add_argument(
        "--text",
        default="这是一条测试回复",
        help="仅 mode=reply：要发送的文本",
    )
    args = ap.parse_args()

    Path(settings.vision_debug_dir).mkdir(parents=True, exist_ok=True)
    if args.mode in ("calibrate", "unread", "message", "reply") and args.fresh:
        cal_path = Path(settings.vision_calibration_path)
        if cal_path.is_file():
            try:
                cal_path.unlink()
                print(f"已删除校准缓存: {cal_path.resolve()}")
            except OSError as exc:
                print(f"删除校准缓存失败: {exc}")
    win = locate_main_window_with_retry()
    if win is None:
        print("未找到千牛窗口（脚本只匹配「顶层窗口标题」中的关键字，与界面是否在 CEF 内无关）。")
        print(locate_window_title_hint())
        return 1
    bgr = capture_window_frame_bgr(win)
    if bgr is None or bgr.size == 0:
        print("截图失败。")
        return 1

    wr = rect_from_window(win)
    if args.mode == "ratio":
        lay = layout_from_rect(wr)
    else:
        lay = build_vision_layout(wr, bgr, win)

    if args.mode == "unread":
        dots = detect_unread_dots(bgr, wr, lay.left_panel)
        vis = bgr.copy()
        _draw_unread_overlay(vis, wr, lay.left_panel, dots)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        out = Path(settings.vision_debug_dir) / f"{ts}_unread_detect.png"
        cv2.imwrite(str(out), vis)
        log_path = _write_unread_smoke_log(out, lay=lay, dots=dots)
        print(f"已写入: {out.resolve()} | dots={len(dots)} cal_source={lay.cal_source}")
        print(f"同目录日志: {log_path.resolve()}")
        print("请确认：黄框为 left_panel；红圈+十字为检测到的未读红点（自上而下 #0,#1,…）。")
        return 0

    if args.mode == "message":
        msg, cluster, visuals = extract_latest_buyer_message_detail(
            bgr, wr, lay.message_area
        )
        vis = bgr.copy()
        _draw_message_overlay(vis, wr, lay.message_area, visuals, cluster)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        out = Path(settings.vision_debug_dir) / f"{ts}_message_extract.png"
        cv2.imwrite(str(out), vis)
        log_path = _write_message_smoke_log(
            out, lay=lay, msg=msg, cluster_n=len(cluster)
        )
        print(
            f"已写入: {out.resolve()} | cal_source={lay.cal_source} "
            f"latest_buyer={'yes' if msg else 'no'}"
        )
        if msg:
            print(f"  text: {msg.get('text', '')[:200]!r}")
            print(f"  timestamp: {msg.get('timestamp', '')!r}")
        print(f"同目录日志: {log_path.resolve()}")
        print("图例：橙框=message_area；绿=买家行；品红=客服；灰=中间/未知；青粗框=最新买家簇。")
        return 0

    if args.mode == "reply":
        body = (args.text or "").strip()
        if not body:
            print("reply 模式需要非空 --text")
            return 2
        ok = send_reply_vision(
            bgr,
            wr,
            lay.input_area,
            body,
            send_button_screen=lay.send_button_center_screen,
        )
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        out = Path(settings.vision_debug_dir) / f"{ts}_reply_smoke.txt"
        out.write_text(
            f"ok={ok}\ntext={body!r}\nsend_button={lay.send_button_center_screen}\n",
            encoding="utf-8",
        )
        print(f"send_reply_vision ok={ok} 记录: {out.resolve()}")
        print("若 ok=True，请在千牛聊天窗口确认是否出现上述文本。")
        return 0 if ok else 3

    vis = bgr.copy()

    def box(rect, color: tuple[int, int, int], label: str) -> None:
        x0, y0, x1, y1 = _to_img_xy(wr, rect)
        x0 = max(0, min(vis.shape[1] - 1, x0))
        x1 = max(0, min(vis.shape[1], x1))
        y0 = max(0, min(vis.shape[0] - 1, y0))
        y1 = max(0, min(vis.shape[0], y1))
        cv2.rectangle(vis, (x0, y0), (x1, y1), color, 2)
        cv2.putText(
            vis,
            label,
            (x0 + 4, max(16, y0 + 18)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            color,
            1,
            cv2.LINE_AA,
        )

    # BGR（黄=left 会话列表；青=left 图标栏，未读检测不扫此条）
    box(lay.left_nav_strip, (255, 255, 0), "left_nav_icons")
    box(lay.left_panel, (0, 255, 255), "left_panel_session_list")
    box(lay.chat_panel, (0, 200, 0), "chat_panel")
    box(lay.right_panel, (200, 200, 200), "right_panel")
    box(lay.message_area, (0, 128, 255), "message_area")
    box(lay.input_area, (255, 0, 255), "input_area")

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    suffix = "ratio" if args.mode == "ratio" else "calibrate"
    out = Path(settings.vision_debug_dir) / f"{ts}_smoke_vision_regions_{suffix}.png"
    cv2.imwrite(str(out), vis)
    log_path = _write_smoke_debug_log(out, mode=args.mode, lay=lay)
    print(f"已写入: {out.resolve()} | mode={args.mode} cal_source={lay.cal_source}")
    print(f"同目录日志: {log_path.resolve()}")
    print(
        "请检查：左栏是否包住会话列表；紫框 input_area 是否覆盖底栏「输入+发送」；"
        "橙框 message_area 是否主要为气泡区。"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
