"""
聊天区 message_area：OCR 提取气泡文字，区分买家/客服，取最新一条买家消息。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from app.config import settings
from app.debug_manager import should_save
from app.logger import get_logger
from app.ocr_paddle import OcrTextBox, ocr_bgr_to_boxes, paddle_available
from app.message_parser import is_ocr_noise_message, is_system_message
from app.vision_coords import (
    bgr_crop_origin_to_screen,
    crop_window_bgr,
    screen_point_to_bgr_xy,
)
from app.vision_debug import save_debug_bgr
from app.vision_layout import ScreenRect

log = get_logger("vision_message")

_MIN_CONF = 0.55
# 横幅 + AI 摘要条约占 message_area 顶部约 120px（可通过环境变量配置）
def _get_banner_skip_px() -> int:
    """获取横幅跳过像素数，可通过 MSG_BANNER_SKIP_PX 环境变量配置，默认 120"""
    import os

    env_val = os.environ.get("MSG_BANNER_SKIP_PX", "")
    if env_val.isdigit():
        return int(env_val)
    return 120


BANNER_SKIP_PX = _get_banner_skip_px()
# 顶部系统横幅 / AI 摘要条（裁剪后仍可能漏入时由文本过滤兜底）
_BANNER_SUBSTR = (
    "当前消息较多",
    "点此快速获取",
    "集中处理",
    "消息较多",
    "快速获取买家",
    "7天内自动总结",
    "AI一键总结",
    "AI咨询摘要",
    "收起",
    "展开",
    "一键总结",
    "自动总结",
    "hanha41409854",
    "radiobalabala",
    # 新增常见系统文本
    "AI咨询摘要",
    "快速获取买家",
    "自动回复",
    "机器人",
    "转接",
    "排队",
    "评价",
    "好评",
    "物流",
    "快递单号",
    "已发货",
    "待发货",
    "退款",
    "售后",
    "订单信息",
    "订单详情",
    "查看物流",
    "确认收货",
    "延长收货",
    "申请退款",
    "换货",
    "补发",
    "投诉",
    "举报",
    "拉黑",
    "屏蔽",
    "免打扰",
    "置顶",
    "标为未读",
    "删除会话",
    "清空记录",
)
_MSG_LINE_NOISE_SUB = ("未读", "已读")
_TS_LINE_HEAD = re.compile(
    r"^\s*\d{4}[-/年]\s*\d{1,2}[-/月]\s*\d{1,2}"
)
# 右侧信息栏昵称 ROI 内常见噪声
_RIGHT_NICK_NOISE = (
    "好评",
    "%",
    "客服",
    "各服",
    "接待",
    "操作指南",
    "操作",
    "指南",
    "智能",
    "升级",
    "高效",
    "助力",
    "官方",
    "店铺",
    "店铺身份",
    "身份",
    "千牛",
    "工作台",
    "消费",
    "交易",
    "设置",
    "关注",
    "关注有礼",
    "邀请",
    "优惠",
    "全新",
    "足迹",
    "推荐",
    "订单",
    "非会员",
    "非粉丝",
    "新客",
    "暂无",
    "超级",
    "添加备注",
    "发送宝贝",
    "下单",
    "专属",
    "计量",
    "收藏",
    "历史",
    # 新增噪声词
    "加购",
    "浏览",
    "支付",
    "咨询宝贝",
    "商品",
    "宝贝",
    "买家",
    "卖家",
    "旺旺",
    "信誉",
    "等级",
    "地址",
    "电话",
    "手机",
    "微信",
    "QQ",
    "复制",
    "备注",
    "标签",
    "会员",
    "粉丝",
    "查看",
    "详情",
    "更多",
    "展开",
    "收起",
    "编辑",
    "删除",
    "管理",
    "返回",
    "首页",
    "上一页",
    "下一页",
)
_ICON_CHARS = set("□○●◎△▽◇◆★☆♠♥♦♣→←↑↓⊙⊕⊗")
# 过短视为噪声（单字常为 OCR 碎片）
_MIN_BUYER_TEXT_LEN = 2
# 昵称过滤：纯数字、纯标点、价格行
_NICK_PURE_DIGITS = re.compile(r"^\d+$")
_NICK_PURE_PUNCT = re.compile(r"^[\s\p{P}\p{S}]+$", re.UNICODE)
_NICK_PRICE_CHARS = re.compile(r"[¥元￥€$£]|")
# 日期 + 时间
_TS_FULL = re.compile(
    r"\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?"
)
# 仅日期行（常单独一行）
_TS_DATE_ONLY = re.compile(r"^\s*\d{4}-\d{2}-\d{2}\s*$")


def _is_timestamp_only(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    if _TS_DATE_ONLY.match(t):
        return True
    # 整行主要是日期时间
    if _TS_FULL.search(t):
        rest = _TS_FULL.sub("", t)
        rest = re.sub(r"\s+", "", rest)
        if len(rest) <= 2:
            return True
    return False


def message_body_area(message_area: ScreenRect) -> ScreenRect:
    """去掉 message_area 顶部横幅区再 OCR 正文气泡。"""
    h = max(1, message_area.h)
    skip = min(BANNER_SKIP_PX, max(0, h - 48))
    new_top = message_area.top + skip
    if new_top >= message_area.bottom - 64:
        new_top = message_area.top + min(40, h // 5)
    return ScreenRect(message_area.left, new_top, message_area.right, message_area.bottom)


def _is_qianniu_banner_text(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    for s in _BANNER_SUBSTR:
        if s in t:
            return True
    return False


def _is_icon_only_nick_text(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    return all((c in _ICON_CHARS or c.isspace()) for c in t)


def _right_nick_line_junk(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    if _is_icon_only_nick_text(t):
        return True
    if len(t) <= 1:
        return True
    # 新增：正则过滤
    if _NICK_PURE_DIGITS.match(t):
        return True  # 纯数字行（如价格、ID）
    if _NICK_PURE_PUNCT.match(t):
        return True  # 纯标点行
    if _NICK_PRICE_CHARS.search(t):
        return True  # 包含价格符号
    stub = (settings.ai_stub_reply or "").strip()
    if stub and (t == stub or stub in t):
        return True
    for s in _RIGHT_NICK_NOISE:
        if s in t:
            return True
    if "%" in t and ("好评" in t or "评分" in t):
        return True
    if is_ocr_noise_message(t):
        return True
    if _is_qianniu_banner_text(t):
        return True
    return False


def _is_extra_message_line_noise(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    if any(s in t for s in _MSG_LINE_NOISE_SUB):
        return True
    if _TS_LINE_HEAD.match(t):
        return True
    if _is_qianniu_banner_text(t):
        return True
    return False


def is_probable_buyer_bubble_text(text: str) -> bool:
    """聊天正文区：排除横幅与系统占位（与 is_system_message 配合）。"""
    if _is_extra_message_line_noise(text):
        return False
    if is_system_message(text):
        return False
    return True


def extract_buyer_nick_from_right_panel(
    bgr: np.ndarray,
    win: ScreenRect,
    right_panel: ScreenRect,
) -> str:
    """
    右侧信息栏：跳过窗口标题与千牛顶栏后，在「上 frac 区域」内 OCR 昵称（避免裁到最小化等按钮）。
    """
    rh = max(1, right_panel.h)
    skip = min(
        int(settings.vision_right_nick_top_skip_px),
        max(0, rh - 64),
    )
    # 缩小 ROI frac 从 0.45/0.33 → 0.30，减少无关 UI 区域
    frac = min(0.30, max(0.18, float(settings.vision_right_nick_top_frac)))
    y1 = right_panel.top + skip
    remain = max(1, right_panel.bottom - y1)
    # 顶栏之下的「剩余高度」里取一段（默认约 1/3），专扫昵称/标签，不裁最顶标题按钮区
    y2 = min(right_panel.bottom, y1 + max(40, int(remain * frac)))
    if y2 <= y1 + 12:
        y2 = min(right_panel.bottom, y1 + max(48, rh // 5))
    header = ScreenRect(right_panel.left, y1, right_panel.right, y2)
    log.info(
        "[DEBUG-OCR] right_nick ROI 屏幕=(%s,%s)-(%s,%s) skip_px=%s",
        header.left,
        header.top,
        header.right,
        header.bottom,
        skip,
    )
    crop, ox, oy = crop_window_bgr(bgr, win, header)
    if crop.size == 0 or not paddle_available():
        return ""

    sx0, sy0 = bgr_crop_origin_to_screen(win, bgr, ox, oy)
    save_debug_bgr(crop, "right_nick_crop", event_type="ocr_extract")

    boxes = ocr_bgr_to_boxes(
        crop,
        win_left=sx0,
        win_top=sy0,
        cache_ttl_sec=0.0,
    )
    raw_preview = [(b.text, round(float(b.confidence), 2)) for b in boxes]
    log.info("[DEBUG-OCR] 右侧面板昵称 OCR 原始: %s", raw_preview)

    # 候选收集：相同 text 只保留字高最大的（去重）
    candidate_heights: dict[str, int] = {}
    candidate_boxes: dict[str, OcrTextBox] = {}

    for b in boxes:
        if float(b.confidence) < _MIN_CONF:
            continue
        t = (b.text or "").strip()
        if not t or len(t) > 48:
            continue
        if _right_nick_line_junk(t):
            continue
        h = max(1, int(b.bottom) - int(b.top))

        # 去重：相同 text 保留字高最大的
        if t in candidate_heights:
            if h <= candidate_heights[t]:
                continue  # 已有更高字高的同名候选，跳过
        candidate_heights[t] = h
        candidate_boxes[t] = b
        log.info("[昵称候选] text=%r 字高=%s", t, h)

    # 按字高排序，取最高的有效昵称
    sorted_candidates = sorted(candidate_heights.items(), key=lambda x: x[1], reverse=True)
    for t, h in sorted_candidates:
        log.info("[昵称] 选定: %r (字高=%s)", t, h)
        return t

    log.info("[DEBUG-OCR] 右侧面板未解析到有效昵称")
    return ""


def _debug_ts_compact() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]


def _save_message_ocr_debug_images(
    bgr: np.ndarray,
    win: ScreenRect,
    message_area: ScreenRect,
    body: ScreenRect,
    boxes: list[OcrTextBox],
) -> None:
    if not should_save("ocr_extract"):
        return
    root = Path(settings.vision_debug_dir)
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError:
        return
    ts = _debug_ts_compact()
    bx1, by1 = screen_point_to_bgr_xy(win, bgr, body.left, body.top)
    bx2, by2 = screen_point_to_bgr_xy(win, bgr, body.right - 1, body.bottom - 1)
    x1 = max(0, min(bgr.shape[1] - 1, min(bx1, bx2)))
    x2 = max(0, min(bgr.shape[1], max(bx1, bx2) + 1))
    y1 = max(0, min(bgr.shape[0] - 1, min(by1, by2)))
    y2 = max(0, min(bgr.shape[0], max(by1, by2) + 1))
    overlay = bgr.copy()
    try:
        cv2.rectangle(overlay, (x1, y1), (x2, y2), (255, 0, 0), 2)
        mid_x = (x1 + x2) // 2
        cv2.line(overlay, (mid_x, y1), (mid_x, y2), (0, 0, 255), 1)
        mx1, my1 = screen_point_to_bgr_xy(win, bgr, message_area.left, message_area.top)
        mx2, my2 = screen_point_to_bgr_xy(
            win, bgr, message_area.right - 1, message_area.bottom - 1
        )
        mxa = max(0, min(bgr.shape[1] - 1, min(mx1, mx2)))
        mxb = max(0, min(bgr.shape[1] - 1, max(mx1, mx2)))
        mya = max(0, min(bgr.shape[0] - 1, min(my1, my2)))
        myb = max(0, min(bgr.shape[0] - 1, max(my1, my2)))
        cv2.rectangle(overlay, (mxa, mya), (mxb, myb), (0, 255, 0), 1)
        cv2.imwrite(str(root / f"{ts}_msg_roi.png"), overlay)
        if y2 > y1 and x2 > x1:
            cv2.imwrite(str(root / f"{ts}_msg_crop.png"), bgr[y1:y2, x1:x2])
    except Exception:
        return

    log.info(
        "[DEBUG-OCR] 消息 ROI 屏幕=(%s,%s)-(%s,%s) body相对窗=(%s,%s)-(%s,%s)",
        body.left,
        body.top,
        body.right,
        body.bottom,
        x1,
        y1,
        x2,
        y2,
    )
    for b in boxes:
        log.info(
            "[DEBUG-OCR]   text=%r conf=%.2f screen=(%s,%s)-(%s,%s)",
            (b.text or "").strip(),
            float(b.confidence),
            b.left,
            b.top,
            b.right,
            b.bottom,
        )


def _role_for_box(cx: float, mid_x: float, half_w: float, box_width: float, msg_area_width: float) -> str:
    """buyer：靠左；seller：靠右；中间条带视为非买家气泡。

    优化点：
    1. margin 阈值从 max(12.0, half_w*0.04) 改为 max(20.0, half_w*0.08)，拉大中间「不确定」带
    2. 增加宽度辅助判断：若单个 box 宽度 > message_area 宽度的 70% 且居中，大概率是系统横幅而非气泡
    """
    # 阈值优化：拉大中间「不确定」带，减少误判
    margin = max(20.0, float(half_w) * 0.08)

    # 宽度辅助判断：太宽且居中的可能是系统横幅
    if box_width > msg_area_width * 0.70:
        # 判断是否居中：cx 在中线附近 ±10% 范围内
        if abs(cx - mid_x) < half_w * 0.10:
            return "unknown"  # 可能是系统横幅

    if cx < mid_x - margin:
        return "buyer"
    if cx > mid_x + margin:
        return "seller"
    return "unknown"


@dataclass
class OcrLineVisual:
    """供 smoke 在截图上标注。"""

    box: OcrTextBox
    role: str


def ocr_message_area_with_roles(
    bgr: np.ndarray,
    win: ScreenRect,
    message_area: ScreenRect,
) -> tuple[list[OcrLineVisual], list[OcrTextBox]]:
    """
    对 message_area 内「正文带」做 OCR（已去掉顶部横幅区域），返回带角色标签的行列表。
    """
    body = message_body_area(message_area)
    crop, ox, oy = crop_window_bgr(bgr, win, body)
    if crop.size == 0 or not paddle_available():
        return [], []

    save_debug_bgr(crop, "message_area_ocr", event_type="ocr_extract")

    sx0, sy0 = bgr_crop_origin_to_screen(win, bgr, ox, oy)
    boxes = ocr_bgr_to_boxes(
        crop,
        win_left=sx0,
        win_top=sy0,
        cache_ttl_sec=0.0,
    )
    _save_message_ocr_debug_images(bgr, win, message_area, body, boxes)

    mid_x = (float(message_area.left) + float(message_area.right)) / 2.0
    half_w = float(message_area.w) / 2.0
    msg_area_width = float(message_area.w)

    visuals: list[OcrLineVisual] = []
    for b in boxes:
        if float(b.confidence) < _MIN_CONF:
            continue
        t = (b.text or "").strip()
        if _is_extra_message_line_noise(t):
            continue
        # 增加「已读/未读」标记过滤
        if "已读" in t or "未读" in t:
            if len(t) <= 4:  # 小字标记通常是 2-4 个字符
                log.debug("[消息OCR] 过滤已读/未读标记: %r", t)
                continue
        cx = (float(b.left) + float(b.right)) / 2.0
        box_width = float(b.right) - float(b.left)
        role = _role_for_box(cx, mid_x, half_w, box_width, msg_area_width)
        visuals.append(OcrLineVisual(box=b, role=role))
    # 阅读顺序：自上而下
    visuals.sort(key=lambda v: (v.box.top, v.box.left))
    return visuals, boxes


def _text_substantive(s: str) -> bool:
    t = re.sub(r"\s+", "", (s or "").strip())
    return len(t) >= _MIN_BUYER_TEXT_LEN


def _merge_latest_buyer_cluster(
    buyer_boxes: list[OcrTextBox],
) -> tuple[str, list[OcrTextBox]]:
    """
    从底部往上取最近一条买家气泡簇（靠左、非横幅、非系统句）。
    """
    usable = [
        b
        for b in buyer_boxes
        if not _is_timestamp_only(b.text or "")
        and _text_substantive(b.text or "")
        and is_probable_buyer_bubble_text(b.text or "")
    ]
    if not usable:
        return "", []
    # 最底一条买家气泡（y 最大）
    usable.sort(key=lambda b: b.bottom, reverse=True)
    cluster = [usable[0]]
    for b in usable[1:]:
        last = cluster[-1]
        # b 在 last 上方且间距像同一条气泡
        if last.top - b.bottom <= 22 and b.bottom < last.top:
            cluster.append(b)
        else:
            break
    cluster.reverse()
    text = "\n".join((x.text or "").strip() for x in cluster if (x.text or "").strip())
    return text, cluster


def _pick_timestamp_near(
    all_boxes: list[OcrTextBox],
    cluster: list[OcrTextBox],
) -> str:
    """在簇上方最近一行里找日期时间串。"""
    if not cluster:
        return ""
    min_top = min(b.top for b in cluster)
    candidates = [b for b in all_boxes if b.bottom <= min_top + 4]
    candidates.sort(key=lambda b: b.bottom, reverse=True)
    for b in candidates[:5]:
        t = (b.text or "").strip()
        m = _TS_FULL.search(t)
        if m:
            return m.group(0).strip()
        if _TS_DATE_ONLY.match(t):
            return t
    return ""


def extract_latest_buyer_message_detail(
    bgr: np.ndarray,
    win: ScreenRect,
    message_area: ScreenRect,
) -> tuple[dict[str, Any] | None, list[OcrTextBox], list[OcrLineVisual]]:
    """
    与 extract_latest_buyer_message 相同逻辑，额外返回买家簇框（供调试图高亮）与全部带角色行。
    """
    if not paddle_available():
        log.warning("Paddle 不可用，无法 OCR 消息区")
        return None, [], []

    visuals, boxes = ocr_message_area_with_roles(bgr, win, message_area)
    if not boxes:
        return None, [], visuals

    buyers = [v.box for v in visuals if v.role == "buyer"]
    text, cluster = _merge_latest_buyer_cluster(buyers)
    if not _text_substantive(text):
        log.info(
            "message_area 未解析到足够长的买家正文（可能偏左判定/OCR 碎片；可调 mid 或阈值）"
        )
        return None, [], visuals

    ts = _pick_timestamp_near(boxes, cluster)
    msg = {"role": "buyer", "text": text.strip(), "timestamp": ts}
    return msg, cluster, visuals


def extract_latest_buyer_message(
    bgr: np.ndarray,
    win: ScreenRect,
    message_area: ScreenRect,
) -> dict[str, Any] | None:
    """
    在 message_area 内 OCR，取最新一条买家消息。

    返回 {"role": "buyer", "text": "...", "timestamp": "..."}；无法解析时 None。
    """
    msg, _, _ = extract_latest_buyer_message_detail(bgr, win, message_area)
    return msg


def latest_buyer_message_ocr(
    bgr: np.ndarray,
    win: ScreenRect,
    message_area: ScreenRect,
) -> str | None:
    """供 main 使用：仅返回正文，无则 None。"""
    d = extract_latest_buyer_message(bgr, win, message_area)
    if not d:
        return None
    t = (d.get("text") or "").strip()
    return t if t else None
