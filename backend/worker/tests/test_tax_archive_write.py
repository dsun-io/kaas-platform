"""税务档案写路径：校验下沉 + 旧 handler 回归（2026-10-24，P2 §9 #4 前置）。

两段：
1. **共享纯校验单测**（kaas_common.workstation.tax_archive_rules）—— 单一真源；
2. **旧 handler 回归**（tax_archives.py 的 POST/PATCH/DELETE 直调 + 假库）——
   校验下沉后**行为逐字不变**：错误码/文案/HTTP 状态、SQL/参数顺序、响应键。

注意：handler 里的 `db` 是 `from main import db` 的**绑定副本**，而 `_require_team_admin`
用的是 main 模块的 `db` —— 两个都要打桩。
"""
from __future__ import annotations

import asyncio
import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

main = load_main()

import tax_archives  # noqa: E402
from kaas_common.workstation import tax_archive_rules as rules  # noqa: E402

NOW = datetime(2026, 10, 24, 8, 0, tzinfo=timezone.utc)
_UNSET = object()
ADMIN = {"id": 1, "role": "system_admin", "team_id": 4}
MEMBER = {"id": 9, "role": "user", "team_id": 4}
NO_TEAM = {"id": 11, "role": "user", "team_id": None}


# ══════════════════════════════════════════════════════════════════════════════
# 一、共享纯校验单测（唯一真源）
# ══════════════════════════════════════════════════════════════════════════════

def _err(callable_):
    with pytest.raises(HTTPException) as ei:
        callable_()
    return ei.value


class TestSharedRules:
    def test_名称归一_strip_与空值_422(self):
        assert rules.normalize_name("  默认税档  ") == "默认税档"
        exc = _err(lambda: rules.normalize_name("   "))
        assert exc.status_code == 422
        assert exc.detail == {
            "error": "validation", "code": "NAME_REQUIRED",
            "detail": "档案名称不能为空",
        }

    def test_编码归一_空白变None(self):
        assert rules.normalize_code("  TAX-1  ") == "TAX-1"
        assert rules.normalize_code("   ") is None
        assert rules.normalize_code(None) is None

    def test_税率值_范围与必填(self):
        assert rules.clean_tax_values({"output_vat_rate": 0.13, "misc_fee_rate": 0}) == {
            "output_vat_rate": 0.13, "misc_fee_rate": 0.0,
        }
        # 兼容 pydantic 模型（handler 直接传 TaxValuesIn）
        model = tax_archives.TaxValuesIn(output_vat_rate=0.09)
        assert rules.clean_tax_values(model) == {"output_vat_rate": 0.09}
        assert rules.clean_tax_values(None) == {}

        over = _err(lambda: rules.clean_tax_values({"output_vat_rate": 1.5}))
        assert over.status_code == 422
        assert over.detail["code"] == "INVALID_TAX_RATE"
        assert over.detail["detail"] == "output_vat_rate 必须在 0~1 之间（10% 请填 0.1）"

        empty = _err(lambda: rules.clean_tax_values({}))
        assert empty.status_code == 422
        assert empty.detail == {
            "error": "validation", "code": "TAX_VALUES_REQUIRED",
            "detail": "至少填写一个税率项",
        }

    def test_日期解析_空与非法的文案(self):
        assert rules.parse_effective_date(None) is None
        assert rules.parse_effective_date("") is None
        assert rules.parse_effective_date("2026-10-01") == date(2026, 10, 1)
        assert rules.parse_effective_date("2026-10-01T00:00:00") == date(2026, 10, 1)

        exc = _err(lambda: rules.parse_effective_date("2026-13-40"))
        assert exc.status_code == 422
        assert exc.detail == {
            "error": "validation", "code": "INVALID_DATE",
            "detail": "日期格式不合法：2026-13-40（应为 YYYY-MM-DD）",
        }

    def test_状态校验(self):
        assert rules.validate_status("active") == "active"
        assert rules.validate_status("inactive") == "inactive"
        exc = _err(lambda: rules.validate_status("archived"))
        assert exc.status_code == 422
        assert exc.detail == {
            "error": "validation", "code": "INVALID_STATUS",
            "detail": "status 只能是 active / inactive",
        }

    def test_PATCH_合并语义_只改显式给出的字段(self):
        row = {
            "name": "旧名", "code": "TAX-OLD",
            "effective_from": date(2026, 1, 1), "effective_to": None,
            "tax_values": {"output_vat_rate": 0.13}, "source": "manual", "status": "active",
        }
        merged = rules.resolve_patch({"name": "新名  "}, row)
        assert merged["name"] == "新名"
        assert merged["code"] == "TAX-OLD"          # 未给 ⇒ 沿用
        assert merged["effective_from"] == date(2026, 1, 1)
        assert merged["tax_values"] == {"output_vat_rate": 0.13}
        assert merged["status"] == "active"

        # 显式 null 也当"未给"（与旧 handler 的 `is not None` 口径一致）
        merged2 = rules.resolve_patch({"name": None, "status": None}, row)
        assert merged2["name"] == "旧名"
        assert merged2["status"] == "active"

        bad = _err(lambda: rules.resolve_patch({"status": "archived"}, row))
        assert bad.detail["code"] == "INVALID_STATUS"

    def test_档案团队归属校验(self):
        exc = _err(lambda: rules.ensure_archive_team(
            {"team_id": 8}, 4, "不能修改其他团队的税务档案"))
        assert exc.status_code == 403
        assert exc.detail == {
            "error": "forbidden", "code": "TEAM_ADMIN_REQUIRED",
            "detail": "不能修改其他团队的税务档案",
        }
        # 同团队不抛
        rules.ensure_archive_team({"team_id": 4}, 4, "x")
        rules.ensure_archive_team({"team_id": "4"}, "4", "x")


