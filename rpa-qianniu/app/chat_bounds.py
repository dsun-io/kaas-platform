from __future__ import annotations

from dataclasses import dataclass

import uiautomation as auto

from app.ocr_paddle import OcrTextBox


@dataclass(frozen=True)
class ChatPanelScreen:
    """聊天主列在屏幕上的包围盒（含底部输入条区域）；所有点击/控件过滤应限制在内。"""

    left: int
    top: int
    right: int
    bottom: int
    send_left: int | None = None
    send_cy: int | None = None


def _is_chat_send_label(text: str) -> bool:
    t = (text or "").strip()
    if t == "发送":
        return True
    if t.startswith("发送") and len(t) <= 6:
        if any(x in t for x in ("链接", "商品", "宝贝", "卡片", "足迹", "优惠券")):
            return False
        return True
    return False


def compute_chat_panel_screen(
    wr: auto.Rect,
    session_right_x: float,
    ocr_boxes: list[OcrTextBox],
) -> ChatPanelScreen:
    """
    用 OCR 找底栏「发送」锚点，结合左侧会话列表右缘，得到中间聊天列包围盒。
    若无可靠锚点，退回为「列表以右 ~58% 窗宽」的保守矩形。
    """
    wl, wt = int(wr.left), int(wr.top)
    ww = max(1, int(wr.right - wr.left))
    wh = max(1, int(wr.bottom - wr.top))

    default = ChatPanelScreen(
        left=int(session_right_x),
        top=wt + int(wh * 0.09),
        right=wl + int(ww * 0.58),
        bottom=int(wr.bottom),
        send_left=None,
        send_cy=None,
    )

    candidates: list[tuple[float, OcrTextBox]] = []
    for b in ocr_boxes:
        if b.confidence < 0.5:
            continue
        if not _is_chat_send_label(b.text):
            continue
        cx = (b.left + b.right) / 2.0
        if cx < session_right_x - 30:
            continue
        if b.right > wr.right + 5:
            continue
        # 发送键应在窗口下半区
        cy = (b.top + b.bottom) / 2.0
        if cy < wr.top + wh * 0.35:
            continue
        candidates.append((float(b.bottom), b))

    if not candidates:
        return default

    candidates.sort(key=lambda x: -x[0])
    _, send_box = candidates[0]
    sl, sr = send_box.left, send_box.right
    st, sb = send_box.top, send_box.bottom
    send_cy = int((st + sb) / 2)

    chat_right = min(int(sr) + 12, wl + int(ww * 0.62))
    chat_left = int(session_right_x)
    chat_bottom = int(wr.bottom)
    # 上边界：发送条上方留出历史区，但不越过顶栏太多
    chat_top = max(wt + int(wh * 0.07), int(st - wh * 0.78))

    return ChatPanelScreen(
        left=chat_left,
        top=chat_top,
        right=max(chat_left + 80, chat_right),
        bottom=chat_bottom,
        send_left=int(sl),
        send_cy=send_cy,
    )


def rect_center_in_panel(r: auto.Rect, panel: ChatPanelScreen, *, margin: int = 6) -> bool:
    cx = (r.left + r.right) / 2.0
    cy = (r.top + r.bottom) / 2.0
    return (
        panel.left - margin <= cx <= panel.right + margin
        and panel.top - margin <= cy <= panel.bottom + margin
    )


def rect_overlap_panel(r: auto.Rect, panel: ChatPanelScreen, *, margin: int = 8) -> bool:
    pl, pt, pr, pb = panel.left, panel.top, panel.right, panel.bottom
    pl -= margin
    pt -= margin
    pr += margin
    pb += margin
    return not (r.right < pl or r.left > pr or r.bottom < pt or r.top > pb)
