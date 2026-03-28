"""
左侧列表：主流程用 OCR 找「待回复」分组并点击首条会话；
保留 HSV 红点检测（detect_unread_dots）供 smoke/调试。
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from app.config import settings
from app.debug_manager import should_save
from app.logger import get_logger
from app.ocr_paddle import OcrTextBox, ocr_bgr_to_boxes, paddle_available
from app.vision_coords import (
    bgr_crop_origin_to_screen,
    bgr_point_to_screen,
    crop_window_bgr,
    screen_point_to_bgr_xy,
)
from app.vision_debug import save_debug_bgr
from app.vision_layout import ScreenRect

log = get_logger("vision_unread")

DWMWA_EXTENDED_FRAME_BOUNDS = 9


def get_screenshot_origin(hwnd: int) -> tuple[int, int]:
    """BGR 像素 (0,0) 对应屏幕点：优先 DWM 可见边框，避免 GetWindowRect 含阴影导致点击偏行。"""
    if sys.platform != "win32" or not hwnd:
        raise ValueError("get_screenshot_origin requires win32 HWND")
    import ctypes
    from ctypes import wintypes

    class RECT(ctypes.Structure):
        _fields_ = [
            ("left", ctypes.c_long),
            ("top", ctypes.c_long),
            ("right", ctypes.c_long),
            ("bottom", ctypes.c_long),
        ]

    r = RECT()
    hr = ctypes.windll.dwmapi.DwmGetWindowAttribute(
        wintypes.HWND(hwnd),
        DWMWA_EXTENDED_FRAME_BOUNDS,
        ctypes.byref(r),
        ctypes.sizeof(r),
    )
    if hr == 0:
        return int(r.left), int(r.top)
    rr = RECT()
    ctypes.windll.user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rr))
    return int(rr.left), int(rr.top)


def align_win_rect_to_screenshot_origin(win: ScreenRect, hwnd: int | None) -> ScreenRect:
    """将 UIA 窗口矩形平移到 DWM 截图原点，后续布局与 BGR 换算一致。"""
    if not hwnd or sys.platform != "win32":
        return win
    try:
        ox, oy = get_screenshot_origin(hwnd)
    except Exception:
        return win
    dx = ox - win.left
    dy = oy - win.top
    return ScreenRect(
        win.left + dx,
        win.top + dy,
        win.right + dx,
        win.bottom + dy,
    )


def find_pending_session(
    bgr: np.ndarray,
    win: ScreenRect,
    left: ScreenRect,
    _hwnd: int | None,
) -> tuple[int, int] | None:
    """
    OCR 左栏，找「待回复」分组下首条会话：点击「待回复」与「已回复」标签之间的竖直中点（屏幕坐标）。
    无待回复或数量为 0 时返回 None。
    """
    if not paddle_available():
        log.info("[会话检测] Paddle 不可用")
        return None
    crop, ox, oy = crop_window_bgr(bgr, win, left)
    save_debug_bgr(crop, "unread_left_crop")
    if crop.size == 0:
        return None
    sx0, sy0 = bgr_crop_origin_to_screen(win, bgr, ox, oy)
    boxes = ocr_bgr_to_boxes(
        crop,
        win_left=sx0,
        win_top=sy0,
        cache_ttl_sec=0.0,
    )
    if not boxes:
        log.info("[会话检测] 左侧面板 OCR 无结果")
        return None

    pending_bottom: int | None = None
    pending_top: int | None = None
    pending_count_zero = False
    replied_top: int | None = None

    # 同时扫描「待回复」和「已回复」两个标签
    for b in boxes:
        raw = (b.text or "").strip()
        t = re.sub(r"\s+", "", raw)

        # 检测「待回复」标签
        if "待回复" in t or "待回复" in raw:
            m = re.search(r"[\(（]\s*(\d+)\s*[\)）]", raw)
            if m and int(m.group(1)) == 0:
                log.info("[会话检测] 待回复数量为 0: %r", raw)
                pending_count_zero = True
            else:
                pending_bottom = b.bottom if pending_bottom is None else max(pending_bottom, b.bottom)
                pending_top = b.top if pending_top is None else min(pending_top, b.top)

        # 检测「已回复」标签（不依赖 pending_bottom）
        if "已回复" in t or "已回复" in raw:
            # 取所有已回复标签的最小 top
            replied_top = b.top if replied_top is None else min(replied_top, b.top)

    # 检测「已回复」分组中带有橙色时间气泡的会话（买家再次发消息后会产生）
    # 优先级：橙色气泡 > 待回复首条（橙色气泡代表买家再次催促，时效性更高）
    replied_session = _find_replied_with_orange_badge(
        bgr, win, left, _hwnd, pending_bottom, replied_top
    )
    if replied_session:
        log.info(
            "[会话检测] 发现已回复分组有新消息: 屏幕点击=(%s,%s)",
            replied_session[0],
            replied_session[1],
        )
        return replied_session

    # 当「待回复」存在且有会话时，点击待回复首条
    if pending_bottom is not None and not pending_count_zero:
        click_sx = (left.left + left.right) // 2
        if replied_top is not None and replied_top > pending_bottom:
            click_sy = (pending_bottom + replied_top) // 2
        else:
            click_sy = pending_bottom + max(40, min(80, left.h // 14))

        log.info(
            "[会话检测] 待回复底=%s 已回复顶=%s → 屏幕点击=(%s,%s)",
            pending_bottom,
            replied_top,
            click_sx,
            click_sy,
        )

        if should_save("unread_detected"):
            try:
                root = Path(settings.vision_debug_dir)
                root.mkdir(parents=True, exist_ok=True)
                ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
                dbg = crop.copy()
                ch, cw = dbg.shape[:2]
                bw, bh = bgr.shape[1], bgr.shape[0]
                ww, wh = max(1, win.w), max(1, win.h)
                bx = (click_sx - win.left) * bw / ww
                by = (click_sy - win.top) * bh / wh
                lcx = int(bx - ox)
                lcy = int(by - oy)
                pb = int((pending_bottom - win.top) * bh / wh - oy)
                rt = (
                    int((replied_top - win.top) * bh / wh - oy)
                    if replied_top is not None
                    else None
                )
                if 0 <= pb < ch:
                    cv2.line(dbg, (0, pb), (cw, pb), (0, 255, 0), 1)
                if rt is not None and 0 <= rt < ch:
                    cv2.line(dbg, (0, rt), (cw, rt), (255, 0, 0), 1)
                lcx = max(0, min(cw - 1, lcx))
                lcy = max(0, min(ch - 1, lcy))
                cv2.drawMarker(
                    dbg,
                    (lcx, lcy),
                    (0, 0, 255),
                    markerType=cv2.MARKER_CROSS,
                    markerSize=18,
                    thickness=2,
                )
                cv2.imwrite(str(root / f"{ts}_pending_session.png"), dbg)
            except Exception:
                pass

        return int(click_sx), int(click_sy)

    # 待回复为空且已回复无橙色气泡
    log.info("[会话检测] 待回复为空且已回复无橙色气泡，无会话需要处理")
    return None


def _unread_badge_mask(bgr: np.ndarray) -> np.ndarray | None:
    """
    未读：纯红 + 千牛常见的橙/珊瑚角标（H 约 5–20°）。
    S/V 略放宽以覆盖浅色主题。
    """
    if bgr.size == 0 or bgr.ndim != 3:
        return None
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    m1 = cv2.inRange(hsv, (0, 100, 100), (10, 255, 255))
    m2 = cv2.inRange(hsv, (170, 100, 100), (180, 255, 255))
    red = cv2.bitwise_or(m1, m2)
    orange = cv2.inRange(hsv, (5, 85, 85), (22, 255, 255))
    return cv2.bitwise_or(red, orange)


def _orange_time_badge_mask(bgr: np.ndarray) -> np.ndarray | None:
    """
    已回复分组中的橙色时间气泡（如「33秒」「2分钟」）检测。
    千牛橙色时间气泡 H 约 10-25°，饱和度较高。
    """
    if bgr.size == 0 or bgr.ndim != 3:
        return None
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    # 橙色时间气泡的HSV范围（比红点更宽的橙色范围）
    orange = cv2.inRange(hsv, (8, 80, 80), (25, 255, 255))
    # 同时包含红色（部分时间气泡偏红）
    m1 = cv2.inRange(hsv, (0, 80, 80), (10, 255, 255))
    m2 = cv2.inRange(hsv, (170, 80, 80), (180, 255, 255))
    red = cv2.bitwise_or(m1, m2)
    return cv2.bitwise_or(orange, red)


@dataclass
class UnreadDot:
    """屏幕坐标：点击目标（左栏水平中心 × 红点所在行）。"""

    cx_screen: int
    cy_screen: int
    buyer: str


def _save_dots_and_clicks_debug(
    bgr: np.ndarray,
    win: ScreenRect,
    _session_rect: ScreenRect,
    crop_x0: int,
    crop_y0: int,
    crop: np.ndarray,
    cx: float,
    cy: float,
    click_sx: int,
    click_sy: int,
) -> None:
    if not should_save("unread_detected"):
        return
    root = Path(settings.vision_debug_dir)
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError:
        return
    ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
    overlay = bgr.copy()
    try:
        dot_bx = int(crop_x0 + cx)
        dot_by = int(crop_y0 + cy)
        cx_d = max(0, min(bgr.shape[1] - 1, dot_bx))
        cy_d = max(0, min(bgr.shape[0] - 1, dot_by))
        cv2.circle(overlay, (cx_d, cy_d), 12, (0, 255, 0), 2)
        cv2.putText(
            overlay,
            "DOT",
            (min(bgr.shape[1] - 40, cx_d + 14), cy_d),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            (0, 255, 0),
            1,
            cv2.LINE_AA,
        )
        clk_x, clk_y = screen_point_to_bgr_xy(win, bgr, click_sx, click_sy)
        clk_x = max(0, min(bgr.shape[1] - 1, clk_x))
        clk_y = max(0, min(bgr.shape[0] - 1, clk_y))
        cv2.drawMarker(
            overlay,
            (clk_x, clk_y),
            (0, 0, 255),
            markerType=cv2.MARKER_CROSS,
            markerSize=20,
            thickness=2,
        )
        cv2.putText(
            overlay,
            "CLICK",
            (min(bgr.shape[1] - 50, clk_x + 14), clk_y),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            (0, 0, 255),
            1,
            cv2.LINE_AA,
        )
        cv2.imwrite(str(root / f"{ts}_dots_and_clicks.png"), overlay)
    except Exception:
        return


def _session_list_region(left: ScreenRect, top_skip_px: int) -> ScreenRect:
    """左栏内跳过导航/搜索/标签条，仅对会话列表区域做红点检测与坐标换算。"""
    skip = min(max(0, top_skip_px), max(0, left.h - 48))
    return ScreenRect(left.left, left.top + skip, left.right, left.bottom)


def detect_unread_dots(
    bgr: np.ndarray,
    win: ScreenRect,
    left: ScreenRect,
) -> list[UnreadDot]:
    """
    在左侧列表区域检测未读红点，返回按 y 排序的列表（靠上优先）。
    点击位置：左栏水平中心 × 红点质心所在行（避免只点角标导致点到下一行）。
    裁剪从「会话列表」上缘开始（跳过顶栏），避免 ROI 红点 y 与点击换算错行。
    """
    session = _session_list_region(left, int(settings.vision_left_panel_unread_top_skip_px))
    crop, crop_x0, crop_y0 = crop_window_bgr(bgr, win, session)
    save_debug_bgr(crop, "unread_left_crop")
    if crop.size == 0:
        return []

    mask = _unread_badge_mask(crop)
    if mask is None or mask.size == 0:
        return []
    k = max(1, min(5, crop.shape[0] // 120))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k * 2 + 1, k * 2 + 1))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    amin = int(settings.vision_unread_dot_area_min)
    amax = int(settings.vision_unread_dot_area_max)
    dots: list[tuple[float, float, float]] = []
    for cnt in contours:
        a = float(cv2.contourArea(cnt))
        if not (amin <= a <= amax):
            continue
        x, y, bw, bh = cv2.boundingRect(cnt)
        if min(bw, bh) < 2:
            continue
        rmax = max(bw, bh) / max(1.0, min(bw, bh))
        if rmax > 4.5:
            continue
        m = cv2.moments(cnt)
        if m["m00"] <= 1e-6:
            continue
        cx = float(m["m10"] / m["m00"])
        cy = float(m["m01"] / m["m00"])
        dots.append((cy, cx, a))

    dots.sort(key=lambda t: t[0])
    out: list[UnreadDot] = []
    ch, cw = crop.shape[:2]
    for idx, (cy, cx, _) in enumerate(dots):
        # 行内水平中心（左栏会话条）× 红点行 y，映射到屏幕
        row_click_bx = float(crop_x0) + float(cw) / 2.0
        row_click_by = float(crop_y0) + cy
        click_sx, click_sy = bgr_point_to_screen(win, bgr, row_click_bx, row_click_by)

        log.info(
            "[DEBUG-CLICK] 窗口=(%s,%s) left_panel=(%s,%s)-(%s,%s) session_left=(%s,%s)-(%s,%s) "
            "crop_size=(%sx%s) crop_origin_bgr=(%s,%s) ROI红点=(%.1f,%.1f) "
            "BGR点击=(%.1f,%.1f) 屏幕点击=(%s,%s)",
            win.left,
            win.top,
            left.left,
            left.top,
            left.right,
            left.bottom,
            session.left,
            session.top,
            session.right,
            session.bottom,
            cw,
            ch,
            crop_x0,
            crop_y0,
            cx,
            cy,
            row_click_bx,
            row_click_by,
            click_sx,
            click_sy,
        )

        if idx == 0:
            _save_dots_and_clicks_debug(
                bgr,
                win,
                session,
                crop_x0,
                crop_y0,
                crop,
                cx,
                cy,
                click_sx,
                click_sy,
            )

        out.append(UnreadDot(cx_screen=click_sx, cy_screen=click_sy, buyer=""))

    return out


def _find_replied_with_orange_badge(
    bgr: np.ndarray,
    win: ScreenRect,
    left: ScreenRect,
    _hwnd: int | None,
    pending_bottom: int | None,
    replied_top: int | None,
) -> tuple[int, int] | None:
    """
    在「已回复」分组中检测带有橙色时间气泡的会话。
    买家再次发消息后，会话会留在「已回复」分组并显示橙色时间气泡（如「33秒」「2分钟」）。
    返回点击坐标（屏幕坐标），无则返回 None。
    """
    if not paddle_available():
        return None

    # 确定「已回复」分组区域：从「已回复」标签顶部到底部，或左栏底部
    if replied_top is None:
        log.debug("[已回复检测] 未找到已回复标签，跳过")
        return None

    # 构建「已回复」分组区域（整段会话列表）
    replied_bottom = left.bottom

    # 仅在 pending_bottom 存在时进行位置合理性校验
    if pending_bottom is not None and replied_top < pending_bottom:
        # 异常情况：已回复在待回复上方，不处理
        log.debug("[已回复检测] 已回复标签位置异常（在待回复上方），跳过")
        return None

    # 裁剪左栏区域进行 OCR
    crop, ox, oy = crop_window_bgr(bgr, win, left)
    if crop.size == 0:
        return None

    sx0, sy0 = bgr_crop_origin_to_screen(win, bgr, ox, oy)

    # OCR 获取已回复区域内的所有文本框
    boxes = ocr_bgr_to_boxes(
        crop,
        win_left=sx0,
        win_top=sy0,
        cache_ttl_sec=0.0,
    )
    if not boxes:
        log.debug("[已回复检测] OCR 无结果")
        return None

    # 在已回复区域内寻找会话行：每行右侧检测橙色时间气泡
    # 会话行特征：在已回复标签下方，通常是买家昵称/ID
    replied_region_top = replied_top

    # 筛选在已回复区域内的文本框
    session_candidates: list[tuple[OcrTextBox, int]] = []
    for b in boxes:
        if b.top <= replied_region_top:
            continue  # 跳过已回复标签本身及其上方
        if b.top >= replied_bottom:
            continue  # 跳过左栏底部之外
        # 会话行通常不是时间戳或系统文本
        t = (b.text or "").strip()
        if not t or len(t) < 2:
            continue
        # 排除明显的时间戳行（如「3分钟前」「33秒」）- 这些会在下面单独检测橙色气泡
        if re.search(r"(\d+\s*秒|\d+\s*分钟?|\d+\s*小时?|\d{1,2}:\d{2})", t):
            continue
        session_candidates.append((b, b.top))

    if not session_candidates:
        log.debug("[已回复检测] 无会话候选")
        return None

    # 按 y 坐标分组（每行会话）
    session_candidates.sort(key=lambda x: x[1])

    # 对每个会话行，检测其右侧区域的橙色像素
    for b, y in session_candidates:
        # 计算该会话行右侧区域（会话行通常在左栏中间偏右的位置结束）
        # 检测区域：从会话行文本右边界到左栏右边界，上下扩展一定范围
        right_region_left = b.right
        right_region_top = max(left.top, b.top - 5)
        right_region_bottom = min(left.bottom, b.bottom + 5)

        # 确保右侧区域有足够宽度
        if right_region_left >= left.right - 10:
            continue

        right_region = ScreenRect(
            right_region_left,
            right_region_top,
            left.right,
            right_region_bottom,
        )

        # 裁剪右侧区域
        r_crop, r_ox, r_oy = crop_window_bgr(bgr, win, right_region)
        if r_crop.size == 0:
            continue

        # 检测橙色像素
        mask = _orange_time_badge_mask(r_crop)
        if mask is None or mask.size == 0:
            continue

        orange_pixels = int(cv2.countNonZero(mask))
        log.debug(
            "[已回复检测] 会话行 %r y=%s 右侧橙色像素=%s",
            b.text,
            y,
            orange_pixels,
        )

        # 阈值：检测到足够橙色像素即认为有时间气泡
        min_orange_pixels = 30  # 最小橙色像素数
        if orange_pixels >= min_orange_pixels:
            # 点击位置：会话行水平中心，垂直位置取会话行中间
            click_sx = (left.left + left.right) // 2
            click_sy = (b.top + b.bottom) // 2
            log.info(
                "[会话检测] 已回复分组新消息: 会话=%r 屏幕点击=(%s,%s) 橙色像素=%s",
                b.text,
                click_sx,
                click_sy,
                orange_pixels,
            )
            return int(click_sx), int(click_sy)

    log.debug("[已回复检测] 未检测到橙色时间气泡")
    return None
