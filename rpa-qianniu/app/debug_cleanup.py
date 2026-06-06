"""定期清理 debug/ 下 PNG，防止异常时磁盘堆积。"""

from __future__ import annotations

import glob
import os
import time

from app.config import settings
from app.logger import get_logger

log = get_logger("debug_cleanup")

MAX_DEBUG_FILES = 100
MAX_AGE_MINUTES = 120
CLEANUP_EVERY_N_LOOPS = 50

_loop_counter = 0


def maybe_cleanup(debug_dir: str | None = None) -> None:
    global _loop_counter
    _loop_counter += 1
    if _loop_counter % CLEANUP_EVERY_N_LOOPS != 0:
        return
    root = debug_dir or settings.vision_debug_dir or "debug"
    if not os.path.isdir(root):
        return

    files = sorted(glob.glob(os.path.join(root, "*.png")), key=os.path.getmtime)
    now = time.time()
    deleted = 0
    for f in files:
        try:
            if now - os.path.getmtime(f) > MAX_AGE_MINUTES * 60:
                os.remove(f)
                deleted += 1
        except OSError:
            continue

    files = sorted(glob.glob(os.path.join(root, "*.png")), key=os.path.getmtime)
    overflow = len(files) - MAX_DEBUG_FILES
    if overflow > 0:
        for f in files[:overflow]:
            try:
                os.remove(f)
                deleted += 1
            except OSError:
                continue

    if deleted > 0:
        n_left = len(glob.glob(os.path.join(root, "*.png")))
        log.info("[CLEANUP] 清理了 %s 张调试截图，当前剩余约 %s 张", deleted, n_left)
