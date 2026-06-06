import atexit
import io
import logging
import sys
import threading
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path
from typing import TextIO

from app.config import settings

_tee_lock = threading.Lock()
_tee_fp: io.TextIOWrapper | None = None
_tee_installed = False
_logging_configured = False
_excepthook_installed = False


class _TeeTextIO(TextIO):
    """同时写入原流与日志文件（仅用于控制台镜像）。"""

    def __init__(self, original: TextIO, mirror: io.TextIOWrapper) -> None:
        self._original = original
        self._mirror = mirror

    def write(self, s: str) -> int:
        self._original.write(s)
        if s:
            with _tee_lock:
                try:
                    if not getattr(self._mirror, "closed", True):
                        self._mirror.write(s)
                        self._mirror.flush()
                except (OSError, ValueError):
                    pass
        return len(s)

    def flush(self) -> None:
        self._original.flush()
        with _tee_lock:
            try:
                if not getattr(self._mirror, "closed", True):
                    self._mirror.flush()
            except (OSError, ValueError):
                pass

    def isatty(self) -> bool:
        return self._original.isatty()

    def fileno(self) -> int:
        return self._original.fileno()

    def writable(self) -> bool:
        return True


def _close_tee_file() -> None:
    global _tee_fp, _tee_installed
    # 先恢复标准流，避免解释器退出阶段对已关闭的 mirror 再 flush
    if _tee_installed:
        sys.stdout = sys.__stdout__
        sys.stderr = sys.__stderr__
        _tee_installed = False
    if _tee_fp is not None:
        try:
            _tee_fp.flush()
            _tee_fp.close()
        except Exception:
            pass
        _tee_fp = None


def _install_console_tee(log_dir: Path) -> None:
    global _tee_fp, _tee_installed
    if _tee_installed or not settings.log_console_tee:
        return
    log_dir.mkdir(parents=True, exist_ok=True)
    console_path = log_dir / "console.log"
    _tee_fp = open(console_path, "a", encoding="utf-8", buffering=1)
    sys.stdout = _TeeTextIO(sys.__stdout__, _tee_fp)
    sys.stderr = _TeeTextIO(sys.__stderr__, _tee_fp)
    _tee_installed = True
    atexit.register(_close_tee_file)


def _install_excepthook() -> None:
    global _excepthook_installed
    if _excepthook_installed:
        return
    log_u = logging.getLogger("uncaught")

    def _hook(exc_type, exc, tb) -> None:
        log_u.critical("未捕获异常", exc_info=(exc_type, exc, tb))
        sys.__excepthook__(exc_type, exc, tb)

    sys.excepthook = _hook
    _excepthook_installed = True


def setup_logging() -> None:
    global _logging_configured
    log_dir = Path(settings.log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "rpa-qianniu.log"

    fmt = logging.Formatter(
        "%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    root = logging.getLogger()
    root.setLevel(logging.INFO)

    # 先镜像控制台，再挂 StreamHandler，这样 print 与 logging 在终端所见均写入 console.log
    _install_console_tee(log_dir)

    if not _logging_configured:
        fh = TimedRotatingFileHandler(
            log_file,
            when="midnight",
            interval=1,
            backupCount=14,
            encoding="utf-8",
        )
        fh.setFormatter(fmt)

        class _FlushingStreamHandler(logging.StreamHandler):
            def emit(self, record: logging.LogRecord) -> None:
                super().emit(record)
                self.flush()

        ch = _FlushingStreamHandler(sys.stdout)
        ch.setFormatter(fmt)

        root.handlers.clear()
        root.addHandler(fh)
        root.addHandler(ch)
        _install_excepthook()
        _logging_configured = True


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
