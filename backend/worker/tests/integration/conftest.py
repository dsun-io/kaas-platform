r"""worker 写入路径测试的**真 Postgres** 底座（task-8 / 路线 C 子集）。

为什么要这层
------------
worker 用裸 asyncpg 手写 SQL，而 orchestrator 用 SQLAlchemy ORM。ORM 的
`default=` 只是**客户端行为**，不会生成 DDL 默认值；worker 的 INSERT 一旦漏写
"NOT NULL 且无 server_default" 的列就是线上 500。近两起线上事故都是这个形状：

- `customers.plan` / `customers.status`（2026-10-17，创建客户 500）；
- `quotations.schema_version`（2026-10-19，手动录报价 500）。

现有 worker 测试用假 DB（monkeypatch 连接）只能证明"SQL 长这样"，证明不了
"schema 真接受这条 SQL"。本目录的用例打**真 PG + 真迁移**，专门堵这个盲区。

schema 来源
-----------
`backend/orchestrator/alembic` 的 `alembic upgrade head`。**不手写 DDL**，
保证测试库 schema 与生产迁移一致（迁移漏列/漏 NOT NULL 默认值，测试会一起红）。

测试库从哪来（按顺序）
----------------------
1. 环境变量 `TEST_DATABASE_URL`（CI / 已有 PG）：直接用它，不再拉起本地服务，
   但仍会跑 alembic upgrade head（设 `KAAS_TEST_SKIP_MIGRATE=1` 可跳过，
   前提是外部已建好 schema）。
2. 否则自动拉起一台本地 PostgreSQL（随机端口、临时数据目录）：
   - 优先 `pgserver` 包自带的 PG16 二进制（POC 已实测可用）；
   - 其次 PATH 里的 `pg_ctl`/`initdb`、`C:\Program Files\PostgreSQL\*\bin`、
     `/usr/lib/postgresql/*/bin`。
3. 找不到二进制 / 找不到能跑 alembic 的解释器 / 起不来 → **pytest.skip**，
   保证 `python -m pytest backend/worker`（默认、无库环境）仍是绿的。

本地覆盖（可选，gitignored）
---------------------------
在 `backend/worker/tests/integration/.pgtest.local` 里写 `KEY=VALUE`（同样可用
环境变量传，环境变量优先）：

    PG_BIN=D:\\kaas-poc\\pginstall\\bin      # PG 二进制目录（含 initdb/pg_ctl）
    KAAS_ALEMBIC_PYTHON=...                  # 能 import alembic+sqlalchemy+psycopg2 的解释器
    KAAS_TEST_PGDATA=D:\\kaas-pgtest         # 纯 ASCII 数据目录（中文用户名下 initdb 会炸）
    TEST_DATABASE_URL=postgresql+asyncpg://...  # 直接指定现成测试库

跑法见同目录 `README.md`；`@pytest.mark.integration` 隔离，`-m "not integration"`
可跳过本目录。
"""
from __future__ import annotations

import asyncio
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import unquote, urlsplit

import pytest

# tests/integration/conftest.py → tests/ → worker/ → backend/ → <repo>
INTEGRATION_DIR = Path(__file__).resolve().parent
TESTS_DIR = INTEGRATION_DIR.parent
WORKER_DIR = TESTS_DIR.parent
REPO_ROOT = WORKER_DIR.parents[1]
ORCH_DIR = REPO_ROOT / "backend" / "orchestrator"

# 测试期固定绑定（生产值来自 Worker vars/secrets；本地用固定串即可）。
ADMIN_SETUP_TOKEN = "integration-admin-setup-token"
JWT_SECRET = "integration-test-jwt-secret-0123456789abcdef"

# `_bootstrap.py` 在 tests/ 下，必须先把 tests/ 放进 sys.path。
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))


# ── 本地覆盖配置 ──────────────────────────────────────────────────────────────


def _read_local_config() -> dict[str, str]:
    """读 gitignored 的 `.pgtest.local`（没有就当空）。"""
    path = Path(
        os.environ.get("KAAS_TEST_LOCAL_CONFIG", str(INTEGRATION_DIR / ".pgtest.local"))
    )
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip()
    return out


