"""团队级档位覆盖（Worker 镜像 · 生产对齐）。

缺口来源（历史背景）
--------
方案 B 收敛前，团队档位覆盖只存在于 orchestrator 业务壳；线上 Worker 一直没有
这两条路由，前端档位管理界面一调用就是 404。本文件把缺口补齐。业务规则的真源
早已迁入共享内核 `kaas_common/`（orchestrator 业务壳已删，见 `scripts/sync-shared.ps1`）。

对齐口径
--------
- **不重写任何业务规则**：改名 / 停用的语义在共享镜像
  `kaas_common.export_quote.models.apply_option_overrides` 里，本文件只做
  「读覆盖 → 合并 → 写覆盖 → 投影出参」。
- **权限判定走共享内核** `kaas_common.workstation.teams.is_team_admin`
  （团队创建者 或 平台管理员），本文件不另写一份判定。
- **先 404 后 403**：不存在的团队不该因为调用者不是管理员而返回 403
  —— 那等于承认这个 team_id 存在。
- **存储 = `team_option_overrides`**（键 `(tenant_id, team_id, product_key)`）。
  该表由迁移 `202610110015` 建立，**上线前必须先在生产库建好**，
  否则这两条会 500（比 404 更糟）。

两条硬约束（与 orchestrator 一致实际由共享内核保证）：
  · **只改显示名，不改 code** —— code 是查价键的一半。
  · **停用是软停用** —— 从界面清单消失，引擎仍能解析，历史报价单可重算。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, Field

import main as _main
from kaas_common.export_quote.models import apply_option_overrides
from kaas_common.export_quote.products import get as get_product
from kaas_common.workstation.teams import is_team_admin

app = _main.app
DEFAULT_TENANT = _main.DEFAULT_TENANT
_get_current_user = _main._get_current_user
_acquire = _main._acquire


def _json_dumps(payload: dict) -> str:
    """JSONB 参数按文本传（asyncpg 未注册 jsonb codec 时最稳）。"""
    import json  # noqa: PLC0415

    return json.dumps(payload, ensure_ascii=False)


class OptionOverrideIn(BaseModel):
    """改一个维度的档位（增量，不是整体覆盖）。字段与 orchestrator 逐字一致。"""

    product_key: str = Field(description="产品 key，如 field_fence")
    field: str = Field(description="维度字段，如 coating_code 或 coating")
    rename: Optional[dict] = None
    disable: Optional[list] = None
    enable: Optional[list] = None


def _product_or_404(product_key: str):
    try:
        return get_product(product_key)
    except Exception:
        raise HTTPException(status_code=404, detail={
            "error": "unknown_product", "product_key": product_key})


# ── 覆盖载荷的读写（与 orchestrator app/services/option_overrides.py 同语义）──

def _normalize(raw: Any) -> Dict[str, dict]:
    """只留 rename / disabled，其余丢弃 —— 免得脏键混进 JSONB。"""
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, dict] = {}
    for field, payload in raw.items():
        if not isinstance(field, str) or not isinstance(payload, dict):
            continue
        entry: Dict[str, Any] = {}
        rename = payload.get("rename")
        if isinstance(rename, dict):
            entry["rename"] = {str(k): str(v) for k, v in rename.items()}
        disabled = payload.get("disabled")
        if isinstance(disabled, (list, tuple, set)):
            entry["disabled"] = [str(x) for x in disabled]
        if entry:
            out[field] = entry
    return out


def _merge(current: dict, field: str, *, rename=None, disable=None,
           enable=None) -> Dict[str, dict]:
    """在现有一份覆盖上做增量修改，返回**新的**载荷（不改原对象）。"""
    out = {k: dict(v) for k, v in _normalize(current).items()}
    entry = out.setdefault(field, {})

    if rename:
        labels = dict(entry.get("rename") or {})
        for code, label in rename.items():
            if label in (None, ""):
                labels.pop(str(code), None)     # 空串 = 取消改名
            else:
                labels[str(code)] = str(label)
        if labels:
            entry["rename"] = labels
        else:
            entry.pop("rename", None)

    disabled = list(dict.fromkeys(entry.get("disabled") or []))
    for code in (disable or []):
        if str(code) not in disabled:
            disabled.append(str(code))
    for code in (enable or []):
        if str(code) in disabled:
            disabled.remove(str(code))
    if disabled:
        entry["disabled"] = disabled
    else:
        entry.pop("disabled", None)

    if not entry:
        out.pop(field, None)
    return out


async def _load_overrides(conn, team_id: int, product_key: str) -> dict:
    # 表里**没有 tenant_id 列**：`teams.id` 本身就是全局主键，
    # 一个团队只属于一个租户，再加一列只是冗余（迁移 202610110015）。
    row = await conn.fetchrow(
        "SELECT overrides FROM team_option_overrides"
        " WHERE team_id=$1 AND product_key=$2",
        team_id, product_key,
    )
    if row is None:
        return {}
    raw = dict(row).get("overrides")
    # asyncpg 对 JSONB 返回 str（未注册 codec 时），两者都要吃得下
    if isinstance(raw, str):
        import json  # noqa: PLC0415

        try:
            raw = json.loads(raw)
        except Exception:
            return {}
    return _normalize(raw)


async def _require_team_admin(conn, request: Request, user: dict) -> int:
    """团队管理员（团队创建者）或平台管理员；返回 team_id。"""
    team_id = user.get("team_id")
    if team_id is None:
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "NO_TEAM",
            "message": "当前账号未归属团队，无法管理团队档位"})
    # 顺序刻意是"先 404 后 403"：见模块 docstring
    team = await conn.fetchrow(
        "SELECT * FROM teams WHERE tenant_id=$1 AND id=$2", DEFAULT_TENANT, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "TEAM_NOT_FOUND"})
    team = dict(team)
    if not is_team_admin(team["created_by"], user["id"], user.get("role")):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "NOT_TEAM_ADMIN",
            "message": "仅团队管理员可管理本团队的档位"})
    return int(team_id)


@app.get("/api/v1/product-options/overrides", summary="团队级档位（含已停用的）")
async def list_option_overrides(
    request: Request,
    product_key: str,
    user: dict = Depends(_get_current_user),
):
    """列出该团队在该产品上的全部档位（**含已停用**并标注）。

    管理界面要能把停用的显示出来并支持「恢复」，所以不能只回可见的那部分。
    """
    product = _product_or_404(product_key)
    async with _acquire(request) as conn:
        team_id = await _require_team_admin(conn, request, user)
        overrides = await _load_overrides(conn, team_id, product_key)

    effective = apply_option_overrides(product, overrides)
    ov_map = overrides or {}

    fields: List[dict] = []
    for vg in effective.variants:
        ov = ov_map.get(f"{vg.name}_code") or ov_map.get(vg.name) or {}
        renamed = {str(k): str(v) for k, v in (ov.get("rename") or {}).items()}
        options = []
        for opt in vg.options:
            code = opt.get("code")
            ident = str(code if code is not None else opt.get("name"))
            options.append({
                "value": ident,
                "label": opt.get("name"),
                "label_en": opt.get("name_en") or "",
                "disabled": bool(opt.get("disabled")),
                "renamed": ident in renamed,
            })
        fields.append({
            "field": f"{vg.name}_code",
            "name": vg.name,
            "label": vg.label or vg.name,
            "options": options,
        })

    return {
        "product_key": product_key,
        "product_name": product.name,
        "team_id": team_id,
        "overrides": overrides,
        "fields": fields,
        "note": "停用只影响界面清单：引擎仍能解析已停用档位，历史报价单可重算。",
    }


@app.put("/api/v1/product-options/overrides", summary="改显示名 / 软停用 / 恢复")
async def update_option_overrides(
    request: Request,
    body: OptionOverrideIn,
    user: dict = Depends(_get_current_user),
):
    """增量改一个维度：`rename`（空串 = 取消改名）、`disable` / `enable`。

    **code 不会被改**（它是查价键的一半），只改显示名。
    """
    product = _product_or_404(body.product_key)
    async with _acquire(request) as conn:
        team_id = await _require_team_admin(conn, request, user)
        current = await _load_overrides(conn, team_id, body.product_key)
        merged = _merge(current, body.field, rename=body.rename,
                        disable=body.disable, enable=body.enable)

        # 只认产品定义里真有的档位：否则笔误会在库里留下永远不生效的垃圾
        known = {
            str(o.get("code") if o.get("code") is not None else o.get("name"))
            for vg in product.variants for o in vg.options
        }
        if known:
            entry = merged.get(body.field) or {}
            unknown = [c for c in (entry.get("rename") or {}) if c not in known]
            unknown += [c for c in (entry.get("disabled") or []) if c not in known]
            if unknown:
                raise HTTPException(status_code=422, detail={
                    "error": "unknown_option",
                    "message": "这些档位不在产品定义里："
                               + ", ".join(sorted(set(unknown))),
                    "known": sorted(known),
                })

        await conn.execute(
            "INSERT INTO team_option_overrides"
            " (team_id, product_key, overrides)"
            " VALUES ($1,$2,$3::jsonb)"
            " ON CONFLICT (team_id, product_key)"
            " DO UPDATE SET overrides=$3::jsonb, updated_at=now()",
            team_id, body.product_key, _json_dumps(merged),
        )
    return {
        "product_key": body.product_key,
        "team_id": team_id,
        "overrides": merged,
        "note": "已保存。停用只影响界面清单，引擎仍能解析停用档位。",
    }
