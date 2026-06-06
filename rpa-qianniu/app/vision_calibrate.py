"""
OCR 锚点自动校准千牛接待窗口分区（窗口内像素坐标，相对截图左上角）。
失败时由 vision_layout 回退到 .env 比例。
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from app.config import settings
from app.logger import get_logger
from app.ocr_paddle import OcrTextBox, ocr_bgr_to_boxes, paddle_available

log = get_logger("vision_calibrate")

# 聊天区首条日期：严格 YYYY-MM-DD（跳过搜索栏/标签栏，从时间戳行起算 message 顶）
_TS_YMD = re.compile(r"\d{4}-\d{2}-\d{2}")

_ROW_ANCHORS = ("正在接待", "全部买家", "其他消息", "联系人", "待回复")
_RIGHT_ANCHORS = ("咨询宝贝", "足迹", "近3个月订单", "历史订单", "智能客服")
_VISITOR_TITLE = "访客用账号"

_FUZZY_RATIO = 0.7
_MIN_OCR_CONF = 0.6
_NAV_FALLBACK_PX = 30
# message_area.y1 无日期锚点时的垂直回退：相对 chat_panel 顶部
_MESSAGE_Y1_FALLBACK_BELOW_CHAT_TOP = 80

# left_panel / chat_panel 宽度约束（相对 window_w）
_MAX_LEFT_PANEL_FRAC = 0.25
_MIN_CHAT_FRAC = 0.20
# 会话列表右缘：搜索栏关键词（仅出现在聊天区顶部）
_SEARCH_BAR_KEYS = ("联系人", "订单号", "聊天记录")
_TOP_STRIP_FRAC = 0.33


def _clamp_message_input_x_to_chat(
    chat_panel: dict[str, Any],
    message_area: dict[str, Any],
    input_area: dict[str, Any],
) -> None:
    """message_area / input_area 的水平范围铁律：不得超出 chat_panel。"""
    cx1 = int(chat_panel["x1"])
    cx2 = int(chat_panel["x2"])
    message_area["x1"] = max(int(message_area["x1"]), cx1)
    message_area["x2"] = min(int(message_area["x2"]), cx2)
    input_area["x1"] = max(int(input_area["x1"]), cx1)
    input_area["x2"] = min(int(input_area["x2"]), cx2)


_ANCHOR_COLORS_BGR: dict[str, tuple[int, int, int]] = {
    "正在接待": (0, 255, 0),
    "咨询宝贝": (0, 0, 255),
    "发送": (255, 0, 255),
    "足迹": (255, 255, 0),
}


@dataclass
class _CalibRunState:
    """一次校准运行的可观测状态，供日志与调试图（成功/失败均写入）。"""

    boxes: list[OcrTextBox] = field(default_factory=list)
    error_msg: str | None = None
    result: dict[str, Any] | None = None
    edge_cv: int | None = None
    zh: list[OcrTextBox] = field(default_factory=list)
    send_b: OcrTextBox | None = None
    chat_x2_via: str = ""
    debug_anchors: list[dict[str, Any]] = field(default_factory=list)
    debug_lines: list[dict[str, Any]] = field(default_factory=list)
    summary: list[str] = field(default_factory=list)
    anchor_hits: dict[str, OcrTextBox] = field(default_factory=dict)
    h: int = 0
    w: int = 0


def _calibration_path() -> Path:
    return Path(settings.vision_calibration_path)


def try_load_calibration_cache(window_wh: tuple[int, int]) -> dict[str, Any] | None:
    """若磁盘缓存的 window_size 与当前一致则返回校准 dict（窗口内坐标）。"""
    p = _calibration_path()
    if not p.exists():
        return None
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    ws = raw.get("window_size")
    if not isinstance(ws, list) or len(ws) != 2:
        return None
    if int(ws[0]) != int(window_wh[0]) or int(ws[1]) != int(window_wh[1]):
        return None
    return raw if isinstance(raw, dict) else None


def save_calibration_cache(payload: dict[str, Any]) -> None:
    p = _calibration_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    to_save = dict(payload)
    to_save.pop("_debug", None)
    tmp.write_text(json.dumps(to_save, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)


def _fuzzy_ratio(a: str, b: str) -> float:
    a, b = (a or "").strip(), (b or "").strip()
    if not a or not b:
        return 0.0
    return float(SequenceMatcher(None, a, b).ratio())


def _fuzzy_has(text: str, target: str, ratio: float = _FUZZY_RATIO) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    if target in t:
        return True
    return _fuzzy_ratio(t, target) >= ratio or _fuzzy_ratio(t, target[: max(2, len(target))]) >= ratio


def _best_fuzzy_boxes(
    boxes: list[OcrTextBox],
    target: str,
    *,
    min_conf: float = _MIN_OCR_CONF,
    ratio: float = _FUZZY_RATIO,
) -> list[OcrTextBox]:
    out: list[tuple[OcrTextBox, float]] = []
    for b in boxes:
        if float(b.confidence) < min_conf:
            continue
        t = (b.text or "").strip()
        if not t:
            continue
        if target in t:
            out.append((b, 1.0))
            continue
        r = _fuzzy_ratio(t, target)
        if r >= ratio:
            out.append((b, r))
    out.sort(key=lambda x: (-x[1], -float(x[0].confidence)))
    return [x[0] for x in out]


def _find_boxes_fuzzy(boxes: list[OcrTextBox], *targets: str) -> list[OcrTextBox]:
    seen: set[int] = set()
    out: list[OcrTextBox] = []
    for target in targets:
        if not target:
            continue
        for b in _best_fuzzy_boxes(boxes, target):
            k = id(b)
            if k in seen:
                continue
            seen.add(k)
            out.append(b)
    return out


def _row_boxes(boxes: list[OcrTextBox], ref: OcrTextBox, y_tol: float = 22.0) -> list[OcrTextBox]:
    cy = (float(ref.top) + float(ref.bottom)) / 2.0
    out: list[OcrTextBox] = []
    for b in boxes:
        m = (float(b.top) + float(b.bottom)) / 2.0
        if abs(m - cy) <= y_tol:
            out.append(b)
    return out if out else [ref]


def _detect_left_nav_right_edge_opencv(bgr: np.ndarray) -> int | None:
    """
    在 y=窗口高度一半 做水平扫描：左侧图标栏为浅蓝竖条（约 #E8F0FE），与会话列表白底存在色差/蓝偏差异。
    返回会话列表起点 x（竖条右缘）；失败返回 None。
    """
    h, w = bgr.shape[:2]
    y = max(2, min(h - 3, h // 2))
    row = bgr[y, :, :].astype(np.float32)
    bch, gch, rch = row[:, 0], row[:, 1], row[:, 2]
    blue_bias = bch - rch
    lum = (bch + gch + rch) / 3.0
    kb = 9
    pad = kb // 2

    def _smooth1d(a: np.ndarray) -> np.ndarray:
        a = np.pad(a.astype(np.float64), (pad, pad), mode="edge")
        return np.convolve(a, np.ones(kb) / kb, mode="valid")

    bb = _smooth1d(blue_bias)
    lm = _smooth1d(lum)
    search = min(w - 2, 130)
    if search < 30:
        return None
    # 竖条内：蓝偏较高；切入白底区域：蓝偏下降且整体亮度仍高
    for x in range(18, search):
        if bb[x - 1] > 9.0 and bb[x] < 5.5 and lm[x] > 195.0:
            return int(x)
    grad = np.abs(np.diff(bb, prepend=float(bb[0])))
    peak = int(np.argmax(grad[12:search])) + 12
    if peak < search and float(grad[peak]) > 2.8 and lm[peak] > 185.0:
        return int(peak)
    return None


def _pick_bottom_send(boxes: list[OcrTextBox], chat_x1: int, chat_x2: int, img_w: int) -> OcrTextBox | None:
    cands: list[OcrTextBox] = []
    for b in boxes:
        if float(b.confidence) < _MIN_OCR_CONF:
            continue
        t = re.sub(r"\s+", "", (b.text or ""))
        if not _fuzzy_has(t, "发送"):
            continue
        cx = (b.left + b.right) / 2
        if chat_x1 - 20 <= cx <= chat_x2 + 30:
            cands.append(b)
    if not cands:
        for b in boxes:
            if float(b.confidence) < _MIN_OCR_CONF:
                continue
            t = re.sub(r"\s+", "", (b.text or ""))
            if _fuzzy_has(t, "发送"):
                cands.append(b)
    if not cands:
        return None
    return max(cands, key=lambda b: float(b.bottom))


def _sess_x2_feasible_range(sess_x1: int, chat_x2: int, w: int) -> tuple[int, int] | None:
    """满足 left_panel 宽 < 25% 窗口且 chat 宽 > 20% 窗口 的 sess_x2 整数闭区间 [lo, hi]；不可行返回 None。"""
    lo = sess_x1 + 80
    hi_lp = sess_x1 + int(math.floor(w * _MAX_LEFT_PANEL_FRAC - 1e-9))
    min_chat_px = int(w * _MIN_CHAT_FRAC) + 1
    hi_chat = chat_x2 - min_chat_px
    hi = min(hi_lp, hi_chat, chat_x2 - 2)
    if lo > hi:
        return None
    return lo, hi


def _quantize_sess_x2(sess_x1: int, raw: int, chat_x2: int, w: int) -> int | None:
    rng = _sess_x2_feasible_range(sess_x1, chat_x2, w)
    if rng is None:
        return None
    lo, hi = rng
    return max(lo, min(int(raw), hi))


def _layout_sanity_sess_x2(sess_x1: int, sess_x2: int, chat_x2: int, w: int) -> bool:
    if not (sess_x1 < sess_x2 < chat_x2):
        return False
    lpw = sess_x2 - sess_x1
    chw = chat_x2 - sess_x2
    return lpw < w * _MAX_LEFT_PANEL_FRAC and chw > w * _MIN_CHAT_FRAC


def _sess_x2_ratio_fallback(sess_x1: int, w: int) -> int:
    return sess_x1 + int(round((w - sess_x1) * 0.15))


def _pick_sess_x2_from_search_bar(
    boxes: list[OcrTextBox], sess_x1: int, w: int, h: int
) -> tuple[int, OcrTextBox] | None:
    """聊天区顶部搜索栏「联系人/订单号/聊天记录」：其 left_x 为聊天区左缘附近。"""
    min_left: int | None = None
    best_box: OcrTextBox | None = None
    guard = sess_x1 + max(90, int(w * 0.065))
    y_max = float(h) * _TOP_STRIP_FRAC
    for key in _SEARCH_BAR_KEYS:
        for b in _best_fuzzy_boxes(boxes, key):
            cy = (float(b.top) + float(b.bottom)) / 2.0
            if cy > y_max:
                continue
            if float(b.left) < float(guard):
                continue
            ml = int(b.left)
            if min_left is None or ml < min_left:
                min_left = ml
                best_box = b
    if min_left is None or best_box is None:
        return None
    return (min_left - 5, best_box)


def _pick_sess_x2_from_visitor_title_chat(
    boxes: list[OcrTextBox],
    sess_x1: int,
    w: int,
    h: int,
    chat_x2: int,
) -> tuple[int, OcrTextBox] | None:
    """聊天区标题「访客用账号」：取候选中最靠左的一条（避免误选会话列表中同名），left-10。"""
    cands = _best_fuzzy_boxes(boxes, _VISITOR_TITLE)
    if not cands:
        return None
    min_chat_left = sess_x1 + max(80, int(w * 0.05))
    min_chat_px = int(w * _MIN_CHAT_FRAC) + 1
    max_left = chat_x2 - min_chat_px - 30
    max_top = float(h) * 0.30
    pool: list[OcrTextBox] = []
    for b in cands:
        if float(b.top) > max_top:
            continue
        if float(b.left) < float(min_chat_left):
            continue
        if float(b.left) > float(max_left):
            continue
        pool.append(b)
    if not pool:
        return None
    best = min(pool, key=lambda b: float(b.left))
    return (int(best.left) - 10, best)


def _vertical_edge_sess_x2(
    bgr: np.ndarray, sess_x1: int, w: int, h: int, chat_x2: int
) -> int | None:
    """会话列表与聊天区之间的竖向分割线：Sobel-x 列能量峰值。"""
    min_chat_px = int(w * _MIN_CHAT_FRAC) + 1
    x0 = max(80, sess_x1 + 40, int(w * 0.06))
    x1 = min(int(w * 0.42), chat_x2 - min_chat_px - 25)
    if x1 <= x0 + 30:
        return None
    y0, y1 = int(h * 0.12), int(h * 0.88)
    roi = bgr[y0:y1, x0:x1]
    if roi.size == 0:
        return None
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    col = np.mean(np.abs(gx), axis=0)
    if col.size < 16:
        return None
    peak_local = int(np.argmax(col))
    med = float(np.median(col))
    if float(col[peak_local]) < med * 1.25:
        return None
    return int(peak_local + x0)


def _resolve_sess_x2(
    bgr: np.ndarray,
    boxes: list[OcrTextBox],
    sess_x1: int,
    chat_x2: int,
    w: int,
    h: int,
    le_ratio: float,
) -> tuple[int, str, OcrTextBox | None] | None:
    """
    按优先级确定 left_panel.x2：访客标题 → 搜索栏 → Sobel 竖边 → 15% 比例 → 正在接待行 → 最宽条目 → .env。
    任一方法经量化后须通过宽度约束，否则尝试下一项；全部失败返回 None（由 vision_layout 走 .env 比例）。
    """
    if _sess_x2_feasible_range(sess_x1, chat_x2, w) is None:
        return None

    attempts: list[tuple[str, int, OcrTextBox | None]] = []

    vt = _pick_sess_x2_from_visitor_title_chat(boxes, sess_x1, w, h, chat_x2)
    if vt is not None:
        raw, bx = vt
        attempts.append(("visitor_title", raw, bx))

    sb = _pick_sess_x2_from_search_bar(boxes, sess_x1, w, h)
    if sb is not None:
        raw, bx = sb
        attempts.append(("search_bar", raw, bx))

    ve = _vertical_edge_sess_x2(bgr, sess_x1, w, h, chat_x2)
    if ve is not None:
        attempts.append(("vertical_edge", ve, None))

    attempts.append(("ratio15%", _sess_x2_ratio_fallback(sess_x1, w), None))

    fb = _fallback_sess_x2_from_row(boxes, sess_x1, w)
    if fb is not None:
        attempts.append(("session_row", fb, None))

    mx = _max_session_entry_right(boxes, sess_x1, w, h, chat_x2)
    if mx is not None:
        attempts.append(("max_session_entry", mx + 8, None))

    attempts.append(
        (
            "env_ratio",
            max(sess_x1 + 60, min(chat_x2 - 80, int(w * le_ratio))),
            None,
        )
    )

    for tag, raw, ab in attempts:
        q = _quantize_sess_x2(sess_x1, raw, chat_x2, w)
        if q is None:
            continue
        if not _layout_sanity_sess_x2(sess_x1, q, chat_x2, w):
            continue
        return q, tag, ab

    return None


def _fallback_sess_x2_from_row(boxes: list[OcrTextBox], sess_x1: int, w: int) -> int | None:
    prim = _find_boxes_fuzzy(boxes, "正在接待")
    if not prim:
        return None
    anchor = prim[0]
    row = _row_boxes(boxes, anchor)
    rights: list[int] = []
    for b in row:
        t = (b.text or "").strip()
        if any(_fuzzy_has(t, a) for a in _ROW_ANCHORS):
            rights.append(int(b.right))
    if rights:
        return max(sess_x1 + 40, min(w - 2, max(rights) + 12))
    return max(sess_x1 + 40, min(w - 2, int(anchor.right) + 120))


def _max_session_entry_right(boxes: list[OcrTextBox], sess_x1: int, w: int, h: int, chat_x2: int) -> int | None:
    x_max = min(int(w * 0.42), chat_x2 - 40)
    y_lo, y_hi = int(h * 0.12), int(h * 0.88)
    best = sess_x1
    for b in boxes:
        if float(b.confidence) < _MIN_OCR_CONF:
            continue
        cx = (b.left + b.right) / 2
        if sess_x1 + 15 <= cx <= x_max and y_lo <= b.top <= y_hi:
            best = max(best, int(b.right))
    return best if best > sess_x1 + 30 else None


def _fmt_ocr_box(b: OcrTextBox | None) -> str:
    if b is None:
        return "None"
    return f"({b.left},{b.top})-({b.right},{b.bottom})"


def _log_auto_calibrate_diagnostics(
    boxes: list[OcrTextBox],
    *,
    edge_cv: int | None,
    zh: list[OcrTextBox],
    zixun_boxes: list[OcrTextBox],
    send_b: OcrTextBox | None,
    chat_x2_via: str,
    result: dict[str, Any] | None,
    extra: str | None = None,
) -> None:
    log.info("[校准] 所有 OCR 结果：")
    for b in boxes:
        t = (b.text or "").replace("\n", " ")
        if len(t) > 100:
            t = t[:97] + "..."
        log.info(
            "  text=%r conf=%.2f box=(%s,%s,%s,%s)",
            t,
            float(b.confidence),
            b.left,
            b.top,
            b.right,
            b.bottom,
        )
    log.info("[校准] 锚点命中：")
    log.info(
        "  '正在接待' 命中=%s box=%s",
        bool(zh),
        _fmt_ocr_box(zh[0] if zh else None),
    )
    zb0 = zixun_boxes[0] if zixun_boxes else None
    log.info(
        "  '咨询宝贝' 命中=%s box=%s （chat_x2 本次使用的右栏锚=%r）",
        zb0 is not None,
        _fmt_ocr_box(zb0),
        chat_x2_via,
    )
    log.info(
        "  '发送' 命中=%s box=%s",
        send_b is not None,
        _fmt_ocr_box(send_b),
    )
    log.info("  颜色突变 x=%s", edge_cv)
    if extra:
        log.info("[校准] 额外: %s", extra)
    if result:
        log.info("[校准] 最终结果：")
        lp = result.get("left_panel") or {}
        ma = result.get("message_area") or {}
        ia = result.get("input_area") or {}
        log.info("  left_panel: x1=%s, x2=%s", lp.get("x1"), lp.get("x2"))
        log.info("  message_area: y1=%s", ma.get("y1"))
        log.info("  input_area: y1=%s", ia.get("y1"))


def _overlay_named_anchor_hits(vis: np.ndarray, anchor_hits: dict[str, OcrTextBox]) -> None:
    for name, b in anchor_hits.items():
        if b is None:
            continue
        col = _ANCHOR_COLORS_BGR.get(name, (0, 255, 128))
        cv2.rectangle(vis, (b.left, b.top), (b.right, b.bottom), col, 3)
        cv2.putText(
            vis,
            f"ANCHOR:{name}",
            (b.left, max(16, b.top - 8)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.48,
            col,
            2,
            cv2.LINE_AA,
        )


def _write_calibration_debug_png_from_state(bgr: np.ndarray, st: _CalibRunState) -> Path | None:
    """无论成功失败均写入 debug/{{ts}}_calibration.png。"""
    if bgr is None or bgr.size == 0:
        return None
    err = st.error_msg if st.result is None else None
    if st.result is not None:
        cal: dict[str, Any] = st.result
    else:
        summ = list(st.summary)
        if st.error_msg:
            summ.append(f"FAIL: {st.error_msg}")
        cal = {
            "_debug": {
                "anchors": st.debug_anchors,
                "lines": st.debug_lines,
                "summary_lines": summ,
            },
        }
    vis = draw_calibration_debug(bgr, cal, st.boxes, [], error_banner=err)
    _overlay_named_anchor_hits(vis, st.anchor_hits)
    root = Path(settings.vision_debug_dir)
    try:
        root.mkdir(parents=True, exist_ok=True)
    except Exception:
        return None
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    p = root / f"{ts}_calibration.png"
    try:
        cv2.imwrite(str(p), vis)
        log.info("[校准] 调试图已保存（含失败/部分状态）: %s", p)
        return p
    except Exception as exc:
        log.warning("[校准] 调试图写入失败: %s", exc)
        return None


def auto_calibrate(bgr: np.ndarray) -> dict[str, Any] | None:
    """
    对窗口截图（整窗 BGR，与 capture_window_frame_bgr 一致）做 OCR 锚点校准。
    返回的坐标均为「窗口内」像素：左上角 (0,0)，x 向右、y 向下。
    失败时亦写入 debug/{{ts}}_calibration.png 并打诊断日志。
    """
    st = _CalibRunState()
    try:
        if not paddle_available() or bgr is None or bgr.size == 0:
            st.error_msg = "Paddle 不可用或截图无效"
            log.warning("[校准] %s", st.error_msg)
            return None

        st.h, st.w = int(bgr.shape[0]), int(bgr.shape[1])
        h, w = st.h, st.w
        if w < 200 or h < 200:
            st.error_msg = f"截图过小 {w}x{h}"
            log.warning("[校准] %s", st.error_msg)
            return None

        st.boxes = ocr_bgr_to_boxes(bgr, win_left=0, win_top=0, cache_ttl_sec=0.0)
        boxes = st.boxes
        if not boxes:
            st.error_msg = "OCR 无结果（Paddle 返回空框或推理已停用）"
            log.warning("[校准] %s", st.error_msg)
            return None

        debug_anchors = st.debug_anchors
        debug_lines = st.debug_lines
        summary = st.summary

        le_ratio = float(settings.vision_left_end_ratio)

        # --- 右边界 chat_x2：咨询宝贝 / 足迹 ---
        chat_x2: int | None = None
        chat_x2_via = ""
        for key in _RIGHT_ANCHORS:
            rb = _find_boxes_fuzzy(boxes, key)
            if rb:
                chat_x2 = int(min(b.left for b in rb)) - 5
                chat_x2_via = key
                conf = max(float(b.confidence) for b in rb)
                debug_anchors.append(
                    {
                        "role": f"chat_x2←{key}",
                        "text": key,
                        "left": rb[0].left,
                        "top": rb[0].top,
                        "right": rb[0].right,
                        "bottom": rb[0].bottom,
                        "conf": conf,
                        "color": (255, 128, 0),
                    }
                )
                break
        zb = _find_boxes_fuzzy(boxes, "咨询宝贝")
        if zb:
            st.anchor_hits["咨询宝贝"] = zb[0]
        zj = _find_boxes_fuzzy(boxes, "足迹")
        if zj:
            st.anchor_hits["足迹"] = zj[0]

        if chat_x2 is None:
            chat_x2 = int(w * float(settings.vision_chat_end_ratio))
            chat_x2_via = "env_ratio"
            summary.append(f"chat_x2={chat_x2}(via .env vision_chat_end_ratio)")
        else:
            summary.append(f"chat_x2={chat_x2}(via OCR「{chat_x2_via}」)")
        chat_x2 = max(120, min(w - 2, chat_x2))
        st.chat_x2_via = chat_x2_via

        # --- 左边界 sess_x1：OpenCV → 正在接待-5 → 30 ---
        sess_x1: int
        sess_x1_via = ""
        edge_cv = _detect_left_nav_right_edge_opencv(bgr)
        st.edge_cv = edge_cv
        zh = _find_boxes_fuzzy(boxes, "正在接待")
        st.zh = zh
        if zh:
            st.anchor_hits["正在接待"] = zh[0]

        if edge_cv is not None and 12 <= edge_cv <= min(w - 40, 160):
            sess_x1 = edge_cv
            sess_x1_via = "颜色扫描"
            debug_lines.append({"kind": "v", "x": sess_x1, "label": "left_panel.x1", "color": (0, 255, 128)})
            yy = h // 2
            debug_anchors.append(
                {
                    "role": "left_panel.x1←OpenCV色界",
                    "text": "",
                    "left": max(0, sess_x1 - 3),
                    "top": yy - 6,
                    "right": min(w - 1, sess_x1 + 3),
                    "bottom": yy + 6,
                    "conf": 1.0,
                    "color": (0, 255, 128),
                }
            )
        elif zh:
            sess_x1 = max(0, int(zh[0].left) - 5)
            sess_x1_via = "正在接待-5px"
            debug_anchors.append(
                {
                    "role": "left_panel.x1←正在接待",
                    "text": zh[0].text,
                    "left": zh[0].left,
                    "top": zh[0].top,
                    "right": zh[0].right,
                    "bottom": zh[0].bottom,
                    "conf": float(zh[0].confidence),
                    "color": (0, 200, 255),
                }
            )
            debug_lines.append({"kind": "v", "x": sess_x1, "label": "left_panel.x1", "color": (0, 200, 255)})
        else:
            sess_x1 = _NAV_FALLBACK_PX
            sess_x1_via = f"硬编码{_NAV_FALLBACK_PX}px"
        summary.append(f"left_panel.x1={sess_x1}(via {sess_x1_via})")

        # --- 会话列表右缘 / chat 左缘 sess_x2（多锚点优先级 + 宽度断言，失败则整段校准作废）---
        resolved = _resolve_sess_x2(bgr, boxes, sess_x1, chat_x2, w, h, le_ratio)
        if resolved is None:
            st.error_msg = (
                "left_panel.x2 无法由搜索栏/访客标题/竖边/比例等锚点确定，或违反宽度约束（会话列表≤25% 且聊天区>20%）"
            )
            log.warning("[校准] %s", st.error_msg)
            return None
        sess_x2, sess_x2_tag, sess_x2_anchor = resolved
        summary.append(f"left_panel.x2={sess_x2}(via {sess_x2_tag})")
        debug_lines.append({"kind": "v", "x": sess_x2, "label": "left_panel.x2", "color": (200, 100, 255)})
        if sess_x2_anchor is not None:
            bx = sess_x2_anchor
            debug_anchors.append(
                {
                    "role": f"left_panel.x2←{sess_x2_tag}",
                    "text": bx.text,
                    "left": bx.left,
                    "top": bx.top,
                    "right": bx.right,
                    "bottom": bx.bottom,
                    "conf": float(bx.confidence),
                    "color": (200, 100, 255),
                }
            )
        elif sess_x2_tag == "vertical_edge":
            debug_anchors.append(
                {
                    "role": "left_panel.x2←vertical_edge(Sobel)",
                    "text": "",
                    "left": max(0, sess_x2 - 2),
                    "top": int(h * 0.15),
                    "right": min(w - 1, sess_x2 + 2),
                    "bottom": int(h * 0.85),
                    "conf": 1.0,
                    "color": (200, 100, 255),
                }
            )

        chat_x1 = sess_x2

        # --- 发送、输入区 ---
        send_b = _pick_bottom_send(boxes, chat_x1, chat_x2, w)
        st.send_b = send_b
        if send_b is not None:
            st.anchor_hits["发送"] = send_b
        if send_b is None:
            st.error_msg = "未找到「发送」锚点"
            log.warning("[校准] %s", st.error_msg)
            return None

        input_y1 = int(send_b.top) - 50
        input_y1 = max(int(h * 0.35), min(h - 40, input_y1))
        input_y2 = h

        # --- message_area.y1：chat 内 OCR 首条 YYYY-MM-DD → top-5；否则 chat_panel.y1+80 ---
        chat_top = 0
        msg_y1: int | None = None
        in_chat_for_ts = [
            b
            for b in boxes
            if float(b.confidence) >= _MIN_OCR_CONF
            and chat_x1 <= (b.left + b.right) / 2 <= chat_x2
            and b.bottom <= input_y1 + 8
        ]
        for b in sorted(in_chat_for_ts, key=lambda x: float(x.top)):
            t = (b.text or "").strip()
            if _TS_YMD.search(t):
                msg_y1 = max(0, int(b.top) - 5)
                summary.append(f"message_area.y1={msg_y1}(via 首条YYYY-MM-DD top-5)")
                debug_anchors.append(
                    {
                        "role": "message_y1←YYYY-MM-DD",
                        "text": t[:24],
                        "left": b.left,
                        "top": b.top,
                        "right": b.right,
                        "bottom": b.bottom,
                        "conf": float(b.confidence),
                        "color": (0, 128, 255),
                    }
                )
                break
        if msg_y1 is None:
            msg_y1 = chat_top + _MESSAGE_Y1_FALLBACK_BELOW_CHAT_TOP
            summary.append(
                f"message_area.y1={msg_y1}(via chat_panel.y1+{_MESSAGE_Y1_FALLBACK_BELOW_CHAT_TOP}px)"
            )

        msg_y1 = max(0, min(input_y1 - 20, msg_y1))
        msg_y2 = input_y1

        send_cx = int((send_b.left + send_b.right) / 2)
        send_cy = int((send_b.top + send_b.bottom) / 2)

        def _ok() -> bool:
            if not (0 <= sess_x1 < sess_x2 < chat_x2 < w):
                return False
            if not (0 <= msg_y1 < input_y1 < h):
                return False
            if not (chat_x1 < chat_x2):
                return False
            return True

        if not _ok():
            st.error_msg = (
                f"自洽性检查失败 sess_x1={sess_x1} sess_x2={sess_x2} "
                f"chat_x2={chat_x2} msg_y1={msg_y1} input_y1={input_y1}"
            )
            log.warning(
                "[校准] 自洽性检查失败: sess_x1=%s sess_x2=%s chat_x2=%s msg_y1=%s input_y1=%s",
                sess_x1,
                sess_x2,
                chat_x2,
                msg_y1,
                input_y1,
            )
            return None

        chat_panel: dict[str, Any] = {"x1": chat_x1, "y1": 0, "x2": chat_x2, "y2": h}
        message_area: dict[str, Any] = {
            "x1": chat_x1,
            "y1": msg_y1,
            "x2": chat_x2,
            "y2": msg_y2,
        }
        input_area: dict[str, Any] = {
            "x1": chat_x1,
            "y1": input_y1,
            "x2": chat_x2,
            "y2": input_y2,
        }
        _clamp_message_input_x_to_chat(chat_panel, message_area, input_area)

        out: dict[str, Any] = {
            "left_nav_strip": {"x1": 0, "y1": 0, "x2": sess_x1, "y2": h},
            "session_list_strip": {"x1": sess_x1, "y1": 0, "x2": sess_x2, "y2": h},
            "left_panel": {"x1": sess_x1, "y1": 0, "x2": sess_x2, "y2": h},
            "chat_panel": chat_panel,
            "right_panel": {"x1": chat_x2, "y1": 0, "x2": w, "y2": h},
            "message_area": message_area,
            "input_area": input_area,
            "send_button": {"x": send_cx, "y": send_cy},
            "calibrated_at": datetime.now(timezone.utc).isoformat(),
            "window_size": [w, h],
            "_debug": {
                "anchors": debug_anchors,
                "lines": debug_lines,
                "summary_lines": summary,
            },
        }
        st.result = out
        return out

    except Exception as exc:
        st.error_msg = f"{type(exc).__name__}: {exc}"
        log.exception("[校准] 异常: %s", exc)
        return None

    finally:
        try:
            if st.boxes:
                rp: dict[str, Any] | None = None
                if st.result:
                    r = st.result
                    rp = {
                        "left_panel": {"x1": r["left_panel"]["x1"], "x2": r["left_panel"]["x2"]},
                        "message_area": {"y1": r["message_area"]["y1"]},
                        "input_area": {"y1": r["input_area"]["y1"]},
                    }
                _log_auto_calibrate_diagnostics(
                    st.boxes,
                    edge_cv=st.edge_cv,
                    zh=st.zh,
                    zixun_boxes=_find_boxes_fuzzy(st.boxes, "咨询宝贝"),
                    send_b=st.send_b,
                    chat_x2_via=st.chat_x2_via,
                    result=rp,
                    extra=st.error_msg if st.result is None else None,
                )
            else:
                log.info("[校准] 无 OCR 框，error=%s", st.error_msg)
        except Exception as log_exc:
            log.debug("校准诊断日志失败: %s", log_exc)
        try:
            if bgr is not None and bgr.size > 0:
                _write_calibration_debug_png_from_state(bgr, st)
        except Exception as wexc:
            log.warning("[校准] 写调试图失败: %s", wexc)


def draw_calibration_debug(
    bgr: np.ndarray,
    cal: dict[str, Any],
    boxes: list[OcrTextBox],
    anchor_hits: list[tuple[OcrTextBox, str]],
    *,
    error_banner: str | None = None,
) -> np.ndarray:
    """调试图：灰框 OCR、锚点彩色框、分区矩形、边界线与摘要。error_banner 为失败原因（顶部红条）。"""
    vis = bgr.copy()
    h, w = vis.shape[:2]
    y_off = 0
    if error_banner:
        msg = str(error_banner).replace("\n", " ")[:240]
        cv2.rectangle(vis, (0, 0), (w, min(52, h)), (0, 0, 200), -1)
        cv2.putText(
            vis,
            f"CALIBRATION FAILED: {msg}",
            (8, 34),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (255, 255, 255),
            2,
            cv2.LINE_AA,
        )
        y_off = 52
    dbg = cal.get("_debug") if isinstance(cal.get("_debug"), dict) else None

    for b in boxes:
        cv2.rectangle(vis, (b.left, b.top), (b.right, b.bottom), (180, 180, 180), 1)

    lp = cal.get("left_panel")
    ch = cal.get("chat_panel")
    lx1 = lx2 = cx2 = None
    if isinstance(lp, dict) and isinstance(ch, dict):
        try:
            lx1, lx2 = int(lp["x1"]), int(lp["x2"])
            cx2 = int(ch["x2"])
        except (KeyError, TypeError, ValueError):
            pass

    if dbg and isinstance(dbg.get("anchors"), list):
        for a in dbg["anchors"]:
            try:
                x1, y1 = int(a["left"]), int(a["top"])
                x2, y2 = int(a["right"]), int(a["bottom"])
                col = tuple(int(x) for x in (a.get("color") or (0, 220, 0)))
            except (KeyError, TypeError, ValueError):
                continue
            cv2.rectangle(vis, (x1, y1), (x2, y2), col, 2)
            role = str(a.get("role", ""))[:48]
            cv2.putText(
                vis,
                role,
                (x1, max(14, y1 - 4)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.42,
                col,
                1,
                cv2.LINE_AA,
            )
            cy = (y1 + y2) // 2
            if lx1 is not None and ("left_panel.x1" in role or "←正在接待" in role):
                cv2.arrowedLine(vis, (x1, cy), (lx1, cy), col, 1, tipLength=0.12)
            elif lx2 is not None and ("left_panel.x2" in role or "访客标题" in role):
                cv2.arrowedLine(vis, (x1, cy), (lx2, cy), col, 1, tipLength=0.12)
            elif cx2 is not None and "chat_x2" in role:
                cv2.arrowedLine(vis, (x2, cy), (max(0, cx2 - 2), cy), col, 1, tipLength=0.12)

    for b, lab in anchor_hits:
        cv2.rectangle(vis, (b.left, b.top), (b.right, b.bottom), (0, 220, 0), 2)
        cv2.putText(
            vis,
            lab[:20],
            (b.left, max(12, b.top - 4)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            (0, 180, 0),
            1,
            cv2.LINE_AA,
        )

    if dbg and isinstance(dbg.get("lines"), list):
        for ln in dbg["lines"]:
            if ln.get("kind") != "v":
                continue
            try:
                x = int(ln["x"])
                col = tuple(int(x) for x in (ln.get("color") or (0, 255, 0)))
            except (TypeError, ValueError):
                continue
            cv2.line(vis, (x, 0), (x, h - 1), col, 2)
            lbl = str(ln.get("label", ""))[:32]
            cv2.putText(vis, lbl, (min(w - 120, x + 3), 28), cv2.FONT_HERSHEY_SIMPLEX, 0.45, col, 1, cv2.LINE_AA)

    def rect_overlay(key: str, color: tuple[int, int, int], label: str) -> None:
        r = cal.get(key)
        if not isinstance(r, dict):
            return
        try:
            x1, y1 = int(r["x1"]), int(r["y1"])
            x2, y2 = int(r["x2"]), int(r["y2"])
        except (KeyError, TypeError, ValueError):
            return
        cv2.rectangle(vis, (x1, y1), (x2, y2), color, 2)
        cv2.putText(
            vis,
            label,
            (x1 + 4, min(h - 4, y1 + 16)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            color,
            1,
            cv2.LINE_AA,
        )

    rect_overlay("left_nav_strip", (255, 255, 0), "nav")
    sess = cal.get("session_list_strip")
    if isinstance(sess, dict):
        try:
            x1, y1, x2, y2 = int(sess["x1"]), int(sess["y1"]), int(sess["x2"]), int(sess["y2"])
            cv2.rectangle(vis, (x1, y1), (x2, y2), (0, 255, 255), 2)
            cv2.putText(vis, "session", (x1 + 4, min(h - 4, y1 + 16)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1, cv2.LINE_AA)
        except (KeyError, TypeError, ValueError):
            pass
    rect_overlay("chat_panel", (0, 200, 0), "chat")
    rect_overlay("message_area", (0, 128, 255), "msg")
    rect_overlay("input_area", (255, 0, 255), "input")
    sb = cal.get("send_button")
    if isinstance(sb, dict):
        try:
            sx, sy = int(sb["x"]), int(sb["y"])
            cv2.circle(vis, (sx, sy), 6, (0, 255, 0), 2)
        except (KeyError, TypeError, ValueError):
            pass

    lines = [
        f"cal {str(cal.get('calibrated_at', ''))[:19]}",
        f"win {w}x{h}",
    ]
    if dbg and isinstance(dbg.get("summary_lines"), list):
        lines.extend(str(s)[:120] for s in dbg["summary_lines"][:12])
    else:
        for k in ("session_list_strip", "message_area", "input_area"):
            r = cal.get(k)
            if isinstance(r, dict):
                lines.append(f"{k}: {r}")
    y0 = 18 + y_off
    for i, line in enumerate(lines[:14]):
        cv2.putText(
            vis,
            line[:120],
            (8, y0 + i * 15),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.42,
            (0, 0, 255),
            1,
            cv2.LINE_AA,
        )
    return vis


def save_calibration_debug_png(bgr: np.ndarray, cal: dict[str, Any]) -> Path | None:
    """写入 debug/{timestamp}_calibration.png（兼容入口；正常路径由 auto_calibrate finally 统一写出）。"""
    if bgr is None or bgr.size == 0:
        return None
    boxes = ocr_bgr_to_boxes(bgr, win_left=0, win_top=0, cache_ttl_sec=0.0)
    vis = draw_calibration_debug(bgr, cal, boxes, [], error_banner=None)
    root = Path(settings.vision_debug_dir)
    try:
        root.mkdir(parents=True, exist_ok=True)
    except Exception:
        return None
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    p = root / f"{ts}_calibration.png"
    try:
        cv2.imwrite(str(p), vis)
        log.info("[校准] 调试图已保存 %s", p)
        return p
    except Exception as exc:
        log.debug("校准调试图写入失败: %s", exc)
        return None