# ══════════════════════════════════════════════════════════════════════════════
# 二、旧 handler 回归（校验下沉后行为逐字不变）
# ══════════════════════════════════════════════════════════════════════════════

class _FakeDB:
    """按 SQL 前缀分派的假库；taken_values 决定唯一性/取号的命中集合。"""

    def __init__(self, *, team_created_by=9, archive=None, taken_values=None):
        self.team_created_by = team_created_by
        self.archive = archive
        self.taken = set(taken_values or [])
        self.calls = []
        self.insert_params = None
        self.update_params = None
        self.executed = []

    async def fetchrow(self, request, sql, *params, table=None):
        text = " ".join(str(sql).split())
        self.calls.append((text, params))
        if "FROM teams WHERE id=" in text:
            return {"created_by": self.team_created_by}
        if text.startswith("SELECT * FROM tax_archives"):
            # 复刻 _archive_or_404 的团队过滤：!= 本团队的档案**根本查不到**（404 不泄露存在性）
            if self.archive is None:
                return None
            if "AND team_id = $" in text and self.archive.get("team_id") != params[2]:
                return None
            return self.archive
        if text.startswith("INSERT INTO tax_archives"):
            self.insert_params = params
            tenant, team_id, code, name, eff_from, eff_to, values, source, created_by = params
            return {
                "id": 99, "tenant_id": tenant, "team_id": team_id, "code": code, "name": name,
                "effective_from": eff_from, "effective_to": eff_to,
                "tax_values": json.loads(values), "source": source, "status": "active",
                "created_by": created_by, "created_at": NOW, "updated_at": NOW,
            }
        if text.startswith("UPDATE tax_archives SET name="):
            self.update_params = params
            tenant, archive_id, name, code, eff_from, eff_to, values, source, status = params
            return {
                "id": archive_id, "tenant_id": tenant,
                "team_id": (self.archive or {}).get("team_id"),
                "code": code, "name": name, "effective_from": eff_from,
                "effective_to": eff_to, "tax_values": json.loads(values),
                "source": source, "status": status, "created_at": NOW, "updated_at": NOW,
            }
        raise AssertionError("未预期的 fetchrow: " + text)

    async def fetchval(self, request, sql, *params):
        text = " ".join(str(sql).split())
        self.calls.append((text, params))
        if "SELECT 1 FROM tax_archives" in text:
            value = params[2] if len(params) > 2 else None
            return 1 if value in self.taken else None
        raise AssertionError("未预期的 fetchval: " + text)

    async def execute(self, request, sql, *params):
        text = " ".join(str(sql).split())
        self.executed.append((text, params))
        return "UPDATE 1"


def _install(monkeypatch, db):
    monkeypatch.setattr(tax_archives, "db", db)
    monkeypatch.setattr(main, "db", db)
    return db


def _archive(team_id=4, **overrides):
    row = {
        "id": 7, "tenant_id": "default", "team_id": team_id, "code": "TAX-1",
        "name": "默认税档", "effective_from": date(2026, 1, 1), "effective_to": None,
        "tax_values": {"output_vat_rate": 0.13}, "source": "manual",
        "status": "active", "created_at": NOW, "updated_at": NOW,
    }
    row.update(overrides)
    return row


def _create_body(**overrides):
    data = {
        "name": "默认税档",
        "code": "TAX-2",
        "effective_from": "2026-10-01",
        "effective_to": None,
        "tax_values": tax_archives.TaxValuesIn(output_vat_rate=0.13),
        "source": "manual",
    }
    data.update(overrides)
    return tax_archives.TaxArchiveCreate(**data)


