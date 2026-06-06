from __future__ import annotations

import numpy as np

try:
    from PIL import ImageGrab
except ImportError:
    ImageGrab = None  # type: ignore[misc, assignment]


def grab_screen_bgr(left: int, top: int, right: int, bottom: int) -> np.ndarray | None:
    """
    截取屏幕矩形区域，返回 BGR uint8，形状 (H, W, 3)。
    坐标与 uiautomation 的 BoundingRectangle 一致（屏幕像素）。
    """
    if ImageGrab is None:
        return None
    if right <= left + 2 or bottom <= top + 2:
        return None
    try:
        box = (int(left), int(top), int(right), int(bottom))
        img = ImageGrab.grab(bbox=box)
        rgb = np.asarray(img.convert("RGB"), dtype=np.uint8)
        # RGB -> BGR for OpenCV
        return rgb[:, :, ::-1].copy()
    except Exception:
        return None