_LOCAL = _read_local_config()


def _opt(name: str) -> str | None:
    """环境变量优先，其次 `.pgtest.local`。"""
    return os.environ.get(name) or _LOCAL.get(name) or None


# ── PG 二进制发现 ─────────────────────────────────────────────────────────────


def _exe(bin_dir: Path, name: str) -> Path | None:
    for filename in (f"{name}.exe", name):
        candidate = Path(bin_dir) / filename
        if candidate.is_file():
            return candidate
    return None


def _pgserver_bin_dir() -> Path | None:
    """pgserver 包自带的 PG16 二进制目录（装了才有）。"""
    try:
        import pgserver  # noqa: PLC0415
    except Exception:  # pragma: no cover - 只是"有没有"
        return None
    pkg = Path(pgserver.__file__).resolve().parent
    for sub in ("pginstall", "postgres"):
        candidate = pkg / sub / "bin"
        if _exe(candidate, "initdb") is not None:
            return candidate
    return None


def _pg_bin_dir() -> Path | None:
    candidates: list[Path] = []
    explicit = _opt("PG_BIN")
    if explicit:
        candidates.append(Path(explicit))
    discovered = _pgserver_bin_dir()
    if discovered is not None:
        candidates.append(discovered)

    pg_ctl = shutil.which("pg_ctl")
    if pg_ctl:
        candidates.append(Path(pg_ctl).resolve().parent)

    for root in (Path(r"C:\Program Files\PostgreSQL"), Path("/usr/lib/postgresql")):
        if root.is_dir():
            candidates.extend(sorted((d / "bin" for d in root.iterdir()), reverse=True))

    for candidate in candidates:
        if _exe(candidate, "initdb") is not None and _exe(candidate, "pg_ctl") is not None:
            return candidate
    return None


def _ascii_path(path: Path) -> bool:
    try:
        str(path).encode("ascii")
    except UnicodeEncodeError:
        return False
    return True


def _pg_base_dir() -> Path | None:
    """initdb 数据目录的父目录。必须是纯 ASCII（中文用户名路径会让 initdb 报错）。"""
    explicit = _opt("KAAS_TEST_PGDATA")
    if explicit:
        return Path(explicit)
    candidates = [
        INTEGRATION_DIR / ".pytest-pg",  # 仓库路径通常 ASCII，且已在 tests/ 写入范围内
        Path(tempfile.gettempdir()) / "kaas-pgtest",
        Path(f"{os.environ.get('SystemDrive', 'C:')}/kaas-pgtest"),
    ]
    for candidate in candidates:
        if _ascii_path(candidate):
            return candidate
    return None


# ── alembic 解释器发现 ────────────────────────────────────────────────────────


