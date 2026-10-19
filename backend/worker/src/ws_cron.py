"""KaaS Worker · Cloudflare Cron 定时任务（orchestrator APScheduler 迁移）。

背景（README §8 已知问题 #5）
---------------------------
orchestrator 用 APScheduler 注册了两个定时任务，但 orchestrator 在生产并不常驻，
所以**两个任务一次都没跑过**：

* **replied→询盘自动扫描** —— 真源 ``app/jobs/lead_scan.py``，原调度「每 15 分钟」；
  生产现状是手动 ``POST /api/v1/leads/scan-replied`` 对等（chain.py）。
* **events 每日归档** —— 真源 ``app/jobs/archive.py``，原调度「每日 00:30 Asia/Shanghai」；
  生产现状是 246 行事件无人归档。

本模块用 **Cloudflare Cron + 纯 asyncpg** 重建这两个任务。cron 表达式在
``backend/worker/wrangler.jsonc`` 的 ``triggers.crons``（**UTC**），``main.Default.scheduled``
按 ``controller.cron`` 精确匹配分派到这里的协程。

设计边界
--------
* **scheduled 事件没有 request**：Cloudflare 的 ``scheduled(controller, env, ctx)`` 只给 env，
  而 ``main._acquire(request)`` 要读 ``request.scope["env"]`` —— 所以这里按 env 直连
  Hyperdrive，连接参数与 ``main._acquire`` **逐项相同**（不是另造一套连接口径）。
* **不抛穿**：两个任务都是「catch → print → 返回结果字典」。Cron 失败不该让 Worker
  变错误态；``/cdn-cgi/local/scheduled?format=json`` 和日志里能看到 ``error`` 字段。
* **tenant 口径**：与 worker 全线一致，``tenant_id`` 恒为 ``"default"``；归档日志行
  的 tenant 是通配 ``"*"``（与 orchestrator ``insert_archive_log`` 同口径）。
* **编号/查重复用 main**：询盘编号走 ``main._next_inquiry_no``（与手动入口同一份规则），
  不在这里抄第二份。

与 orchestrator 版本的两处**有意偏差**（各自函数里也有标注）
------------------------------------------------------------
1. 转化出来的询盘可见性：orchestrator 的 job 给 ``owner_scope='tenant'``；这里改为
   ``'private'`` + ``team_id``，与 worker 手动入口 ``chain.lead_scan_replied`` 的隔离修正
   一致（见 chain.py 里那段注释）—— 否则一次定时任务会把某家公司的线索询盘暴露给
   同租户的其它团队。**同一动作不应因「手动 / 定时」而产出不同可见性的行。**
2. 归档时间窗：orchestrator 用 ``< 当天 23:59:59``（丢掉当天最后 1 秒）；这里用半开区间
   ``[00:00:00Z, 次日 00:00:00Z)``。归档只读不删，放大到整天不会丢数据、也不会重复扣减。
"""
from __future__ import annotations

import json
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import asyncpg

import main as _main

try:  # pragma: no cover - 真实 Workers（Pyodide）带 zlib，gzip 可用；缺了就降级，不让 import 炸掉整个 Worker
    import gzip
except Exception:  # noqa: BLE001
    gzip = None  # type: ignore[assignment]


# 与 main.DEFAULT_TENANT / platform/db.py 同口径。
# 这里重申而不在模块级读 `_main.DEFAULT_TENANT`：main 是在文件末尾才 import 本模块的，
# 模块级读 main 属性会踩「半初始化模块」；函数的调用期用 `_main.*` 才安全。
DEFAULT_TENANT = "default"


# ── Cron 表达式（UTC！必须与 wrangler.jsonc 的 triggers.crons 逐字符一致）──────────
# 分派靠 `controller.cron` 的精确字符串比较（Cloudflare 的契约，含空格都不能差），
# 所以两边的一致性由 tests/test_ws_cron.py::test_wrangler_crons_match_constants 锁死。
CRON_SCAN_REPLIED = "*/15 * * * *"   # 每 15 分钟：replied 线索 → 建询盘
CRON_ARCHIVE_EVENTS = "30 16 * * *"  # 每日 UTC 16:30 = Asia/Shanghai 次日 00:30
JOBS_BY_CRON = {
    CRON_ARCHIVE_EVENTS: "archive_events",
    CRON_SCAN_REPLIED: "scan_replied_leads",
}

