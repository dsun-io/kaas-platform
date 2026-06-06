from __future__ import annotations

import hashlib
import os
import time
from dataclasses import dataclass
from typing import Any

import numpy as np

from app.logger import get_logger

log = get_logger("ocr_paddle")

# Paddle 3.3+：CPU 走 oneDNN/PIR 时可能 NotImplementedError（见 Paddle#77340）。
# FLAGS_use_mkldnn 对 PaddleOCR 3.x（PaddleX 后端）不一定生效，必须在 PaddleOCR(enable_mkldnn=False) 关闭。
os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

_OCR_ENGINE: Any = None
_CACHE_KEY: str | None = None
_CACHE_TS: float = 0.0
_CACHE_LINES: list["OcrTextBox"] = []
# 部分 Windows + Paddle 3.x + oneDNN 会在推理时 NotImplementedError，避免每帧重试
_PADDLE_PREDICT_BROKEN: bool = False
# 首次 predict 失败后强制用 enable_mkldnn=False 重建引擎（仅当构造参数支持时）
_FORCE_MKLDNN_OFF: bool = False
# 首次推理可能静默数分钟（CPU/模型编译），需给用户可见提示
_FIRST_PREDICT_HINT_PRINTED: bool = False
_FIRST_PREDICT_DONE_LOGGED: bool = False


@dataclass(frozen=True)
class OcrTextBox:
    text: str
    confidence: float
    left: int
    top: int
    right: int
    bottom: int


def paddle_available() -> bool:
    try:
        import paddleocr  # noqa: F401

        return True
    except Exception:
        return False


def get_ocr():
    """PaddleOCR 单例入口（与内部 _engine() 相同，禁止每轮 new PaddleOCR）。"""
    return _engine()


def _ocr_init_kwargs_candidates() -> list[dict[str, Any]]:
    """
    屏幕截图仅需检测+识别：用 mobile 模型、关闭文档/行向子流水线，显著缩短冷启动与首帧推理时间。
    指定 det/rec 模型名时勿再传 lang（否则会告警且被忽略）。
    """
    doc_off: dict[str, Any] = {
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
    }
    mobile: dict[str, Any] = {
        **doc_off,
        "enable_mkldnn": False,
        "text_detection_model_name": "PP-OCRv5_mobile_det",
        "text_recognition_model_name": "PP-OCRv5_mobile_rec",
    }
    # 优先：mobile + 关文档流水线 + 关 mkldnn
    out: list[dict[str, Any]] = [mobile]
    # mkldnn 参数不兼容时去掉 enable_mkldnn 再试
    out.append({k: v for k, v in mobile.items() if k != "enable_mkldnn"})
    # 不显式指定 det/rec 时仍尽量关文档子模块（可能回退到默认 server，较慢）
    out.append(
        {
            **doc_off,
            "lang": "ch",
            "enable_mkldnn": False,
        }
    )
    out.append({"lang": "ch", "enable_mkldnn": False})
    out.append({"lang": "ch"})
    out.append({})
    return out


def _engine():
    global _OCR_ENGINE, _FORCE_MKLDNN_OFF
    if _OCR_ENGINE is not None:
        return _OCR_ENGINE
    try:
        import paddle

        paddle.set_flags({"FLAGS_use_mkldnn": False})
    except Exception:
        pass
    from paddleocr import PaddleOCR

    log.info(
        "正在初始化 PaddleOCR（PP-OCRv5_mobile + 已关文档矫正；首次可能下载模型）…"
    )
    candidates = _ocr_init_kwargs_candidates()
    if _FORCE_MKLDNN_OFF:
        # 仅保留不含 enable_mkldnn 或显式 False 且能实例化的组合
        candidates = [
            {k: v for k, v in kw.items() if k != "enable_mkldnn"}
            for kw in candidates
        ]
        # 去重
        seen: set[frozenset[tuple[str, Any]]] = set()
        uniq: list[dict[str, Any]] = []
        for kw in candidates:
            key = frozenset(kw.items())
            if key in seen:
                continue
            seen.add(key)
            uniq.append(kw)
        candidates = uniq

    last_err: Exception | None = None
    for kwargs in candidates:
        try:
            _OCR_ENGINE = PaddleOCR(**kwargs)
            if kwargs.get("enable_mkldnn") is False:
                log.info("PaddleOCR 已使用 enable_mkldnn=False（CPU 不走 oneDNN）")
            det = kwargs.get("text_detection_model_name", "(默认)")
            rec = kwargs.get("text_recognition_model_name", "(默认)")
            log.info(
                "PaddleOCR 单例已创建 det=%s rec=%s doc_ori=%s unwarp=%s tline_ori=%s",
                det,
                rec,
                kwargs.get("use_doc_orientation_classify"),
                kwargs.get("use_doc_unwarping"),
                kwargs.get("use_textline_orientation"),
            )
            return _OCR_ENGINE
        except (TypeError, ValueError) as exc:
            last_err = exc
            continue
    log.warning("PaddleOCR 参数组合均失败，最后尝试无参构造: %s", last_err)
    _OCR_ENGINE = PaddleOCR()
    return _OCR_ENGINE


