"""外贸单证工位 · 缺失端点补齐（Worker 镜像 · 生产对齐）。

为什么需要这个文件
------------------
生产 API 就是本 Worker（`backend/worker/wrangler.jsonc` 把 `kaas.powervoy.com` 与
`api.kaas.powervoy.com` 都指向它，`deploy.yml` 的冒烟测试也打线上域名），
而开发在 orchestrator 里做 —— 两边是**两套代码**。`scripts/sync-shared.ps1 -Check`
只保证 `kaas_common` 共享内核一致，**管不到路由面**，于是「本地新加接口、线上忘了补」
没有任何自动防线（见 `docs/ROUTE_PARITY_2026-10-10.md`）。

单证工位缺的正是这三条，前端页面能开、数据请求却 404：

    POST /api/v1/trade-docs/{doc_id}/refresh-sources   （重新带入上游快照）
    POST /api/v1/trade-docs/{doc_id}/confirm            （确认 → issued 锁死）
    POST /api/v1/trade-docs/{doc_id}/translate          （字段中译英）

对齐口径（真源：`backend/orchestrator/app/api/trade_docs.py`）
--------------------------------------------------------------
- **业务判定一律调用共享内核** `kaas_common.trade_doc.rules`
  （`assert_draft` / `assert_transition` / `validate_confirm`），
  本文件不另写状态机、不另写确认必填 —— 内核的意义就是
  「本地能流转、线上也必须能，反之亦然」，另写一份必然漂移（G1）。
- **金额勾稽分两层**：内核 `validate_confirm` 只覆盖**行级**
  （行金额 = 数量 × 单价）；**合计层**（单证合计 = 行项目合计）此前只有 dev
  在创建时校验，线上完全没有 —— 于是生产能确认一张「合计与明细对不上」的单据，
  而信用证下这是致命不符点。本文件在**确认**环节补上合计层，
  判定仍调共享内核 `kaas_common.workstation.amount_rules`，不另写一份算法。
- 错误体与 orchestrator **逐字同构**（404 `DOC_NOT_FOUND` / 409 `NOT_DRAFT` /
  422 `CONFIRM_INVALID` …），前端同一套错误处理两端通用。
- 快照字段清单与 orchestrator 的 `_order_snapshot` / `_quote_snapshot` /
  `_inquiry_snapshot` 逐条一致：这些字段会被冻进 `raw_payload` 并被
  `build_render_data` 消费，**字段名就是已落库数据的契约**，不能"顺手改好一点"。
- 数据访问走 `platform/db.py`（返回 dict；jsonb 列靠 `table=` 解码：
  `trade_docs.raw_payload`、`order_items` / `quote_order_items` 的 `spec_snapshot`）；
  需要多语句共用一条连接（AI 绑定 / Provider / usage 记账）时用
  `main._acquire`，与 `ws_extras.py` 同风格。
- 租户恒为 `DEFAULT_TENANT`（Worker 是单租户生产部署）。
- 所有 UPDATE 都显式补 `updated_at=now()`：orchestrator 的 ORM 列带
  `onupdate=func.now()`，不补就会「线上更新了、时间戳没动」。

与 orchestrator 的差异（仅以下三处，均属适配层不得不改的部分）
--------------------------------------------------------------
1. AI 出站：orchestrator 走 `app.services.ai_tasks.run_ai_task`；
   worker 的 `chain.py` 任务表（`TASKS`）里**没有** `trade_doc_translate` 这一项
   （本文件不得修改 chain.py），故此处用 chain 现成的
   `_openai_chat` / `_task_chain` / `_log_usage` / `PROVIDER_DEFAULTS`
   复刻同一条语义：绑定未启用 → 原样回传（`path="template"`）；
   启用 → Provider fallback 链；**每次调用必落 `ai_usage`**（铁律，失败可对账）。
2. prompt 与响应解析复用共享内核 `kaas_common.trade_doc.translate`
   （system + user 两条消息、容错解析），orchestrator 是把该 system prompt
   字符串拼进单条 user 消息里；LLM 输出等价，但消息结构不是逐字节相同。
3. 本文件不写 `business_events`：orchestrator 的这三条端点也不写
   （只有 create 写 `shipment.documented`），保持一致以免线上事件流多出本地没有的行。
"""
from __future__ import annotations

import json as _json
import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel

from kaas_common.trade_doc import (
    RuleError, assert_draft, assert_transition, validate_confirm,
)
from kaas_common.trade_doc.translate import build_messages, parse_translation
from kaas_common.workstation.amount_rules import (
    AmountMismatchError, calc_line_amount, check_amount_reconciliation,
)