# orchestrator app/jobs/archive.py 的 MAX_RETRIES
MAX_ARCHIVE_RETRIES = 3
# 归档对象键前缀与 orchestrator OSS 布局一致：events-archive/YYYY/MM/DD/v{N}.jsonl.gz
ARCHIVE_KEY_PREFIX = "events-archive"
# 归档日志里 minio_path 的 bucket 段；正常由 wrangler vars.S3_BUCKET 提供
DEFAULT_BUCKET_NAME = "kaas-files"
# replied 线索单轮扫描上限（orchestrator limit=100）
SCAN_LIMIT = 100

# cust_inquiries.status → lead_candidates.inquiry_status（最终设计 §7.2）。
# 真源 = orchestrator app/jobs/lead_scan.py 的 INQUIRY_SYNC_MAP；worker 手动路径里
# ws_crm_ext._LEAD_INQUIRY_STATUS 是同一份映射（PATCH 询盘时同步）。
# 注：orchestrator 的 docstring 写 open/quoted/won/lost，但**代码**是下面这组，
# 与 cust_inquiries 实际状态机（unquoted/quoted/closed）对齐 —— 以代码为准。
INQUIRY_SYNC_MAP = {"unquoted": "new", "quoted": "following", "closed": "lost"}


# ── 连接：与 main._acquire 同参数（scheduled 没有 request，故直接收 env）──────────


@asynccontextmanager
async def _acquire(env):
    """每任务一条 Hyperdrive 连接（参数与 `main._acquire` 逐项一致）。

    差异只有一个：scheduled 事件没有 request，hyperdrive binding 从 ``env`` 直接取，
    而不是 ``request.scope["env"]``。Keep in sync with main.py::_acquire。
    """
    hd = env.HYPERDRIVE
    conn = await asyncpg.connect(
        host=hd.host,
        port=int(hd.port),
        user=hd.user,
        password=hd.password,
        database=hd.database,
        ssl=False,
    )
    try:
        yield conn
    finally:
        await conn.close()


# ── 任务 1：replied → 询盘自动扫描（每 15 分钟）────────────────────────────────


async def _owner_team(conn, owner_id: Any) -> Any:
    """线索 owner 所在团队（客户/询盘归线索 owner 的团队，与 orchestrator 同口径）。

    ``lead_candidates.owner_id`` 是 TEXT；非数字（历史脏数据 / 系统账号）时退化为
    「无团队」而不是 ``int()`` 抛异常 —— 一条脏行不该把整轮扫描打挂（orchestrator
    直接 ``int()`` 会抛，这里是有意的健壮性差异）。
    """
    if not owner_id:
        return None
    try:
        uid = int(owner_id)
    except (TypeError, ValueError):
        return None
    return await conn.fetchval("SELECT team_id FROM users WHERE id=$1", uid)


async def _next_inquiry_no(conn, customer: dict) -> str:
    """询盘编号：复用 ``main._next_inquiry_no``（同秒冲突加后缀、20 次重试）。"""
    return await _main._next_inquiry_no(conn, customer)


