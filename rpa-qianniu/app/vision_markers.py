from __future__ import annotations

"""
千牛左侧「待回复」列表的视觉标记（与截图中红框示意一致）：
- 头像左上角未读红点（小圆斑）
- 名称旁等待时长红/珊瑚色圆角条（常见含「N秒」）

在会话行子图内做 HSV 色域 + 轮廓筛选，不依赖 OCR。
"""

import numpy as np

try:
    import cv2
except ImportError:
    cv2 = None  # type: ignore[misc, assignment]


def _red_sat_mask_bgr(bgr: np.ndarray) -> np.ndarray | None:
    if cv2 is None or bgr.size == 0 or bgr.ndim != 3 or bgr.shape[2] != 3:
        return None
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    # 正红 + 偏粉/珊瑚（千牛角标常见）
    m1 = cv2.inRange(hsv, (0, 55, 55), (12, 255, 255))
    m2 = cv2.inRange(hsv, (168, 55, 55), (180, 255, 255))
    m3 = cv2.inRange(hsv, (0, 35, 120), (25, 255, 255))  # 浅红/橙红高亮
    return cv2.bitwise_or(cv2.bitwise_or(m1, m2), m3)


def _strict_unread_red_mask_bgr(bgr: np.ndarray) -> np.ndarray | None:
    """
    高饱和红点（偏调试规格）：H≈0–10°、S/V 较高；与主掩码做 OR 以提高自绘红点检出。
    OpenCV H 为 0–179，10°≈5；另并上高 H 端红。
    """
    if cv2 is None or bgr.size == 0 or bgr.ndim != 3 or bgr.shape[2] != 3:
        return None
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    m_lo = cv2.inRange(hsv, (0, 150, 150), (8, 255, 255))
    m_hi = cv2.inRange(hsv, (172, 150, 150), (180, 255, 255))
    return cv2.bitwise_or(m_lo, m_hi)


def _combined_red_mask(bgr: np.ndarray) -> np.ndarray | None:
    a = _red_sat_mask_bgr(bgr)
    b = _strict_unread_red_mask_bgr(bgr)
    if a is None:
        return b
    if b is None:
        return a
    return cv2.bitwise_or(a, b)


def _largest_cc_area(mask: np.ndarray) -> tuple[int, tuple[int, int, int, int] | None]:
    """返回最大连通域面积与外接矩形 (x,y,w,h)。"""
    if cv2 is None or mask.size == 0:
        return 0, None
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    best = 0
    best_box: tuple[int, int, int, int] | None = None
    for i in range(1, n):
        a = int(stats[i, cv2.CC_STAT_AREA])
        if a > best:
            best = a
            x = int(stats[i, cv2.CC_STAT_LEFT])
            y = int(stats[i, cv2.CC_STAT_TOP])
            w = int(stats[i, cv2.CC_STAT_WIDTH])
            h = int(stats[i, cv2.CC_STAT_HEIGHT])
            best_box = (x, y, w, h)
    return best, best_box


def session_row_visual_unread(bgr: np.ndarray) -> bool:
    """
    判断左侧列表单行截图是否含「未读/待回复」类视觉标记。
    """
    if cv2 is None or bgr.size == 0:
        return False
    h, w = bgr.shape[:2]
    if h < 8 or w < 16:
        return False

    mask_full = _combined_red_mask(bgr)
    if mask_full is None:
        return False

    # --- 1) 头像区红点：取行左侧、偏上子区域（覆盖头像角标）
    aw = max(4, int(w * 0.40))
    ah = max(4, int(h * 0.52))
    avatar = bgr[0:ah, 0:aw]
    m_av = _combined_red_mask(avatar)
    if m_av is None:
        return False
    area_dot, box_dot = _largest_cc_area(m_av)
    # 小圆点：面积与形状约束（随 DPI 变化，范围放宽）
    if box_dot is not None:
        _, _, bw, bh = box_dot
        ar = float(bw * bh)
        if 8 <= area_dot <= 900 and min(bw, bh) >= 2:
            rmax = max(bw, bh) / max(1.0, min(bw, bh))
            if rmax <= 3.2:  # 近圆或略椭圆
                return True

    # --- 2) 「N秒」类红条：行右侧中部，细长横向高饱和区域
    x0 = int(w * 0.18)
    pill = bgr[int(h * 0.12) : int(h * 0.92), x0 : w]
    if pill.size == 0:
        return False
    m_pill = _combined_red_mask(pill)
    if m_pill is None:
        return False
    # 略膨胀以连成圆角矩形
    k = max(1, min(5, h // 28))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k * 2 + 1, k + 1))
    m_pill = cv2.morphologyEx(m_pill, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(m_pill, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    ph, pw = pill.shape[:2]
    for cnt in contours:
        x, y, bw, bh = cv2.boundingRect(cnt)
        a = float(cv2.contourArea(cnt))
        if a < 35 or bh < 4 or bw < 10:
            continue
        if bh > ph * 0.85:  # 排除竖条误检
            continue
        ar = bw / max(1.0, float(bh))
        if ar >= 1.35 and a <= float(pw * ph) * 0.45:
            return True

    return False


def vision_available() -> bool:
    return cv2 is not None