class TestCreateRegression:
    def test_成功_响应键与INSERT参数逐字(self, monkeypatch):
        db = _install(monkeypatch, _FakeDB())
        out = asyncio.run(tax_archives.create_tax_archive(
            object(), _create_body(name="  默认税档  "), user=ADMIN))
        assert set(out.keys()) == {
            "id", "code", "name", "effective_from", "effective_to",
            "tax_values", "source", "status", "created_at", "updated_at",
        }
        assert out["id"] == 99
        assert out["name"] == "默认税档"          # strip 后入库
        assert out["effective_from"] == "2026-10-01"   # DATE 只出日期
        assert out["status"] == "active"
        # INSERT 参数顺序与旧版一致：tenant, team, code, name, eff_from, eff_to, json, source, created_by
        assert db.insert_params == (
            "default", 4, "TAX-2", "默认税档", date(2026, 10, 1), None,
            '{"output_vat_rate": 0.13}', "manual", "1",
        )

    def test_名称空白_422_NAME_REQUIRED_且不写库(self, monkeypatch):
        db = _install(monkeypatch, _FakeDB())
        exc = _err(lambda: asyncio.run(tax_archives.create_tax_archive(
            object(), _create_body(name="   "), user=ADMIN)))
        assert exc.status_code == 422
        assert exc.detail["code"] == "NAME_REQUIRED"
        assert db.insert_params is None

    def test_税率越界_422_INVALID_TAX_RATE_且不写库(self, monkeypatch):
        db = _install(monkeypatch, _FakeDB())
        exc = _err(lambda: asyncio.run(tax_archives.create_tax_archive(
            object(), _create_body(tax_values=tax_archives.TaxValuesIn(misc_fee_rate=2)),
            user=ADMIN)))
        assert exc.status_code == 422
        assert exc.detail["code"] == "INVALID_TAX_RATE"
        assert exc.detail["detail"] == "misc_fee_rate 必须在 0~1 之间（10% 请填 0.1）"
        assert db.insert_params is None

    def test_重名_409_NAME_TAKEN_文案逐字(self, monkeypatch):
        db = _install(monkeypatch, _FakeDB(taken_values={"默认税档"}))
        exc = _err(lambda: asyncio.run(tax_archives.create_tax_archive(
            object(), _create_body(), user=ADMIN)))
        assert exc.status_code == 409
        assert exc.detail == {
            "error": "conflict", "code": "NAME_TAKEN",
            "detail": "税务档案名称「默认税档」在本团队已存在",
        }
        assert db.insert_params is None

    def test_未给编码_自动取号_TAX_日期_序号(self, monkeypatch):
        today = datetime.now().strftime("%Y%m%d")
        taken = {f"TAX-{today}-1"}
        db = _install(monkeypatch, _FakeDB(taken_values=taken))
        out = asyncio.run(tax_archives.create_tax_archive(
            object(), _create_body(code=None), user=ADMIN))
        assert out["code"] == f"TAX-{today}-2"
        assert db.insert_params[2] == f"TAX-{today}-2"

    def test_日期非法_422_INVALID_DATE(self, monkeypatch):
        db = _install(monkeypatch, _FakeDB())
        exc = _err(lambda: asyncio.run(tax_archives.create_tax_archive(
            object(), _create_body(effective_from="2026-13-40"), user=ADMIN)))
        assert exc.status_code == 422
        assert exc.detail == {
            "error": "validation", "code": "INVALID_DATE",
            "detail": "日期格式不合法：2026-13-40（应为 YYYY-MM-DD）",
        }
        assert db.insert_params is None

    def test_无团队_403_TEAM_REQUIRED(self, monkeypatch):
        db = _install(monkeypatch, _FakeDB())
        exc = _err(lambda: asyncio.run(tax_archives.create_tax_archive(
            object(), _create_body(), user=NO_TEAM)))
        assert exc.status_code == 403
        assert exc.detail["code"] == "TEAM_REQUIRED"
        assert db.insert_params is None