async def scan_replied_leads(conn, tenant_id: str = DEFAULT_TENANT) -> dict:
    """扫描 replied 且未建询盘的线索 → 复用/新建客户档案 + 建询盘。

    语义逐项对齐 orchestrator ``app/jobs/lead_scan.py::scan_replied_leads``：
    - 条件：``outreach_status='replied'`` 且 ``inquiry_status='none'``（ORDER BY id，最多 100 条）；
    - 幂等：lead_id 已有询盘 → **不新建**，只按 INQUIRY_SYNC_MAP 回写线索状态；
    - 客户：按「租户 + 线索 owner 的团队 + 公司名」复用，没有则新建
      （stage='active' / owner_scope='private' / team_id=owner 团队）；
    - 询盘：channel='email'、status='unquoted'、notes 记录来源 lead#id；
    - 线索：inquiry_status → 'new'。
    返回 ``{"scanned", "created", "already_linked"}``（orchestrator 同键）。
    """
    leads = await conn.fetch(
        """SELECT id, company_name, country, address, owner_id
           FROM lead_candidates
           WHERE tenant_id=$1 AND outreach_status='replied' AND inquiry_status='none'
           ORDER BY id LIMIT 100""",
        tenant_id,
    )

    created, existing = 0, 0
    for lead in leads:
        # 幂等：一个线索一条询盘；已转化过就只同步状态
        inq = await conn.fetchrow(
            "SELECT status FROM cust_inquiries WHERE tenant_id=$1 AND lead_id=$2 LIMIT 1",
            tenant_id, lead["id"],
        )
        if inq is not None:
            mapped = INQUIRY_SYNC_MAP.get(inq["status"], "new")
            await conn.execute(
                "UPDATE lead_candidates SET inquiry_status=$1, updated_at=now()"
                " WHERE tenant_id=$2 AND id=$3 AND inquiry_status IS DISTINCT FROM $1",
                mapped, tenant_id, lead["id"],
            )
            existing += 1
            continue

        # 团队隔离：客户/询盘归线索 owner 所在团队；owner 没团队 → team_id 留空 + private
        owner_team = await _owner_team(conn, lead["owner_id"])
        customer = await conn.fetchrow(
            "SELECT id, name, country, abbr FROM customers"
            " WHERE tenant_id=$1 AND name=$2 AND team_id IS NOT DISTINCT FROM $3",
            tenant_id, lead["company_name"], owner_team,
        )
        if customer is None:
            customer = await conn.fetchrow(
                """INSERT INTO customers
                   (tenant_id, name, country, address, stage, owner_id, owner_scope, team_id)
                   VALUES ($1,$2,$3,$4,'active',$5,'private',$6)
                   RETURNING id, name, country, abbr""",
                tenant_id, lead["company_name"], lead["country"],
                lead["address"], lead["owner_id"], owner_team,
            )

        inquiry_no = await _next_inquiry_no(conn, dict(customer))
        await conn.execute(
            """INSERT INTO cust_inquiries
               (tenant_id, customer_id, inquiry_no, lead_id, channel, notes, status,
                owner_id, owner_scope, team_id)
               VALUES ($1,$2,$3,$4,'email',$5,'unquoted',$6,'private',$7)""",
            tenant_id, customer["id"], inquiry_no, lead["id"],
            f"来自线索池触达回复（lead#{lead['id']}）",
            lead["owner_id"], owner_team,
        )
        await conn.execute(
            "UPDATE lead_candidates SET inquiry_status='new', updated_at=now()"
            " WHERE tenant_id=$1 AND id=$2",
            tenant_id, lead["id"],
        )
        created += 1

    return {"scanned": len(leads), "created": created, "already_linked": existing}


async def run_lead_scan(env, tenant_id: str = DEFAULT_TENANT) -> dict:
    """Cron 入口：扫描 → 建询盘。异常**不抛穿**（失败如实进 error 字段）。"""
    try:
        async with _acquire(env) as conn:
            async with conn.transaction():
                result = await scan_replied_leads(conn, tenant_id)
    except Exception as exc:  # noqa: BLE001 - Cron 失败不能让调度器变错误态
        print(f"[cron] scan_replied_leads failed: {type(exc).__name__}: {exc}")
        return {"scanned": 0, "created": 0, "already_linked": 0,
                "error": f"{type(exc).__name__}: {exc}"}
    print(f"[cron] scan_replied_leads ok: {result}")
    return result


# ── 任务 2：events 每日归档（每日 00:30 Asia/Shanghai = 16:30 UTC）──────────────


def archive_target_date(now: Optional[datetime] = None) -> str:
    """要归档的 UTC 自然日 = 「昨日」（与 orchestrator 的 ``now(utc) - 1 day`` 同口径）。"""
    ref = now or datetime.now(timezone.utc)
    return (ref - timedelta(days=1)).strftime("%Y-%m-%d")


