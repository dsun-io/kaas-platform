"""单实例锁：防止多进程同时写 rpa-qianniu.log。"""

from __future__ import annotations

import atexit
import os
import sys
from pathlib import Path

from app.config import settings

_ATEXIT_REGISTERED = False


def _lock_path() -> Path:
    return Path(settings.state_dir) / ".rpa.lock"


def is_pid_alive(pid: int) -> bool:
    """判断进程是否存在。Windows 用 OpenProcess，避免 os.kill 误判。"""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        try:
            import ctypes

            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            h = ctypes.windll.kernel32.OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION, False, pid
            )
            if h:
                ctypes.windll.kernel32.CloseHandle(h)
                return True
            return False
        except Exception:
            return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _norm_exe_path(p: str) -> str:
    try:
        return os.path.normcase(os.path.normpath(os.path.realpath(p)))
    except OSError:
        return os.path.normcase(os.path.normpath(p))


def _win_process_executable_path(pid: int) -> str | None:
    """读取进程主模块路径；失败则 None。LIMITED 失败时尝试 VM_READ + Psapi。"""
    try:
        import ctypes
        from ctypes import wintypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        PROCESS_QUERY_INFORMATION = 0x0400
        PROCESS_VM_READ = 0x0010
        k32 = ctypes.windll.kernel32

        def _open_best() -> int:
            h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if h:
                return h
            return k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)

        h = _open_best()
        if not h:
            return None
        try:
            buf = ctypes.create_unicode_buffer(32_768)
            size = wintypes.DWORD(32_768)
            qfn = k32.QueryFullProcessImageNameW
            qfn.argtypes = [
                wintypes.HANDLE,
                wintypes.DWORD,
                wintypes.LPWSTR,
                ctypes.POINTER(wintypes.DWORD),
            ]
            qfn.restype = wintypes.BOOL
            if qfn(h, 0, buf, ctypes.byref(size)):
                return buf.value

            psapi = ctypes.windll.psapi
            gmfe = psapi.GetModuleFileNameExW
            gmfe.argtypes = [
                wintypes.HANDLE,
                wintypes.HANDLE,
                wintypes.LPWSTR,
                wintypes.DWORD,
            ]
            gmfe.restype = wintypes.DWORD
            n = gmfe(h, None, buf, 32_768)
            if n:
                return buf.value[: int(n)]
            return None
        finally:
            k32.CloseHandle(h)
    except Exception:
        return None


def _linux_process_executable_path(pid: int) -> str | None:
    try:
        return os.readlink(f"/proc/{pid}/exe")
    except OSError:
        return None


def process_executable_path(pid: int) -> str | None:
    if pid <= 0:
        return None
    if sys.platform == "win32":
        return _win_process_executable_path(pid)
    if sys.platform.startswith("linux"):
        return _linux_process_executable_path(pid)
    return None


def is_same_interpreter_process(pid: int) -> bool:
    """
    锁内 PID 是否仍为「当前这套 Python 解释器」的进程。
    用于排除 Windows PID 复用：仅占位符相同但已是别的程序时不应判为双开。
    """
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if not is_pid_alive(pid):
        return False
    remote = process_executable_path(pid)
    if not remote:
        return False
    return _norm_exe_path(remote) == _norm_exe_path(sys.executable)


def acquire_lock() -> None:
    global _ATEXIT_REGISTERED

    path = _lock_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        old_pid = -1
        try:
            old_pid = int(path.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            print(
                "[WARN] 锁文件损坏，自动清理。",
                file=sys.stderr,
            )
            try:
                path.unlink()
            except OSError:
                pass
        else:
            # 仅当「同 PID 且仍是本 venv 的 python」才判双开；避免 Win 上 PID 复用误杀
            if (
                old_pid > 0
                and old_pid != os.getpid()
                and is_same_interpreter_process(old_pid)
            ):
                print(
                    f"[ERROR] 已有 RPA 实例在运行 (PID={old_pid})，请先关闭再启动。",
                    file=sys.stderr,
                )
                sys.exit(1)
            if old_pid > 0 and old_pid != os.getpid():
                if not is_pid_alive(old_pid):
                    print(
                        f"[WARN] 残留锁文件 (PID={old_pid} 已不存在)，自动清理。",
                        file=sys.stderr,
                    )
                elif process_executable_path(old_pid) is None:
                    print(
                        f"[WARN] 残留锁文件 (PID={old_pid} 存活但无法读取镜像路径)，自动清理。",
                        file=sys.stderr,
                    )
                else:
                    print(
                        f"[WARN] 残留锁文件 (PID={old_pid} 与当前解释器不一致，可能为 PID 复用)，自动清理。",
                        file=sys.stderr,
                    )
            try:
                path.unlink()
            except OSError:
                pass
    path.write_text(str(os.getpid()), encoding="utf-8")
    print(f"[INIT] 已获取锁 (PID={os.getpid()})")
    if not _ATEXIT_REGISTERED:
        atexit.register(release_lock)
        _ATEXIT_REGISTERED = True


def release_lock() -> None:
    path = _lock_path()
    try:
        if path.exists():
            try:
                cur = int(path.read_text(encoding="utf-8").strip())
            except (OSError, ValueError):
                cur = -1
            if cur == os.getpid() or cur <= 0:
                try:
                    path.unlink()
                except OSError:
                    pass
    except OSError:
        pass
