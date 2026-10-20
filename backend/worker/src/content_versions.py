"""单证内容级版本（TODO A1）—— 每次 `raw_payload` 落库前留一版快照。

为什么需要独立表（而不是复用 `raw_payload._audit`）
----------------------------------------------------
`_audit` 只记"谁在什么时候改了哪些 custom 键"：**可读、不可回滚**，而且不存
sources 快照 —— 草稿期反复调整后，想回到两版之前的内容只能靠记忆。本模块把
每次写入的整份 payload（sources + custom）按**单据内递增版本号**落
`trade_doc_content_versions`，支持回看与恢复（issued 后内容锁死，不再产生新版本）。

版本号怎么来
------------
单条 `INSERT ... SELECT COALESCE(MAX(version_no), 0) + 1`：读最大值与写入是同一条
语句，避免"先查后写"的竞态窗口；聚合无 GROUP BY 时恒返回一行，空表也成立。
写入用 `db.execute`（不需要 RETURNING），测试的假 db 无需多吐一行结果。

调用点（全部在 worker 侧，与运行时一致）
----------------------------------------
- `main.update_trade_doc`：PATCH 改 `raw_payload`（草稿保存 / PATCH 直接签发；
  源 = `custom_update` / `issue`）
- `ws_docs_ext.refresh_trade_doc_sources`：重新带入上游快照（源 = `refresh_sources`）
- `ws_docs_ext.confirm_trade_doc`：确认冻结（源 = `issue`，含 `_render` 指纹终版）
- `ws_docs_ext.restore_trade_doc_content_version`：恢复历史版本（源 = `restore`）
"""
from __future__ import annotations

import json

SOURCE_CUSTOM_UPDATE = "custom_update"
SOURCE_REFRESH_SOURCES = "refresh_sources"
SOURCE_ISSUE = "issue"
SOURCE_RESTORE = "restore"
SOURCE_TRANSLATE = "translate"

CHANGE_SOURCES = (
    SOURCE_CUSTOM_UPDATE, SOURCE_REFRESH_SOURCES, SOURCE_ISSUE, SOURCE_RESTORE, SOURCE_TRANSLATE,
)


async def record_content_version(
    db,
    request,
    *,
    tenant_id: str,
    doc_id: int,
    payload: dict,
    source: str,
    actor_id: str | None = None,
    note: str | None = None,
) -> None:
    """把**本次要写入的** payload 记录为一个新版本（失败不阻断主流程）。"""
    if source not in CHANGE_SOURCES:
        # 编程错误就早点炸，别把脏数据写进版本表
        raise ValueError(f"unknown content version source: {source}")
    await db.execute(
        request,
        "INSERT INTO trade_doc_content_versions"
        " (tenant_id, trade_doc_id, version_no, raw_payload, change_source, actor_id, note)"
        " SELECT $1, $2, COALESCE(MAX(version_no), 0) + 1, $3::jsonb, $4, $5, $6"
        " FROM trade_doc_content_versions WHERE tenant_id=$1 AND trade_doc_id=$2",
        tenant_id,
        doc_id,
        json.dumps(payload, ensure_ascii=False, default=str),
        source,
        actor_id,
        note,
    )
