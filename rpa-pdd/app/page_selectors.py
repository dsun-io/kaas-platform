from __future__ import annotations

import json
import logging
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Any

from app.config import settings

log = logging.getLogger("page_selectors")


@dataclass
class PddSelectors:
    """请在浏览器开发者工具中核对后填写（优先 data-testid）。"""

    login_page_url_contains: str = ""
    chat_ready_selector: str = ""
    login_form_selector: str = ""
    session_list: str = ""
    session_item: str = ""
    session_item_unread: str = ""
    message_list: str = ""
    buyer_message_row: str = ""
    buyer_message_text: str = ""
    input_editor: str = ""
    send_button: str = ""


def _defaults_dict() -> dict[str, Any]:
    s = PddSelectors()
    return {f.name: getattr(s, f.name) for f in fields(PddSelectors)}


def load_selectors() -> PddSelectors:
    base = _defaults_dict()
    path = Path(settings.selectors_path)
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                for k, v in raw.items():
                    if k in base and isinstance(v, str):
                        base[k] = v
        except Exception as exc:
            log.warning("选择器文件解析失败，使用默认: %s | %s", path, exc)
    return PddSelectors(**base)


_cached: PddSelectors | None = None


def get_selectors() -> PddSelectors:
    global _cached
    if _cached is None:
        _cached = load_selectors()
        log.info("已加载页面选择器: %s", settings.selectors_path)
    return _cached


def reload_selectors() -> None:
    global _cached
    _cached = None