import chain as _chain
import doc_payload as _doc_payload
import main as _main

app = _main.app
_get_current_user = _main._get_current_user
DEFAULT_TENANT = _main.DEFAULT_TENANT
db = _main.db


# ── Schemas（与 orchestrator 同名模型字段一致）──────────────────────────────

class TradeDocConfirmIn(BaseModel):
    """确认（issued）：校验必填 → 冻结；确认后不可修改（无入参，仅为对齐请求体）。"""
    pass


class TradeDocTranslateIn(BaseModel):
    fields: dict[str, str] = {}      # {字段名: 中文/中英混输}
    target: str = "en"               # 目标语言：当前固定 en（保留列以便前端传值）


# ── Helpers：全部委托给 doc_payload（main 与 ws_docs_ext 的**唯一实现**）──────
# 保留同名薄封装，只为让下面端点代码与 orchestrator 逐行对照时更好读。
# 为什么必须共用：这些装配函数原先在 main.py 里也有一份，e5ab56e 删掉镜像后
# 调用点没跟着改，线上单证端点就 NameError 500 了 —— 两份实现是根因。

async def _get_doc_or_404(request, doc_id: int) -> dict:
    return await _doc_payload.get_doc_or_404(db, request, doc_id)


async def _order_snapshot(request, order_id: int) -> dict:
    return await _doc_payload.order_snapshot(db, request, order_id)


async def _quote_snapshot(request, quote_id: int) -> dict:
    return await _doc_payload.quote_snapshot(db, request, quote_id)


async def _inquiry_snapshot(request, inquiry_id: int) -> dict:
    return await _doc_payload.inquiry_snapshot(db, request, inquiry_id)


_payload_of = _doc_payload.payload_of
_payload_parts = _doc_payload.payload_parts
_row_to_doc = _doc_payload.doc_dict


# ── 端点 ─────────────────────────────────────────────────────────────────────

@app.post("/api/v1/trade-docs/{doc_id}/refresh-sources")
async def refresh_trade_doc_sources(
    doc_id: int,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """从上游重新带入快照（仅 draft 可调用）。

    场景：报价改了但单据还没签发，允许一键同步；手工在 custom 里改过的字段保留
    （因为 custom 优先级最高）。已签发（issued）单据是法律凭证，彻底冻结。

    注意 sources 是**整体替换**（只保留 custom），与 orchestrator 一致：
    旧快照不留残键，避免"上一版上游字段"继续参与渲染。
    """
    d = await _get_doc_or_404(request, doc_id)
    if d["status"] != "draft":
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": "NOT_DRAFT",
            "detail": "仅 draft 状态可重新带入上游数据（已签发单据已冻结）",
        })

    sources, custom = _payload_parts(d)
    new_sources: dict = {}
    if d["order_id"]:
        new_sources["order"] = await _order_snapshot(request, d["order_id"])
    if "quote" in sources:
        # 报价来源：**列优先、边表兜底**（旧实现读 `trade_doc_quote_refs` LIMIT 1）。
        # `customer_id IS NULL` 的历史行当年没被回填 `trade_docs.quote_id`，
        # 它们的报价只在边表里 —— 只读列会让这些单证刷新时报 422 NO_UPSTREAM。
        quote_id = d.get("quote_id")
        if quote_id is None:
            quote_link = await db.fetchrow(
                request,
                "SELECT dst_id FROM entity_links"
                " WHERE tenant_id=$1 AND src_type='trade_doc' AND src_id=$2"
                "   AND dst_type='quote' AND deleted_at IS NULL ORDER BY id LIMIT 1",
                DEFAULT_TENANT, d["id"],
            )
            quote_id = quote_link["dst_id"] if quote_link is not None else None
        if quote_id is not None:
            new_sources["quote"] = await _quote_snapshot(request, quote_id)
    if "inquiry" in sources:
        inquiry = await db.fetchrow(
            request,
            "SELECT dst_id FROM entity_links"
            " WHERE tenant_id=$1 AND src_type='trade_doc' AND src_id=$2"
            "   AND dst_type='inquiry' AND deleted_at IS NULL ORDER BY id LIMIT 1",
            DEFAULT_TENANT, d["id"],
        )
        if inquiry is not None:
            new_sources["inquiry"] = await _inquiry_snapshot(
                request, inquiry["dst_id"])

    if not new_sources:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "NO_UPSTREAM",
            "detail": "该单据没有可重新带入的上游来源",
        })

    upstream = new_sources.get("order") or new_sources.get("quote") or {}
    payload = {"sources": new_sources, "custom": custom}
    if d["total_amount"] is None and upstream.get("total_amount") is not None:
        # 原先没有合计（手动开单 / 上游缺金额）时，用新带入的上游合计补上；
        # 已有合计则不覆盖 —— 合计一旦落定就不该被"顺手刷新"改掉
        row = await db.fetchrow(
            request,
            "UPDATE trade_docs SET raw_payload=$3, total_amount=$4, updated_at=now()"
            " WHERE tenant_id=$1 AND id=$2 RETURNING *",
            DEFAULT_TENANT, doc_id, _json.dumps(payload), upstream["total_amount"],
            table="trade_docs",
        )
    else:
        row = await db.fetchrow(
            request,
            "UPDATE trade_docs SET raw_payload=$3, updated_at=now()"
            " WHERE tenant_id=$1 AND id=$2 RETURNING *",
            DEFAULT_TENANT, doc_id, _json.dumps(payload), table="trade_docs",
        )
    return {"doc": _row_to_doc(row), "sources": list(new_sources.keys())}


