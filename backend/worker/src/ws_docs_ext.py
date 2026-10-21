"""外贸单证工位 · 缺失端点补齐（Worker 镜像 · 生产对齐）。

为什么需要这个文件
------------------
生产 API 就是本 Worker（`backend/worker/wrangler.jsonc` 把 `kaas.powervoy.com` 与
`api.kaas.powervoy.com` 都指向它，`deploy.yml` 的冒烟测试也打线上域名）。
方案 B 收敛后 orchestrator 业务壳已删，但「本地新加接口、线上忘了补」仍需靠
`scripts/sync-shared.ps1 -Check` 保共享内核一致 + 前端契约/测试兜底（历史
route-parity 门禁已退役，见 `scripts/archive/`）。

单证工位缺的正是这三条，前端页面能开、数据请求却 404：

    POST /api/v1/trade-docs/{doc_id}/refresh-sources   （重新带入上游快照）
    POST /api/v1/trade-docs/{doc_id}/confirm            （确认 → issued 锁死）
    POST /api/v1/trade-docs/{doc_id}/translate          （字段中译英）

对齐口径（业务壳删除前对齐了 orchestrator 历史语义；当前真源 = 共享内核 `kaas_common/trade_doc/` + 本 Worker 路由）
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

from fastapi import Depends, HTTPException, Query, Request
from pydantic import BaseModel

from kaas_common.trade_doc import (
    RENDER_KEY, RenderCheckBatchError, RuleError, assert_draft, assert_transition,
    parse_render_check_doc_ids, read_render_fingerprint, render_check_card,
    render_fingerprint, render_fingerprint_check, summarize_render_checks,
    validate_confirm,
)
from kaas_common.trade_doc.translate import build_messages, parse_translation
from kaas_common.workstation.amount_rules import (
    AmountMismatchError, calc_line_amount, check_amount_reconciliation,
)

import chain as _chain
import content_versions as _cv
import doc_payload as _doc_payload
import main as _main
# A7 单证加固（事实/一致性/lint/...）：**模块级** import（不是函数内惰性 import）。
# 为什么：测试里每次 `load_main()` 都会重载 main 与全部同级路由模块（_bootstrap.py），
# 若在函数体内才 `import ws_docs_hardening`，运行期拿到的是 sys.modules 里**后一次**
# 重载的模块 → 它绑定的 main 不是当前 app 的 main → 它的 db 是真实连接（KeyError 'env' 500）。
# 模块级 import 让「同一个 app 的 ws_docs_ext 一定用同一个 hardening 模块」。
import ws_docs_hardening as _ws_hardening

app = _main.app
_get_current_user = _main._get_current_user
DEFAULT_TENANT = _main.DEFAULT_TENANT
db = _main.db


# ── Schemas（与 orchestrator 同名模型字段一致）──────────────────────────────

class TradeDocConfirmIn(BaseModel):
    """确认（issued）：校验必填 → 冻结；确认后不可修改。

    可选 `html` / `pdf_name`（TODO F1 方案 A）：前端随签发提交**预览用的同一份 HTML**，
    服务端出 PDF 并归档到本单证（`render_pdf` 新版本上位）。不传 html = 旧行为（不产 PDF）。

    失败策略（用户 2026-10-20 口径）：**PDF 失败不回滚签发** —— 签发是法律动作，
    归档是后续动作；响应里带 `pdf_archive: {ok:false, ...}`，界面提示手动上传兜底，
    绝不能因为渲染器没配就把"已签发"静默吞掉。

    `allow_lint_override`（A7 加固，2026-10-20 新增）：越过签发前的事实层闸门
    （`FACT_UNVERIFIED` / `FACT_IMMUTABLE` / `DOC_REF_BROKEN` / `DOC_SET_NOT_ALLOWED`）。
    **默认不开放给前端**：只给明确的运维/紧急场景用，且越过必落审计事件。
    """
    html: Optional[str] = None
    pdf_name: Optional[str] = None
    allow_lint_override: bool = False


class TradeDocTranslateIn(BaseModel):
    fields: dict[str, str] = {}      # {字段名: 中文/中英混输}
    target: str = "en"               # 目标语言：当前固定 en（保留列以便前端传值）


# ── Helpers：全部委托给 doc_payload（main 与 ws_docs_ext 的**唯一实现**）──────
# 保留同名薄封装，只为让下面端点代码与 orchestrator 逐行对照时更好读。
# 为什么必须共用：这些装配函数原先在 main.py 里也有一份，e5ab56e 删掉镜像后
# 调用点没跟着改，线上单证端点就 NameError 500 了 —— 两份实现是根因。

async def _get_doc_or_404(request, doc_id: int, user: Optional[dict] = None) -> dict:
    return await _doc_payload.get_doc_or_404(db, request, doc_id, user)


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
    d = await _get_doc_or_404(request, doc_id, user)
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
    # 内容级版本（TODO A1）：重新带入上游快照也是一次内容变更，留版
    await _cv.record_content_version(
        db, request,
        tenant_id=DEFAULT_TENANT, doc_id=doc_id, payload=payload,
        source=_cv.SOURCE_REFRESH_SOURCES, actor_id=str(user["id"]),
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
    d = await _get_doc_or_404(request, doc_id, user)
    # C27（F3）：签发是团队管理员/internal 的动作；customer 普通成员 403。
    # 顺序：上一行已先做可见性 404，所以跨团队/无团队看到 404 而不是 403。
    await _main._require_doc_issuer(request, user, d)

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

    # ── A7 单证加固：签发前的事实层闸门（HARDENING_PLAN §4-A / §4-B / §4-D）──
    # 四项 blocking：未确认事实（FACT_UNVERIFIED）/ 基线条款被改（FACT_IMMUTABLE）/
    # 引用悬空（DOC_REF_BROKEN）/ 越权出单（DOC_SET_NOT_ALLOWED）。
    # 判定全在共享内核与 ws_docs_hardening（G1：不在这里另写一遍）。
    # 只读 payload + 事实表（**只用 db.fetch**），不改动上面任何既有校验链；
    # 没有事实/清单/引用数据的单证 ⇒ blocking 为空 ⇒ 行为与改造前完全一致。
    # 越过（allow_lint_override）默认不给前端，且必落审计 —— 见 ws_docs_hardening。
    blocking = await _ws_hardening.confirm_blocking(request, _row_to_doc(d), items)
    if blocking:
        if not body.allow_lint_override:
            first = blocking[0]
            raise HTTPException(status_code=422, detail={
                "error": "validation",
                "code": first.get("code") or "FACT_UNVERIFIED",
                "detail": first.get("detail") or "签发前存在未通过的加固检查",
                "blocking": blocking,
            })
        await _ws_hardening.record_confirm_override(
            request, _row_to_doc(d), user, blocking)

    payload = await _payload_with_render_fingerprint(request, doc_id, d, user)
    row = await db.fetchrow(
        request,
        "UPDATE trade_docs SET status='issued', issued_at=$3, issued_by=$4, raw_payload=$5,"
        " updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
        DEFAULT_TENANT, doc_id, datetime.now(timezone.utc), str(user["id"]),
        _json.dumps(payload),
        table="trade_docs",
    )
    # 内容级版本（TODO A1）：签发终版留一版（含 `_render` 指纹），issued 后不再产生版本
    await _cv.record_content_version(
        db, request,
        tenant_id=DEFAULT_TENANT, doc_id=doc_id, payload=payload,
        source=_cv.SOURCE_ISSUE, actor_id=str(user["id"]),
    )
    out = _row_to_doc(row)
    # 服务端签发自动上传（TODO F1 方案 A）：同请求带 HTML ⇒ 出 PDF 并归档；
    # 失败**不回滚签发**，只把失败写进 pdf_archive 让界面提示手动上传。
    if body.html and body.html.strip():
        try:
            import ws_files as _ws_files  # 惰性 import：避免与文件路由的加载顺序耦合
            archived = await _ws_files.archive_rendered_pdf(
                request, doc_id, body.html, user, body.pdf_name)
            file_row = archived.get("file") or {}
            out["pdf_archive"] = {
                "ok": True,
                "renderer": archived.get("renderer"),
                "bytes": archived.get("bytes"),
                "file_id": file_row.get("id") if hasattr(file_row, "get") else None,
            }
        except HTTPException as exc:
            out["pdf_archive"] = {
                "ok": False, "status_code": exc.status_code, "detail": exc.detail,
            }
    return out


async def _payload_with_render_fingerprint(
    request: Request, doc_id: int, d: dict, user: dict
) -> dict:
    """C 方案：签发时把「渲染输入指纹」写进 `raw_payload["_render"]`（与 orchestrator 同契约）。

    与 orchestrator 逐字同义的装配：直接复用本端 `main.get_trade_doc_render_data`
    —— **不另写一份装配**（G1）。里面已经包含企业主体/买方/上游快照/行项/产品图 data URI/
    默认公章/产品基础信息回落，正是"客户看到的那一版"的全部输入。

    装配失败**不阻断签发**：如实记 `input_sha256: null` + `note: input_unavailable`。
    必须在 UPDATE **之前**装配（装配把单据日期取成 `issued_at or created_at`；该字段已被
    内核排除，见 `kaas_common.trade_doc.render_fingerprint` 的理由）。
    """
    frozen_at = datetime.now(timezone.utc).isoformat()
    try:
        assembled = await _main.get_trade_doc_render_data(doc_id, request, user)
        meta = render_fingerprint(assembled.get("data"), frozen_at=frozen_at)
    except Exception as exc:  # noqa: BLE001
        print(f"[trade-docs] 渲染指纹装配失败（签发继续，指纹标注不可用）："
              f"{type(exc).__name__}: {exc}")
        meta = render_fingerprint(None, frozen_at=frozen_at)

    payload = dict(_payload_of(d) or {})
    # 与 `_audit` 同风格：顶层保留键，客户端自带的 `_render` 一律被这里覆盖
    payload[RENDER_KEY] = meta
    return payload


@app.get("/api/v1/trade-docs/{doc_id}/render-fingerprint-check")
async def check_trade_doc_render_fingerprint(
    doc_id: int,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """**只读**对账：现在数据是否与签发时冻结的渲染指纹一致（与 orchestrator 同契约）。

    判定全在共享内核 `render_fingerprint_check`（两端同一函数对象）⇒ 字段与语义逐字一致：
    `has_fingerprint / frozen / current_sha256 / matches / render_version_frozen /
     render_version_current / render_version_drift / reason / checked_at /
     current_note / frozen_note`。

    保守语义：没有 `_render`（草稿/老单据）⇒ `has_fingerprint=false` 不报错；
    现在装配失败 ⇒ `current_sha256=null` + `current_note`，`matches=false`（不假装匹配）；
    "模板改过"（`render_version_drift`）与"数据被改"（`reason=data_changed`）分开报。
    """
    d = await _get_doc_or_404(request, doc_id, user)
    return await _check_one_doc_render_fingerprint(d, doc_id, request, user)


async def _check_one_doc_render_fingerprint(d: dict, doc_id: int, request: Request,
                                            user: dict) -> dict:
    """**单张**对账的唯一实现（单张端点与批量端点共用；判定全在共享内核）。

    装配失败**不抛**：交给内核标 `current_unavailable` + `current_note`，绝不假报匹配。
    批量端点在外层还有一层 try/except 兜**意外**异常。

    `doc_id` 显式传入（不读 `d["id"]`）：单张端点用路径参数，批量端点传行里的 id；
    两者必须**同源**，装配才取得到同一张单据。
    """
    frozen = read_render_fingerprint(_payload_of(d))
    checked_at = datetime.now(timezone.utc).isoformat()
    try:
        assembled = await _main.get_trade_doc_render_data(doc_id, request, user)
        return render_fingerprint_check(frozen, assembled.get("data"), checked_at=checked_at)
    except Exception as exc:  # noqa: BLE001
        print(f"[trade-docs] 对账时装配失败（如实标出，不假装匹配）："
              f"{type(exc).__name__}: {exc}")
        return render_fingerprint_check(
            frozen, None, checked_at=checked_at, current_error=type(exc).__name__)


# ── 批量对账（一次知道"哪些单据被改了"）──────────────────────────────────────
#
# ⚠️ **这是重操作，不要挂到高频路径**：每张单据都要跑一次完整装配
# （见 `main.get_trade_doc_render_data`）—— 50 张就是最多 50 次装配。
# 只应由**用户显式动作**或低频运维巡检调用；**禁止**接到列表轮询 / 自动刷新上。
#
# 路径为什么是 `…/render-fingerprint-checks/batch`：worker 的路由注册顺序是
# main.py（含 `/api/v1/trade-docs/{doc_id}`）先、本模块（文件末尾 import）后，
# 所以任务备选的 2 段路径 `…/trade-docs/render-fingerprint-checks` 会被
# `/trade-docs/{doc_id}` 吃掉（实测：`app.router` 首个 FULL 匹配就是它，随后 422）。
# 3 段静态路径不与任何动态路由相交，两端同形且与 import 顺序无关。
@app.get("/api/v1/trade-docs/render-fingerprint-checks/batch")
async def batch_check_trade_doc_render_fingerprints(
    request: Request,
    doc_ids: str = Query(None, description="逗号分隔的单据 id，最多 50 个，如 1,2,3"),
    user: dict = Depends(_get_current_user),
):
    """**只读**批量对账（与 orchestrator 同路径、同契约、同判定）。

    返回 `{total, matched, data_changed, version_drift, no_fingerprint, unavailable, items}`；
    每张卡片 `{doc_id, doc_no, reason, matches, render_version_drift, error}`。
    入参校验、卡片形状、计数口径全在共享内核
    `kaas_common.trade_doc.render_fingerprint`（两端一份，不另写判定）。

    保守语义：取不到单据 / 该张意外抛异常 ⇒ 该卡 `reason=unavailable` + `error`，
    **其余张照常交付**；`matches=true` 只可能来自内核的 `matched` / `version_drift`
    （都表示**内容摘要确实一致**），装配失败/无基线一律 false。
    """
    try:
        ids = parse_render_check_doc_ids(doc_ids)
    except RenderCheckBatchError as exc:
        raise HTTPException(status_code=400, detail={
            "error": "validation", "code": exc.code, "detail": exc.detail,
        })

    # 一次把本批单据取出来（省 N-1 次查询；装配本身仍是逐张的，那才是主要成本）
    rows = await db.fetch(
        request,
        "SELECT * FROM trade_docs WHERE tenant_id=$1 AND id = ANY($2::bigint[])",
        DEFAULT_TENANT, ids, table="trade_docs",
    )
    by_id = {int(r["id"]): r for r in rows}

    items = []
    for doc_id in ids:
        d = by_id.get(doc_id)
        if d is None:
            # 不存在 / 不属于本租户：一张卡说明，不把整批 404 掉
            items.append(render_check_card(doc_id, error="DOC_NOT_FOUND"))
            continue
        try:
            check = await _check_one_doc_render_fingerprint(d, doc_id, request, user)
            items.append(render_check_card(doc_id, d.get("doc_no"), check))
        except Exception as exc:  # noqa: BLE001 —— 一张炸了不能拖垮整批
            print(f"[trade-docs] 批量对账：单据 {doc_id} 意外失败（其余照常交付）："
                  f"{type(exc).__name__}: {exc}")
            items.append(render_check_card(doc_id, d.get("doc_no"), error=type(exc).__name__))
    return {**summarize_render_checks(items), "items": items}


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
    d = await _get_doc_or_404(request, doc_id, user)

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
            # 内容级版本（TODO A1）：翻译写回也是一次内容变更
            await _cv.record_content_version(
                db, request,
                tenant_id=DEFAULT_TENANT, doc_id=doc_id, payload=payload,
                source=_cv.SOURCE_TRANSLATE, actor_id=str(user["id"]),
            )
        except RuleError:
            pass   # 翻译结果仍返回，仅不写回

    return {"fields": merged, "path": path, "task": TRANSLATE_TASK_KEY}


# ── 单证内容级版本（TODO A1）─────────────────────────────────────────────────
# 为什么要有：草稿期 `raw_payload.custom` 改动是**覆盖**，改前找不回；
# `raw_payload._audit` 只有"谁/何时/改了哪些键"，不含整份快照、不可回滚。
# 版本链与 `file_objects.version`（上传 PDF 的文件版本）是两条独立链。

class TradeDocRestoreIn(BaseModel):
    """恢复历史版本：note 可选（落进新版本的备注，便于对账）。"""
    note: Optional[str] = None


def _decode_payload(raw) -> dict:
    """jsonb 列在 `table=` 解码失败时可能是字符串，统一成 dict。"""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            loaded = _json.loads(raw)
            return loaded if isinstance(loaded, dict) else {}
        except ValueError:
            return {}
    return {}


@app.get("/api/v1/trade-docs/{doc_id}/content-versions")
async def list_trade_doc_content_versions(
    doc_id: int,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """内容版本列表（倒序）。**不返回整份 payload**：图片是 base64 内联，
    一个版本可能 1MB+，列表只带 custom 键名，详情再按版本号取。"""
    d = await _get_doc_or_404(request, doc_id, user)
    rows = await db.fetch(
        request,
        "SELECT v.version_no, v.change_source, v.actor_id, v.note, v.created_at,"
        " COALESCE(("
        "   SELECT jsonb_agg(k ORDER BY k)"
        # 包成子查询再 FROM：避免 schema-coverage 门禁把 jsonb_object_keys 当表名
        "     FROM (SELECT jsonb_object_keys("
        "       COALESCE(v.raw_payload->'custom', '{}'::jsonb)) AS k) AS keys"
        " ), '[]'::jsonb) AS custom_keys"
        " FROM trade_doc_content_versions v"
        " WHERE v.tenant_id=$1 AND v.trade_doc_id=$2"
        " ORDER BY v.version_no DESC",
        DEFAULT_TENANT, d["id"],
    )
    items = [{
        "version_no": r["version_no"],
        "change_source": r["change_source"],
        "actor_id": r["actor_id"],
        "note": r["note"],
        "created_at": r["created_at"],
        "custom_keys": r.get("custom_keys") or [],
    } for r in rows]
    return {"doc_id": d["id"], "total": len(items), "items": items}


@app.get("/api/v1/trade-docs/{doc_id}/content-versions/{version_no}")
async def get_trade_doc_content_version(
    doc_id: int,
    version_no: int,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """某个内容版本的完整 payload（回看/对比用）。"""
    d = await _get_doc_or_404(request, doc_id, user)
    row = await db.fetchrow(
        request,
        "SELECT version_no, raw_payload, change_source, actor_id, note, created_at"
        " FROM trade_doc_content_versions"
        " WHERE tenant_id=$1 AND trade_doc_id=$2 AND version_no=$3",
        DEFAULT_TENANT, d["id"], version_no, table="trade_doc_content_versions",
    )
    if row is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "VERSION_NOT_FOUND",
            "detail": f"内容版本 v{version_no} 不存在",
        })
    return {
        "version_no": row["version_no"],
        "change_source": row["change_source"],
        "actor_id": row["actor_id"],
        "note": row["note"],
        "created_at": row["created_at"],
        "raw_payload": _decode_payload(row["raw_payload"]),
    }


@app.post("/api/v1/trade-docs/{doc_id}/content-versions/{version_no}/restore")
async def restore_trade_doc_content_version(
    doc_id: int,
    version_no: int,
    request: Request,
    body: TradeDocRestoreIn,
    user: dict = Depends(_get_current_user),
):
    """把历史版本的内容恢复为当前内容（仅 draft）。

    - issued/void 一律 409：已签发是法律凭证，内容冻结（不能用「恢复」绕过锁）；
    - 报价单（doc_type='quotation'）409：它是报价的 1:1 同步产物，下次报价更新会覆盖，
      恢复只会造成"看起来恢复了、同步又变回去"的困惑；
    - 恢复本身也产生一个新版本（source=restore），版本链只增不删。
    """
    d = await _get_doc_or_404(request, doc_id, user)
    try:
        assert_draft(d["status"])
    except RuleError as exc:
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": exc.code,
            "detail": "已签发/作废单证内容冻结，不能恢复历史版本",
        })
    if d["doc_type"] == "quotation":
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": "QUOTATION_DOC_SYNCED",
            "detail": "报价单由报价自动同步生成，恢复内容会被下次报价更新覆盖",
        })
    row = await db.fetchrow(
        request,
        "SELECT version_no, raw_payload FROM trade_doc_content_versions"
        " WHERE tenant_id=$1 AND trade_doc_id=$2 AND version_no=$3",
        DEFAULT_TENANT, d["id"], version_no, table="trade_doc_content_versions",
    )
    if row is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "VERSION_NOT_FOUND",
            "detail": f"内容版本 v{version_no} 不存在",
        })
    payload = _decode_payload(row["raw_payload"])
    await _cv.record_content_version(
        db, request,
        tenant_id=DEFAULT_TENANT, doc_id=d["id"], payload=payload,
        source=_cv.SOURCE_RESTORE, actor_id=str(user["id"]),
        note=body.note or f"恢复至 v{version_no}",
    )
    new_doc = await db.fetchrow(
        request,
        "UPDATE trade_docs SET raw_payload=$3, updated_at=now()"
        " WHERE tenant_id=$1 AND id=$2 RETURNING *",
        DEFAULT_TENANT, d["id"], _json.dumps(payload, ensure_ascii=False, default=str),
        table="trade_docs",
    )
    return {"doc": _row_to_doc(new_doc), "restored_version_no": version_no}