class TestUpdateRegression:
    def _patch(self, monkeypatch, body, user=MEMBER, archive=_UNSET, **db_kwargs):
        db = _install(monkeypatch, _FakeDB(
            archive=_archive() if archive is _UNSET else archive, **db_kwargs))
        try:
            out = asyncio.run(tax_archives.update_tax_archive(
                7, object(), body, user=user))
            return out, db, None
        except HTTPException as exc:
            return None, db, exc

    def _body(self, **overrides):
        data = {"name": "新名字"}
        data.update(overrides)
        return tax_archives.TaxArchivePatch(**data)

    def test_成功_只改给出的字段_更新参数逐字(self, monkeypatch):
        out, db, exc = self._patch(monkeypatch, self._body(name="  新名字  "))
        assert exc is None
        assert out["name"] == "新名字"
        assert out["code"] == "TAX-1"                    # 未给 ⇒ 沿用旧值
        assert out["effective_from"] == "2026-01-01"
        assert out["status"] == "active"
        assert db.update_params == (
            "default", 7, "新名字", "TAX-1", date(2026, 1, 1), None,
            '{"output_vat_rate": 0.13}', "manual", "active",
        )

    def test_其他团队档案_404_不泄露存在性(self, monkeypatch):
        # 别团队档案在 _archive_or_404 的团队过滤里就查不到 ⇒ 404（不是 403，
        # 避免"存在但不可改"泄露）。ensure_archive_team 的 403 是同一谓词下的防御性分支。
        out, db, exc = self._patch(monkeypatch, self._body(), archive=_archive(team_id=8))
        assert exc.status_code == 404
        assert exc.detail == {"error": "not_found", "code": "TAX_ARCHIVE_NOT_FOUND"}
        assert db.update_params is None

    def test_状态非法_422_INVALID_STATUS_且不改库(self, monkeypatch):
        out, db, exc = self._patch(monkeypatch, self._body(status="archived"))
        assert exc.status_code == 422
        assert exc.detail["code"] == "INVALID_STATUS"
        assert db.update_params is None

    def test_不存在_404_TAX_ARCHIVE_NOT_FOUND(self, monkeypatch):
        out, db, exc = self._patch(monkeypatch, self._body(), archive=None)
        assert exc.status_code == 404
        assert exc.detail == {"error": "not_found", "code": "TAX_ARCHIVE_NOT_FOUND"}

    def test_非团队管理员_403_TEAM_ADMIN_REQUIRED(self, monkeypatch):
        # 团队成员但不是团队创建人 ⇒ _require_team_admin 拦（在校验/写库之前）
        out, db, exc = self._patch(monkeypatch, self._body(), team_created_by=777)
        assert exc.status_code == 403
        assert exc.detail == {
            "error": "forbidden", "code": "TEAM_ADMIN_REQUIRED",
            "detail": "仅团队管理员可修改企业抬头/收款信息/公章",
        }
        assert db.update_params is None

    def test_无团队_403_TEAM_REQUIRED(self, monkeypatch):
        out, db, exc = self._patch(monkeypatch, self._body(), user=NO_TEAM)
        assert exc.status_code == 403
        assert exc.detail["code"] == "TEAM_REQUIRED"

    def test_重名_409_NAME_TAKEN(self, monkeypatch):
        out, db, exc = self._patch(
            monkeypatch, self._body(name="另一个"), taken_values={"另一个"})
        assert exc.status_code == 409
        assert exc.detail["code"] == "NAME_TAKEN"
        assert db.update_params is None


class TestDeleteRegression:
    def _delete(self, monkeypatch, user=MEMBER, archive=_UNSET, **db_kwargs):
        db = _install(monkeypatch, _FakeDB(
            archive=_archive() if archive is _UNSET else archive, **db_kwargs))
        try:
            return asyncio.run(tax_archives.delete_tax_archive(7, object(), user=user)), db, None
        except HTTPException as exc:
            return None, db, exc

    def test_成功_软删_且SQL参数逐字(self, monkeypatch):
        out, db, exc = self._delete(monkeypatch)
        assert exc is None
        assert out == {"id": 7, "status": "inactive"}
        assert db.executed == [(
            "UPDATE tax_archives SET status='inactive', updated_at=now()"
            " WHERE tenant_id=$1 AND id=$2",
            ("default", 7),
        )]

    def test_其他团队档案_404_且不写库(self, monkeypatch):
        out, db, exc = self._delete(monkeypatch, archive=_archive(team_id=8))
        assert exc.status_code == 404
        assert exc.detail == {"error": "not_found", "code": "TAX_ARCHIVE_NOT_FOUND"}
        assert db.executed == []

    def test_管理员本团队可删(self, monkeypatch):
        out, db, exc = self._delete(monkeypatch, user=ADMIN)
        assert exc is None
        assert out == {"id": 7, "status": "inactive"}

    def test_管理员跨团队档案_仍是404(self, monkeypatch):
        # 内核现状：管理员(team_id=4) 的 _archive_or_404 带 team 过滤 ⇒ 别团队档案查不到。
        # （平台管理员"无团队"时被 _team_id 的 TEAM_REQUIRED 拦下 —— 三处口径一起钉住。）
        out, db, exc = self._delete(monkeypatch, user=ADMIN, archive=_archive(team_id=8))
        assert exc.status_code == 404
        assert db.executed == []