@app.post("/api/v1/trade-docs/{doc_id}/confirm")
async def confirm_trade_doc(
    doc_id: int,
    request: Request,
    body: TradeDocConfirmIn,
    user: dict = Depends(_get_current_user),
):
    """明确确认环节：校验必填 → issued → 锁死（确认后 PATCH 拒绝）。

    判定全部来自共享内核：
    - `assert_draft` 仅 draft 可确认；重复确认/已锁 → 409；
    - `assert_transition` 状态机同态校验（draft→issued 合法）；
    - `validate_confirm` 行项目（品名/数量/金额勾稽）+ 买方识别 + 各类型必填。
    """
    d = await _get_doc_or_404(request, doc_id)

    rows = await db.fetch(
        request,
        "SELECT product_name, qty, unit_price, line_amount FROM trade_doc_items"
        " WHERE tenant_id=$1 AND trade_doc_id=$2 ORDER BY sort_order, id",
        DEFAULT_TENANT, d["id"], table="trade_doc_items",
    )
    items = [{
        "product_name": r["product_name"], "qty": r["qty"],
        "unit_price": r["unit_price"], "line_amount": r["line_amount"],
    } for r in rows]

    try:
        assert_draft(d["status"])          # 仅 draft 可确认；重复确认/已锁 → 409
        assert_transition(d["status"], "issued")
        # customer_id 在 trade_docs 列上，校验时并入 payload（买方识别）
        check_payload = {**_payload_of(d), "customer_id": d["customer_id"]}
        result = validate_confirm(d["doc_type"], check_payload, items)
    except RuleError as exc:
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": exc.code, "detail": exc.detail})
    if not result.ok:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "CONFIRM_INVALID",
            "detail": "；".join(result.issues), "issues": result.issues,
        })

    # 金额勾稽（信用证不符点防线）：单证合计 = 行项目合计。
    # 只在**确认**时拦，草稿态放行 —— 避免影响在编/在途单据。
    try:
        items_total = sum(
            (calc_line_amount(i["qty"], i["unit_price"]) for i in items), 0)
    except (ValueError, ArithmeticError):
        # 数量/单价缺失或不可解析：已由 validate_confirm 的行级校验报出，不在此重复
        items_total = None
    if items_total is not None:
        try:
            check_amount_reconciliation(d["total_amount"], items_total)
        except AmountMismatchError as exc:
            raise HTTPException(status_code=422, detail={
                "error": "validation", "code": "AMOUNT_MISMATCH",
                "detail": str(exc),
            })

    row = await db.fetchrow(
        request,
        "UPDATE trade_docs SET status='issued', issued_at=$3, issued_by=$4,"
        " updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
        DEFAULT_TENANT, doc_id, datetime.now(timezone.utc), str(user["id"]),
        table="trade_docs",
    )
    return _row_to_doc(row)


# ── 中译英（AI 翻译，draft-only）────────────────────────────────────────────

# 任务键与推荐 Provider 与 orchestrator `ai_tasks.TASKS["trade_doc_translate"]` 一致
TRANSLATE_TASK_KEY = "trade_doc_translate"
TRANSLATE_RECOMMENDED_PROVIDER = "kimi"