def _can_run_alembic(python: Path) -> bool:
    """该解释器要能 import alembic + sqlalchemy + psycopg2（同步迁移用）。"""
    try:
        proc = subprocess.run(
            [str(python), "-c", "import alembic, sqlalchemy, psycopg2"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=60,
        )
    except Exception:
        return False
    return proc.returncode == 0


def _alembic_python() -> Path | None:
    candidates: list[Path] = []
    explicit = _opt("KAAS_ALEMBIC_PYTHON")
    if explicit:
        candidates.append(Path(explicit))
    candidates.append(Path(sys.executable))

    # worktree 里没有 orchestrator/.venv（.venv 是 gitignored 的），
    # 依次往上找：worktree → 主工作区。CI 里 orchestrator 目录下自带 .venv。
    for base in (REPO_ROOT, *REPO_ROOT.parents):
        venv = base / "backend" / "orchestrator" / ".venv"
        candidates.extend([venv / "Scripts" / "python.exe", venv / "bin" / "python"])

    for candidate in candidates:
        if candidate.is_file() and _can_run_alembic(candidate):
            return candidate
    return None


# ── 数据库信息 / 连接 ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PgInfo:
    host: str
    port: int
    user: str
    password: str | None
    database: str

    @property
    def asyncpg_dsn(self) -> str:
        from urllib.parse import quote

        auth = quote(self.user, safe="")
        if self.password:
            auth += ":" + quote(self.password, safe="")
        return f"postgresql://{auth}@{self.host}:{self.port}/{self.database}"

    @property
    def alembic_url(self) -> str:
        """alembic env.py 会去掉 +asyncpg；app.db.session 又要求 async 驱动，故两者都要。"""
        return self.asyncpg_dsn.replace("postgresql://", "postgresql+asyncpg://", 1)


def _parse_database_url(raw: str) -> PgInfo:
    # asyncpg / psycopg2 的 scheme 都归一成普通 postgresql 再解析。
    cleaned = raw.replace("+asyncpg", "").replace("+psycopg2", "").replace(
        "+psycopg", ""
    )
    parts = urlsplit(cleaned)
    if not parts.hostname:
        pytest.fail(f"TEST_DATABASE_URL 解析不出 host：{raw!r}")
    database = parts.path.lstrip("/")
    if not database:
        pytest.fail(f"TEST_DATABASE_URL 解析不出库名：{raw!r}")
    return PgInfo(
        host=parts.hostname,
        port=parts.port or 5432,
        user=unquote(parts.username or "postgres"),
        password=unquote(parts.password) if parts.password else None,
        database=unquote(database),
    )


class Database:
    """同步小helper：每个调用独立 asyncpg 连接（worker 每请求也独立连接）。"""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    def _run(self, coro):
        return asyncio.run(coro)

    async def _connect(self):
        import asyncpg  # noqa: PLC0415

        return await asyncpg.connect(self._dsn)

    def fetch(self, sql: str, *args) -> list[dict]:
        async def go():
            conn = await self._connect()
            try:
                return [dict(row) for row in await conn.fetch(sql, *args)]
            finally:
                await conn.close()

        return self._run(go())

    def fetchrow(self, sql: str, *args) -> dict | None:
        async def go():
            conn = await self._connect()
            try:
                row = await conn.fetchrow(sql, *args)
                return dict(row) if row is not None else None
            finally:
                await conn.close()

        return self._run(go())

    def fetchval(self, sql: str, *args):
        async def go():
            conn = await self._connect()
            try:
                return await conn.fetchval(sql, *args)
            finally:
                await conn.close()

        return self._run(go())

    def execute(self, sql: str, *args) -> str:
        async def go():
            conn = await self._connect()
            try:
                return await conn.execute(sql, *args)
            finally:
                await conn.close()

        return self._run(go())

    def reset(self) -> None:
        """清空业务表（保留 alembic_version），每个用例前跑，保证互相独立。"""

        async def go():
            conn = await self._connect()
            try:
                rows = await conn.fetch(
                    "SELECT tablename FROM pg_tables WHERE schemaname='public'"
                )
                names = [r["tablename"] for r in rows if r["tablename"] != "alembic_version"]
                if not names:
                    return
                quoted = ", ".join('"' + n.replace('"', '""') + '"' for n in names)
                await conn.execute(f"TRUNCATE TABLE {quoted} RESTART IDENTITY CASCADE")
            finally:
                await conn.close()

        self._run(go())


# ── 本地 PG 进程管理 ──────────────────────────────────────────────────────────


@dataclass
class _LocalServer:
    info: PgInfo
    bin_dir: Path
    data_dir: Path
    log_path: Path


def _free_port() -> int:
    sock = socket.socket()
    try:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]
    finally:
        sock.close()


def _log_tail(path: Path, limit: int = 4000) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")[-limit:]
    except OSError:
        return "(无日志)"


