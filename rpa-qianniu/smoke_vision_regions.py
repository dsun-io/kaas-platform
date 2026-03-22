#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一次性：截取千牛窗口，在图上画出 vision 分区（左/聊/右、message_area、input_area），写入 debug/。
不进入主循环。联调步骤 1 用。

  cd rpa-qianniu
  .venv\\Scripts\\python.exe smoke_vision_regions.py
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from app.config import settings
from app.qianniu_driver import (
    capture_window_frame_bgr,
    locate_main_window_with_retry,
    locate_window_title_hint,
)
from app.vision_layout import layout_from_rect, rect_from_window


def _to_img_xy(win, r) -> tuple[int, int, int, int]:
    wl, wt = win.left, win.top
    return (
        int(r.left - wl),
        int(r.top - wt),
        int(r.right - wl),
        int(r.bottom - wt),
    )


def main() -> int:
    Path(settings.vision_debug_dir).mkdir(parents=True, exist_ok=True)
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
    lay = layout_from_rect(wr)
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
    out = Path(settings.vision_debug_dir) / f"{ts}_smoke_vision_regions.png"
    cv2.imwrite(str(out), vis)
    print(f"已写入: {out.resolve()}")
    print(
        "请检查：左栏是否包住会话列表；紫框 input_area 是否覆盖底栏「输入+发送」；"
        "橙框 message_area 是否主要为气泡区。"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