async def _translate_fields(request, fields: dict) -> tuple[dict, str]:
    """执行一次「单证中译英」任务，返回 (merged_fields, path)。

    path ∈ {"template", "ai:<provider>"}，与 orchestrator `run_ai_task` 的 path 同形。
    语义与 `app/services/ai_tasks.py` 的 fallback 链一致：
    绑定未启用 → 原样回传（提示人工翻译）；启用 → Primary → DS↔Kimi 互备 → Zhipu；
    链全挂 → 原样回传并标注 `all_providers_failed`。每次调用都落 `ai_usage`。
    """
    async with _main._acquire(request) as conn:
        binding = await conn.fetchrow(
            "SELECT * FROM ai_task_bindings WHERE tenant_id=$1 AND task_key=$2",
            DEFAULT_TENANT, TRANSLATE_TASK_KEY,
        )

        # "不用 AI" 是合法选项：直接原样回传，不丢数据（模板路径零外部调用）
        if binding is None or not binding["enabled"]:
            started = time.perf_counter()
            merged = {k: str(v) for k, v in fields.items()}
            await _chain._log_usage(
                conn, TRANSLATE_TASK_KEY, None, None, {}, "template_only", None,
                int((time.perf_counter() - started) * 1000),
            )
            return merged, "template"

        primary = binding["provider"] or TRANSLATE_RECOMMENDED_PROVIDER
        prov_rows = await conn.fetch(
            "SELECT * FROM ai_providers WHERE tenant_id=$1", DEFAULT_TENANT)
        providers = {r["provider"]: r for r in prov_rows}
        messages = build_messages(fields)

        for provider_name in _chain._task_chain(primary):
            prov = providers.get(provider_name)
            if prov is None or not prov["enabled"] or not prov["api_key"]:
                continue
            defaults = _chain.PROVIDER_DEFAULTS.get(provider_name, {})
            base_url = prov["base_url"] or defaults.get("base_url", "")
            model = binding["model"] or prov["model"] or defaults.get("model", "")
            started = time.perf_counter()
            try:
                content, usage = await _chain._openai_chat(
                    base_url, prov["api_key"], model, messages, json_mode=True)
                latency = int((time.perf_counter() - started) * 1000)
                await _chain._log_usage(conn, TRANSLATE_TASK_KEY, provider_name, model,
                                        usage, "success", None, latency)
                # 解析层兜底：未翻译到的键回退原文（不丢数据）
                return parse_translation(content, fields), f"ai:{provider_name}"
            except Exception as exc:      # 单 Provider 失败不致命：继续 fallback 链
                latency = int((time.perf_counter() - started) * 1000)
                await _chain._log_usage(conn, TRANSLATE_TASK_KEY, provider_name, model,
                                        {}, "failed", str(exc)[:500], latency)

        # 链全挂 → TemplateOnly（零外部调用）
        started = time.perf_counter()
        merged = {k: str(v) for k, v in fields.items()}
        await _chain._log_usage(
            conn, TRANSLATE_TASK_KEY, None, None, {}, "template_only",
            "all_providers_failed", int((time.perf_counter() - started) * 1000),
        )
        return merged, "template"


@app.post("/api/v1/trade-docs/{doc_id}/translate")
async def translate_trade_doc(
    doc_id: int,
    request: Request,
    body: TradeDocTranslateIn,
    user: dict = Depends(_get_current_user),
):
    """单证字段中译英：中文/中英混输 → 外贸正式英文（draft 态才可写回）。

    走 ai_task 语义（可绑 Provider / 可降级 / 记 ai_usage）；无 AI 时降级为
    原样回传并标注 path=template，前端据此提示人工翻译。
    """
    d = await _get_doc_or_404(request, doc_id)

    fields = {k: str(v) for k, v in (body.fields or {}).items() if str(v or "").strip()}
    if not fields:
        return {"fields": {}, "path": "none", "detail": "没有可翻译的字段"}

    merged, path = await _translate_fields(request, fields)

    # draft 态自动写回 raw_payload.custom（与就地编辑同通道；确认后锁死不写）
    if d["status"] == "draft":
        try:
            assert_draft(d["status"])      # 内核状态机：非 draft 一律不写回
            _, custom = _payload_parts(d)
            custom = dict(custom)
            custom.update(merged)
            payload = dict(_payload_of(d))
            payload["custom"] = custom
            await db.execute(
                request,
                "UPDATE trade_docs SET raw_payload=$3, updated_at=now()"
                " WHERE tenant_id=$1 AND id=$2",
                DEFAULT_TENANT, doc_id, _json.dumps(payload),
            )
        except RuleError:
            pass   # 翻译结果仍返回，仅不写回

    return {"fields": merged, "path": path, "task": TRANSLATE_TASK_KEY}