def _start_local_server(bin_dir: Path, base_dir: Path) -> _LocalServer:
    data_dir = base_dir / f"pgdata-{uuid.uuid4().hex[:8]}"
    data_dir.parent.mkdir(parents=True, exist_ok=True)
    log_path = base_dir / f"{data_dir.name}.log"
    initdb = _exe(bin_dir, "initdb")
    pg_ctl = _exe(bin_dir, "pg_ctl")
    assert initdb is not None and pg_ctl is not None

    # --locale=C 是必须的：中文 Windows 默认 locale 会让 initdb 的
    # "invalid byte sequence for encoding UTF8" 直接失败（POC 踩过）。
    proc = subprocess.run(
        [
            str(initdb),
            "-D",
            str(data_dir),
            "-U",
            "postgres",
            "--auth=trust",
            "-E",
            "UTF8",
            "--locale=C",
        ],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
    )
    if proc.returncode != 0:
        pytest.skip(
            "initdb 失败（本地 PG 无法拉起到纯 ASCII 路径；可设 KAAS_TEST_PGDATA）：\n"
            + (proc.stderr or proc.stdout)[-3000:]
        )

    port = _free_port()
    # stdout/stderr 必须重定向到 DEVNULL：Windows 上 postgres 子进程会继承
    # pg_ctl 的输出句柄，若走管道，subprocess 会等一个永远不关闭的管道而挂死。
    proc = subprocess.run(
        [
            str(pg_ctl),
            "start",
            "-D",
            str(data_dir),
            "-l",
            str(log_path),
            "-w",
            "-o",
            f"-p {port} -h 127.0.0.1",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=180,
    )
    if proc.returncode != 0:
        _stop_local_server(bin_dir, data_dir, remove=False)
        pytest.skip(f"pg_ctl start 失败（端口 {port}）：\n{_log_tail(log_path)}")

    database = f"kaas_it_{uuid.uuid4().hex[:10]}"
    info = PgInfo("127.0.0.1", port, "postgres", None, database)
    return _LocalServer(info=info, bin_dir=bin_dir, data_dir=data_dir, log_path=log_path)


def _stop_local_server(
    bin_dir: Path,
    data_dir: Path,
    *,
    log_path: Path | None = None,
    remove: bool = True,
) -> None:
    pg_ctl = _exe(bin_dir, "pg_ctl")
    if pg_ctl is not None:
        try:
            subprocess.run(
                [str(pg_ctl), "stop", "-D", str(data_dir), "-m", "fast", "-w"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=180,
            )
        except OSError:
            # 服务已经停了 / 句柄异常不该把测试结果变成 ERROR。
            pass
    if remove:
        shutil.rmtree(data_dir, ignore_errors=True)
        if log_path is not None:
            try:
                log_path.unlink()
            except OSError:
                pass


async def _create_database(info: PgInfo) -> None:
    import asyncpg  # noqa: PLC0415

    conn = await asyncpg.connect(
        host=info.host,
        port=info.port,
        user=info.user,
        password=info.password,
        database="postgres",
        ssl=False,
    )
    try:
        await conn.execute(f'CREATE DATABASE "{info.database}"')
    finally:
        await conn.close()


# ── schema 准备（alembic 空库快径 + 补建 legacy 表）──────────────────────────
#
# 本机实测确认：orchestrator 的 alembic **不能**从空库逐条重放历史迁移链 ——
#   · `alembic/env.py` 对空库走「快径」：直接 `Base.metadata.create_all()` + stamp head，
#     跳过整条历史链（见 app/db/migration_bootstrap.py，2026-10-17 决策）；
#   · 真有办法强制走链也不行：`f82ac951b473` 无条件 create 36 张表，与更早的
#     flywheel_foundation 等迁移重复 ⇒ 空库逐条 upgrade 会在
#     `relation "customer_capabilities" already exists` 处炸掉（已实测）。
# 所以「用 alembic upgrade head 建库」在空库上得到的其实就是 ORM metadata schema。
#
# 但 env.py 只 import 了 `app.db.models` / `app.db.tax_models`，**漏了**
# `app.db.workstation_models`（cust_contacts / cust_inquiries / cust_stage_log /
# trade_doc_*_refs / fx_rates 等 legacy 表）。worker 的客户工位直接读写这批表 ⇒
# 只走快径建出来的库**没有 cust_contacts**，worker 创建客户必 500。
# 这是**新建环境（预览环境 / CI 全新库 / 本机）的真实风险**，已报给 lead；
# 正解应在 orchestrator `alembic/env.py` 补 import（不在本任务写范围）。
#
# 本测试底座的补偿（不掩盖风险，只让 worker 用例跑在"生产有这些表"的前提上）：
# alembic 跑完后若缺这些 legacy 表，就用 workstation_models 的 metadata
# `create_all(checkfirst=True)` **只补缺失的表**，并断言 worker 写入路径依赖的表都在。
# 注意：这套 schema 与生产历史迁移后的形状"近似"而非逐字节一致，README 已写明。

_SUPPLEMENT_SCRIPT = """
import os

from sqlalchemy import create_engine

from app.db.base import Base
import app.db.models  # noqa: F401
import app.db.tax_models  # noqa: F401
import app.db.workstation_models  # noqa: F401  (legacy cust_* 等表，env.py 漏 import)

engine = create_engine(os.environ["KAAS_TEST_SYNC_URL"])
Base.metadata.create_all(engine, checkfirst=True)  # checkfirst: 只补缺失的表
engine.dispose()
"""


async def _connect_info(info: PgInfo):
    import asyncpg  # noqa: PLC0415

    return await asyncpg.connect(
        host=info.host,
        port=info.port,
        user=info.user,
        password=info.password,
        database=info.database,
        ssl=False,
    )


def _db_tables(info: PgInfo) -> set[str]:
    async def go():
        conn = await _connect_info(info)
        try:
            rows = await conn.fetch(
                "SELECT tablename FROM pg_tables WHERE schemaname='public'"
            )
            return {r["tablename"] for r in rows}
        finally:
            await conn.close()

    return asyncio.run(go())


def _migrate(python: Path, info: PgInfo) -> None:
    """建 schema：alembic upgrade head → 缺 legacy 表则补建 → 断言关键表齐全。"""
    if _opt("KAAS_TEST_SKIP_MIGRATE") in ("1", "true", "True"):
        return

    env = dict(os.environ)
    env["DATABASE_URL"] = info.alembic_url
    env["PYTHONUTF8"] = "1"
    # env.py 自己会插 alembic 的父目录；backend/ 是为了 kaas_common（若有 import）。
    env["PYTHONPATH"] = os.pathsep.join([str(ORCH_DIR), str(REPO_ROOT / "backend")])
    proc = subprocess.run(
        [str(python), "-m", "alembic", "upgrade", "head"],
        cwd=str(ORCH_DIR),
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=900,
    )
    output = (proc.stdout or "") + "\n" + (proc.stderr or "")
    if proc.returncode != 0:
        if "is not available" in output and "extension" in output:
            pytest.skip(
                "本地 PostgreSQL 缺少生产迁移需要的 contrib 扩展（详见 alembic 输出）。"
                "pgserver 自带二进制是精简版（无 contrib）；请用 PG_BIN 指向完整 "
                "PostgreSQL 安装，或设 TEST_DATABASE_URL。\n" + output[-4000:]
            )
        pytest.fail(
            "alembic upgrade head 失败：测试库 schema 建不起来，真 PG 用例没有意义。\n"
            f"命令: {python} -m alembic upgrade head (cwd={ORCH_DIR})\n"
            f"输出:\n{output[-6000:]}"
        )

    missing = _missing_required_tables(info)
    if missing:
        # env.py 漏 import app.db.workstation_models ⇒ 空库快径不会建 cust_* 等 legacy 表。
        # 这里只补缺，不重建已有表（详见本节顶部说明）。
        _supplement_legacy_tables(python, info)
        missing = _missing_required_tables(info)
    if missing:
        pytest.fail(
            "测试库缺少 worker 写入路径依赖的表："
            f"{missing}\n"
            "alembic 快径 + workstation_models 补建之后仍然缺表，"
            "真 PG 用例会失去意义（schema 与生产不一致）。"
        )


_REQUIRED_TABLES = (
    "users",
    "teams",
    "customers",
    "cust_contacts",
    "quotations",
    "team_subscriptions",
)


def _missing_required_tables(info: PgInfo) -> list[str]:
    tables = _db_tables(info)
    return [t for t in _REQUIRED_TABLES if t not in tables]


def _supplement_legacy_tables(python: Path, info: PgInfo) -> None:
    env = dict(os.environ)
    env["DATABASE_URL"] = info.alembic_url
    env["KAAS_TEST_SYNC_URL"] = info.asyncpg_dsn
    env["PYTHONUTF8"] = "1"
    env["PYTHONPATH"] = os.pathsep.join([str(ORCH_DIR), str(REPO_ROOT / "backend")])
    proc = subprocess.run(
        [str(python), "-c", _SUPPLEMENT_SCRIPT],
        cwd=str(ORCH_DIR),
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
    )
    if proc.returncode != 0:
        output = (proc.stdout or "") + "\n" + (proc.stderr or "")
        pytest.fail(
            "补建 legacy 表失败（app.db.workstation_models 的 metadata create_all）：\n"
            f"{output[-6000:]}"
        )


# ── fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture(scope="session")
def pg_info() -> PgInfo:
    """测试库信息；整条链路不可用时 skip（而不是 error），保证默认门禁绿。"""
    alembic_python = _alembic_python()
    if alembic_python is None:
        pytest.skip(
            "找不到能跑 alembic 的解释器（需 import alembic/sqlalchemy/psycopg2）。"
            "设 KAAS_ALEMBIC_PYTHON=<orchestrator venv python> 或 TEST_DATABASE_URL。"
        )

    raw_url = _opt("TEST_DATABASE_URL")
    if raw_url:
        info = _parse_database_url(raw_url)
        _migrate(alembic_python, info)
        yield info
        return

    bin_dir = _pg_bin_dir()
    if bin_dir is None:
        pytest.skip(
            "无本地 PostgreSQL：未找到 pgserver / pg_ctl 二进制，且未设 TEST_DATABASE_URL。"
            "（pgserver 目前没有 cp313/cp314 wheel，Python 3.14 下装不上；"
            "可用 PG_BIN 指向任意 PG16 二进制目录，见 README）"
        )

    base_dir = _pg_base_dir()
    if base_dir is None:
        pytest.skip("找不到纯 ASCII 的数据目录（中文用户名下 initdb 失败）；设 KAAS_TEST_PGDATA")

    server = _start_local_server(bin_dir, base_dir)
    try:
        asyncio.run(_create_database(server.info))
        _migrate(alembic_python, server.info)
        yield server.info
    finally:
        _stop_local_server(
            server.bin_dir, server.data_dir, log_path=server.log_path
        )


@pytest.fixture(scope="session")
def db(pg_info: PgInfo) -> Database:
    return Database(pg_info.asyncpg_dsn)


@pytest.fixture(autouse=True)
def _reset_between_tests(db: Database) -> None:
    db.reset()


@pytest.fixture(scope="session")
def worker_main():
    """复用 worker 测试统一起手式（stub `workers` + 彻底重载 main 及路由模块）。"""
    from _bootstrap import load_main  # noqa: PLC0415

    return load_main()


@pytest.fixture(scope="session")
def worker_env(pg_info: PgInfo):
    """模拟 `request.scope["env"]`：HYPERDRIVE 指向测试库 + 请求期 secrets。"""
    hyperdrive = SimpleNamespace(
        host=pg_info.host,
        port=pg_info.port,
        user=pg_info.user,
        password=pg_info.password,
        database=pg_info.database,
    )
    return SimpleNamespace(
        HYPERDRIVE=hyperdrive,
        JWT_SECRET=JWT_SECRET,
        ADMIN_SETUP_TOKEN=ADMIN_SETUP_TOKEN,
        RESEND_API_KEY="",
    )


class _EnvInjector:
    """最外层 ASGI 包装：给每个请求塞入测试 env，其余完全走真实 FastAPI 应用。

    这样 `main._acquire` / `platform.db.acquire` 读到的 `request.scope["env"]`
    与生产一致（而不是 monkeypatch 掉连接函数），测试覆盖到鉴权、参数模型、
    事务和 SQL 的完整链路。
    """

    def __init__(self, app, env) -> None:
        self.app = app
        self.env = env

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") in ("http", "websocket"):
            scope = dict(scope)
            scope["env"] = self.env
        await self.app(scope, receive, send)


@pytest.fixture(scope="session")
def client(worker_main, worker_env):
    from fastapi.testclient import TestClient  # noqa: PLC0415

    test_client = TestClient(
        _EnvInjector(worker_main.app, worker_env), raise_server_exceptions=False
    )
    try:
        yield test_client
    finally:
        test_client.close()


@pytest.fixture(scope="session")
def admin_setup_token() -> str:
    return ADMIN_SETUP_TOKEN