def archive_window(target_date: str) -> tuple[datetime, datetime]:
    """``target_date``（YYYY-MM-DD，UTC）→ 半开时间窗 ``[当天 00:00Z, 次日 00:00Z)``。

    见模块头「有意偏差 2」：orchestrator 写 ``< 23:59:59`` 会漏掉当天最后 1 秒的行。
    """
    day = datetime.strptime(target_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return day, day + timedelta(days=1)


def _event_payload(value: Any) -> Any:
    """jsonb 列归一化。

    Workers 环境的 asyncpg 会把 jsonb 返回成 **str**（main.py 里 product_profiles /
    dbjson.py 是同一类问题的记录）；orchestrator 侧是 dict。归档 JSONL 的契约是
    「payload 是对象」，故把可解析的 JSON 字符串还原成对象；解析不了就原样保留
    （宁可留一个字符串，也不让归档整个失败）。
    """
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return value
    return value


def _event_record(row: Any) -> dict:
    """events 行 → 归档 JSONL 的一行（字段与 orchestrator archive.py 逐项一致）。"""
    data = dict(row)
    created_at = data.get("created_at")
    if isinstance(created_at, datetime):
        created_at = created_at.isoformat()
    return {
        "id": data.get("id"),
        "schema_version": data.get("schema_version"),
        "tenant_id": data.get("tenant_id"),
        "event_type": data.get("event_type"),
        "event_source": data.get("event_source"),
        "actor_id": data.get("actor_id"),
        "session_id": data.get("session_id"),
        "payload": _event_payload(data.get("payload")),
        "trace_id": data.get("trace_id"),
        "sampled": data.get("sampled"),
        "created_at": created_at,
    }


def _encode_jsonl(events: list[dict]) -> tuple[bytes, str, str]:
    """事件列表 → ``(bytes, 键后缀, content-type)``。

    正常路径 = JSONL + GZIP（与 orchestrator 一致）。若运行时没有 gzip（理论上不该
    发生：Pyodide 带 zlib），降级为纯 JSONL —— 宁可少一层压缩，也不能让归档任务 import
    阶段就把 Worker 弄挂。降级时键后缀为 ``.jsonl``，如实反映字节内容。
    """
    raw = "\n".join(
        json.dumps(event, ensure_ascii=False, default=str) for event in events
    ).encode("utf-8")
    if gzip is not None:
        return gzip.compress(raw), ".jsonl.gz", "application/gzip"
    return raw, ".jsonl", "application/x-ndjson"


def _r2_body(data: bytes, content_type: str) -> tuple[Any, Any]:
    """bytes → R2 ``put`` 能吃的 body/opts。

    Pyodide（真实 Workers）要 Uint8Array；本地 CPython（单测）没有 ``js`` 模块，
    原样返回 bytes —— 桩 bucket 只关心「调用约定」，不关心 JS 包装。
    与 ws_files.py 的 ``_store_bytes`` 是同一套字节包装约定。
    """
    opts: dict = {"httpMetadata": {"contentType": content_type}}
    try:
        if sys.platform == "emscripten":
            from pyodide.ffi import to_js  # type: ignore

            return to_js(data), to_js(opts)
        from js import Uint8Array  # type: ignore

        return Uint8Array.new(data), opts
    except Exception:  # noqa: BLE001 - 本地 CPython / 极老 runtime
        return data, opts


def r2_bucket(env):
    """取 R2 binding（``FILES``）：先 env（Python Workers 的实际位置），再旧 js 全局。"""
    bucket = getattr(env, "FILES", None)
    if bucket is not None:
        return bucket
    try:
        from js import FILES  # type: ignore  (旧 runtime 的全局绑定)

        return FILES
    except Exception:  # noqa: BLE001
        return None


async def archive_events_for_day(
    conn,
    bucket,
    target_date: str,
    bucket_name: str = DEFAULT_BUCKET_NAME,
) -> dict:
    """把 ``target_date``（UTC 自然日）的 events 按 schema_version 分桶归档到 R2。

    与 orchestrator ``_do_archive_events`` 的语义/返回键一致：
    - 有数据 → ``{"archived": N, "date": "YYYY-MM-DD", "version_count": N}``
    - 无数据 → ``{"archived": 0, "message": "No events on YYYY-MM-DD"}``
      （无数据时**不需要** bucket 可用，与 orchestrator 先查后建 Minio client 同序）

    对象键与 orchestrator OSS 布局一致：
    ``events-archive/{YYYY}/{MM}/{DD}/v{schema_version}.jsonl.gz``；
    ``events_archive_log`` 每桶一行（tenant_id='*'，month='YYYY-MM'，status='archived'）。
    """
    start, end = archive_window(target_date)
    rows = await conn.fetch(
        """SELECT id, schema_version, tenant_id, event_type, event_source,
                  actor_id, session_id, payload, trace_id, sampled, created_at
           FROM events
           WHERE created_at >= $1 AND created_at < $2
           ORDER BY created_at ASC""",
        start, end,
    )
    if not rows:
        return {"archived": 0, "message": f"No events on {target_date}"}

    if bucket is None:
        raise RuntimeError(
            "R2 binding 'FILES' is not configured; cannot archive events "
            "(check wrangler.jsonc r2_buckets)"
        )

    # 按 schema_version 分桶（dict 插入序 = 首次出现顺序，与 orchestrator 相同）
    buckets: dict[Any, list[dict]] = {}
    for row in rows:
        event = _event_record(row)
        buckets.setdefault(event["schema_version"], []).append(event)

    year, month, day = target_date.split("-")
    archived = 0
    for schema_version, events in buckets.items():
        blob, suffix, content_type = _encode_jsonl(events)
        key = f"{ARCHIVE_KEY_PREFIX}/{year}/{month}/{day}/v{schema_version}{suffix}"
        body, opts = _r2_body(blob, content_type)
        await bucket.put(key, body, opts)
        await conn.execute(
            """INSERT INTO events_archive_log
               (tenant_id, month, minio_path, status)
               VALUES ($1,$2,$3,$4)""",
            "*", f"{year}-{month}", f"{bucket_name}/{key}", "archived",
        )
        archived += len(events)

    return {"archived": archived, "date": target_date, "version_count": len(buckets)}


async def run_archive_events(env, now: Optional[datetime] = None) -> dict:
    """Cron 入口：归档「昨日」事件。最多重试 3 次，异常**不抛穿**。"""
    target_date = archive_target_date(now)
    bucket = r2_bucket(env)
    bucket_name = getattr(env, "S3_BUCKET", "") or DEFAULT_BUCKET_NAME

    last_error: Optional[Exception] = None
    for attempt in range(1, MAX_ARCHIVE_RETRIES + 1):
        try:
            async with _acquire(env) as conn:
                async with conn.transaction():
                    result = await archive_events_for_day(
                        conn, bucket, target_date, bucket_name=bucket_name,
                    )
            print(f"[cron] archive_events ok: {result}")
            return result
        except Exception as exc:  # noqa: BLE001 - Cron 失败不能让调度器变错误态
            last_error = exc
            print(
                f"[cron] archive_events attempt {attempt}/{MAX_ARCHIVE_RETRIES} "
                f"failed: {type(exc).__name__}: {exc}"
            )

    return {
        "archived": 0,
        "date": target_date,
        "error": f"{type(last_error).__name__}: {last_error}",
    }


# ── scheduled 事件入口 ──────────────────────────────────────────────────────


async def run_scheduled(env, controller) -> dict:
    """``main.Default.scheduled`` 调它：按 ``controller.cron`` 分派到对应任务。

    返回结构化结果（本地 ``/cdn-cgi/local/scheduled?format=json`` 与日志都能看到），
    未登记的 cron 只打印并跳过 —— **不猜**该跑哪个任务（猜错会重复归档/重复扫描）。
    """
    cron = getattr(controller, "cron", None) or ""
    job = JOBS_BY_CRON.get(cron)
    if job is None:
        print(f"[cron] unknown cron expression, skipped: {cron!r}")
        return {"cron": cron, "job": None, "skipped": True}

    if job == "archive_events":
        result = await run_archive_events(env)
    else:
        result = await run_lead_scan(env)
    print(f"[cron] {job} done: {result}")
    return {"cron": cron, "job": job, "result": result}