def _quick_hash_bgr(bgr: np.ndarray) -> str:
    small = bgr[:: max(1, bgr.shape[0] // 48), :: max(1, bgr.shape[1] // 48)]
    return hashlib.md5(small.tobytes()).hexdigest()


def _boxes_from_paddlex_page(page: Any, win_left: int, win_top: int) -> list[OcrTextBox]:
    """解析 PaddleOCR 3.x predict() 返回的 OCRResult（类 dict，含 rec_texts / rec_polys）。"""
    out: list[OcrTextBox] = []
    try:
        texts = page["rec_texts"]
        scores = page["rec_scores"]
        polys = page["rec_polys"]
    except (TypeError, KeyError):
        return out
    n = min(len(texts), len(polys))
    for i in range(n):
        txt = texts[i]
        if isinstance(txt, tuple):
            txt = txt[0]
        txt = str(txt or "").strip()
        if not txt:
            continue
        conf = float(scores[i]) if i < len(scores) else 0.0
        poly = np.asarray(polys[i], dtype=np.float64)
        if poly.size < 4:
            continue
        xs = poly[:, 0]
        ys = poly[:, 1]
        out.append(
            OcrTextBox(
                text=txt,
                confidence=conf,
                left=int(float(xs.min())) + win_left,
                top=int(float(ys.min())) + win_top,
                right=int(float(xs.max())) + win_left,
                bottom=int(float(ys.max())) + win_top,
            )
        )
    return out


def _boxes_from_legacy_rows(rows: list, win_left: int, win_top: int) -> list[OcrTextBox]:
    out: list[OcrTextBox] = []
    for item in rows:
        try:
            if not isinstance(item, (list, tuple)) or len(item) < 2:
                continue
            box = item[0]
            meta = item[1]
            if isinstance(meta, (list, tuple)) and len(meta) >= 2:
                txt, conf = meta[0], meta[1]
            elif isinstance(meta, dict):
                txt = meta.get("text", meta.get("transcription", ""))
                conf = float(meta.get("confidence", meta.get("score", 0.0)))
            else:
                continue
            xs = [float(p[0]) for p in box]
            ys = [float(p[1]) for p in box]
            out.append(
                OcrTextBox(
                    text=str(txt or "").strip(),
                    confidence=float(conf or 0.0),
                    left=int(min(xs)) + win_left,
                    top=int(min(ys)) + win_top,
                    right=int(max(xs)) + win_left,
                    bottom=int(max(ys)) + win_top,
                )
            )
        except Exception:
            continue
    return out


def ocr_bgr_to_boxes(
    bgr: np.ndarray,
    *,
    win_left: int,
    win_top: int,
    cache_ttl_sec: float,
) -> list[OcrTextBox]:
    """
    对窗口截图做 OCR，坐标转为屏幕坐标。
    在 ttl 内若图像指纹相同则复用上次的识别结果。
    """
    global _CACHE_KEY, _CACHE_TS, _CACHE_LINES, _PADDLE_PREDICT_BROKEN, _OCR_ENGINE, _FORCE_MKLDNN_OFF
    global _FIRST_PREDICT_HINT_PRINTED, _FIRST_PREDICT_DONE_LOGGED
    if _PADDLE_PREDICT_BROKEN:
        return []
    now = time.time()
    h = _quick_hash_bgr(bgr)
    key = f"{h}:{bgr.shape[0]}x{bgr.shape[1]}"
    if (
        cache_ttl_sec > 0
        and _CACHE_KEY == key
        and (now - _CACHE_TS) <= cache_ttl_sec
    ):
        return list(_CACHE_LINES)

    eng = _engine()
    if not _FIRST_PREDICT_HINT_PRINTED:
        _FIRST_PREDICT_HINT_PRINTED = True
        print(
            "[纯视觉] 首次 PaddleOCR 推理中（mobile 模型；CPU 上可能需数十秒，请勿关窗口）…",
            flush=True,
        )
        log.info(
            "首次 PaddleOCR predict 开始 shape=%sx%s",
            bgr.shape[1],
            bgr.shape[0],
        )
    try:
        raw = eng.predict(bgr)
    except NotImplementedError as exc:
        if not _FORCE_MKLDNN_OFF:
            log.warning(
                "PaddleOCR predict 走 oneDNN/PIR 失败，将强制 enable_mkldnn=False 重建引擎并重试一次: %s",
                exc,
            )
            _FORCE_MKLDNN_OFF = True
            _OCR_ENGINE = None
            try:
                eng = _engine()
                raw = eng.predict(bgr)
            except NotImplementedError as exc2:
                _PADDLE_PREDICT_BROKEN = True
                log.critical(
                    "PaddleOCR 推理仍失败（重试后）。请检查 paddlepaddle 版本或设 CHAT_OCR_ENABLED=false。"
                    " 详情: %s",
                    exc2,
                )
                _CACHE_KEY = key
                _CACHE_TS = now
                _CACHE_LINES = []
                return []
        else:
            _PADDLE_PREDICT_BROKEN = True
            log.critical(
                "PaddleOCR 推理在本机失败（Paddle 3.x oneDNN/PIR 问题）。"
                "可尝试: pip install \"paddlepaddle>=3.2.2,<3.3\" 或升级 paddleocr。"
                " 详情: %s",
                exc,
            )
            _CACHE_KEY = key
            _CACHE_TS = now
            _CACHE_LINES = []
            return []
    except Exception as exc:
        log.exception("PaddleOCR 调用失败: %s", exc)
        _CACHE_KEY = key
        _CACHE_TS = now
        _CACHE_LINES = []
        return []

    out: list[OcrTextBox] = []
    if raw is None:
        pass
    elif isinstance(raw, (list, tuple)) and len(raw) > 0:
        first = raw[0]
        if first is not None and hasattr(first, "__contains__") and "rec_texts" in first:
            for page in raw:
                out.extend(_boxes_from_paddlex_page(page, win_left, win_top))
        elif isinstance(first, (list, tuple)) and len(first) >= 2:
            legacy_rows: list = []
            for el in raw:
                if isinstance(el, (list, tuple)) and el and isinstance(el[0], (list, tuple)):
                    legacy_rows.extend(el)
                else:
                    legacy_rows.append(el)
            out = _boxes_from_legacy_rows(legacy_rows, win_left, win_top)
        else:
            log.warning("OCR 返回结构未识别: elem0=%s", type(first))
    else:
        log.warning("OCR 返回类型未识别: %s", type(raw))

    _CACHE_KEY = key
    _CACHE_TS = now
    _CACHE_LINES = out
    if _FIRST_PREDICT_HINT_PRINTED and not _FIRST_PREDICT_DONE_LOGGED:
        _FIRST_PREDICT_DONE_LOGGED = True
        print(
            f"[纯视觉] PaddleOCR 首次推理完成（本帧 {len(out)} 个文本框），后续会快很多。",
            flush=True,
        )
        log.info("PaddleOCR 首次 predict 完成，boxes=%s", len(out))
    return out


def invalidate_ocr_cache() -> None:
    global _CACHE_KEY, _CACHE_TS, _CACHE_LINES
    _CACHE_KEY = None
    _CACHE_TS = 0.0
    _CACHE_LINES = []


def reset_paddle_broken_flag() -> None:
    global _PADDLE_PREDICT_BROKEN
    _PADDLE_PREDICT_BROKEN = False
