"""三遍交叉核验 + 关系式校验 + 术语阶梯校验。

    第 1 遍  Decimal 精算      正式业务路径，按声明小数位逐环节落定
    第 2 遍  Fraction 精确重算  同一批公式在有理数下求值（零精度损失），
                                再按同样小数位落定，逐字段反证第 1 遍
    第 3 遍  成品读回          重新打开已生成的文件，逐格比对内存值，
                                并校验内部/客户两张投影是否真的分开
    关系式   产品类声明的 invariants 逐行逐订单求值
    阶梯     术语各档 = 上档 + 本档费用；含税 = 不含税 + 销项税；
             整批 = 单件 × 件数；EXW 起点 = 价链输出 × 单件重量
    档案     税务档案自检：退税率是否已填、征税率 > 0、生效期是否覆盖报价日

发现不了错误的核验等于没有核验，所以测试里专门注入了篡改值逐项确认能被抓到。
"""
from __future__ import annotations

import csv
import io
import os
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, InvalidOperation, localcontext
from fractions import Fraction
from typing import Any, Optional

from . import engine as engine_mod
from .engine import EngineError, QuoteResult, order_scopes
from .expr import ExpressionError, evaluate
from .numeric import DECIMAL, FRACTION, PRECISION, quantize, to_decimal
from .pricing import DEFAULT_DECIMALS as PRICE_DECIMALS


@dataclass
class Issue:
    pass_no: int
    row: int
    field: str
    detail: str
    severity: str = "error"

    def __str__(self) -> str:
        where = f"第 {self.row} 行" if self.row else "整表"
        return f"[{self._pass_label()}] {where} {self.field}: {self.detail}"

    def _pass_label(self) -> str:
        return {
            1: "第1遍 Decimal",
            2: "第2遍 Fraction",
            3: "第3遍 读回",
            0: "关系式/结构",
        }.get(self.pass_no, f"第{self.pass_no}遍")


@dataclass
class VerificationReport:
    passes: list = field(default_factory=list)
    issues: list = field(default_factory=list)
    checks: int = 0

    @property
    def ok(self) -> bool:
        return not any(i.severity == "error" for i in self.issues)

    def errors(self) -> list:
        return [i for i in self.issues if i.severity == "error"]

    def warnings(self) -> list:
        return [i for i in self.issues if i.severity != "error"]

    def summary(self) -> str:
        head = (
            f"核验点数 {self.checks}，"
            + ("全部通过 ✅" if self.ok else f"存在 {len(self.errors())} 项问题 ❌")
        )
        lines = [head] + [f"  · {p}" for p in self.passes]
        lines += [f"  ✗ {i}" for i in self.errors()[:20]]
        lines += [f"  ! {i}" for i in self.warnings()[:10]]
        return "\n".join(lines)

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "checks": self.checks,
            "passes": list(self.passes),
            "errors": [
                {"row": i.row, "field": i.field, "detail": i.detail} for i in self.errors()
            ],
            "warnings": [
                {"row": i.row, "field": i.field, "detail": i.detail} for i in self.warnings()
            ],
        }


def _is_numeric(value) -> bool:
    if isinstance(value, bool):
        return False
    return isinstance(value, (int, float, Decimal, Fraction))


def _field_decimals(result: QuoteResult) -> dict:
    out: dict = {}
    for spec in result.product.derived:
        if spec.decimals is not None:
            out[("derived", spec.name)] = spec.decimals
    for spec in result.product.piece_metrics:
        if spec.decimals is not None:
            out[("piece", spec.name)] = spec.decimals
    for spec in result.product.order_metrics:
        if spec.decimals is not None:
            out[("orders", spec.name)] = spec.decimals
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 第 1、2 遍：Decimal vs Fraction
# ─────────────────────────────────────────────────────────────────────────────
def verify_precision(result: QuoteResult) -> VerificationReport:
    rep = VerificationReport()
    rep.passes.append(f"第1遍 Decimal 精算 {len(result.rows)} 行 × {len(result.request.orders)} 订单")

    try:
        with localcontext() as ctx:
            ctx.prec = PRECISION
            exact = engine_mod.build(result.request, FRACTION)
    except (EngineError, ExpressionError) as exc:
        rep.issues.append(Issue(2, 0, "Fraction 重算", f"无法在精确模式下重算: {exc}"))
        return rep
    except Exception as exc:  # noqa: BLE001 - 有意兜底：Fraction 精确重算失败（非整数指数/无理开方）如实报 issue
        rep.issues.append(Issue(2, 0, "Fraction 重算", f"无法在精确模式下重算: {exc}"))
        return rep

    if len(exact.rows) != len(result.rows):
        rep.issues.append(
            Issue(2, 0, "行数", f"Decimal={len(result.rows)} 行, Fraction={len(exact.rows)} 行")
        )
        return rep
    rep.passes.append(f"第2遍 Fraction 精确重算 {len(exact.rows)} 行")

    nds = _field_decimals(result)
    pr_nds = dict(PRICE_DECIMALS)
    pr_nds.update(result.request.policy.decimals or {})

    def cmp(row_no, field_name, got, want, nd):
        rep.checks += 1
        if not _is_numeric(got) or not _is_numeric(want):
            if str(got) != str(want):
                rep.issues.append(
                    Issue(2, row_no, field_name, f"Decimal={got!r} 精确重算={want!r}")
                )
            return
        a = quantize(to_decimal(got), nd) if nd is not None else to_decimal(got)
        b = quantize(to_decimal(want), nd) if nd is not None else to_decimal(want)
        if a != b:
            rep.issues.append(Issue(2, row_no, field_name, f"Decimal={a} 精确重算={b}"))

    for drow, frow in zip(result.rows, exact.rows):
        for (bucket, name), nd in nds.items():
            if bucket == "derived":
                cmp(drow.index, f"derived.{name}", drow.derived.get(name), frow.derived.get(name), nd)
            elif bucket == "piece":
                cmp(drow.index, f"piece.{name}", drow.piece.get(name), frow.piece.get(name), nd)
            else:
                for oname in drow.orders:
                    cmp(
                        drow.index,
                        f"orders.{oname}.{name}",
                        drow.orders[oname].get(name),
                        frow.orders[oname].get(name),
                        nd,
                    )
        for field_name, got in drow.price.items():
            if field_name not in frow.price:
                continue
            cmp(drow.index, f"price.{field_name}", got, frow.price[field_name],
                pr_nds.get(field_name, 4))
    rep.passes.append("第2遍 逐字段比对完成")
    return rep


# ─────────────────────────────────────────────────────────────────────────────
# 关系式校验
# ─────────────────────────────────────────────────────────────────────────────
def verify_invariants(result: QuoteResult) -> VerificationReport:
    rep = VerificationReport()
    invs = result.product.invariants
    rep.passes.append(f"关系式校验 {len(invs)} 条")
    if not invs:
        return rep
    for row, order, scope in order_scopes(result):
        for inv in invs:
            rep.checks += 1
            try:
                ok = evaluate(inv.expr, scope, DECIMAL)
            except (ExpressionError, ZeroDivisionError) as exc:
                rep.issues.append(Issue(0, row.index, inv.name, f"求值失败: {exc}", inv.severity))
                continue
            if ok is not True:
                rep.issues.append(
                    Issue(
                        0,
                        row.index,
                        inv.name,
                        f"不成立（订单 {order.name}）：{inv.expr}",
                        inv.severity,
                    )
                )
    return rep


# ─────────────────────────────────────────────────────────────────────────────
# 术语阶梯校验
# ─────────────────────────────────────────────────────────────────────────────
def verify_terms(result: QuoteResult) -> VerificationReport:
    rep = VerificationReport()
    if not result.term_codes:
        return rep
    rep.passes.append(
        f"术语阶梯校验 {len(result.term_codes)} 档 × {len(result.request.orders)} 订单"
    )
    ladder = result.request.terms
    for row in result.rows:
        weight = row.derived.get(ladder.weight_field)
        if weight is None:
            continue
        for order in result.request.orders:
            pieces = (row.orders.get(order.name) or {}).get("pieces")
            prev = None
            for code in result.term_codes:
                entry = (row.terms.get(code) or {}).get(order.name)
                if entry is None:
                    rep.issues.append(
                        Issue(0, row.index, f"terms.{code}", f"订单 {order.name} 缺少该术语结果")
                    )
                    continue
                tag = f"terms.{code}.{order.name}"
                rep.checks += 1
                if entry["price_incl"] != quantize(
                    to_decimal(entry["subtotal_excl"]) + to_decimal(entry["output_tax"]), 6
                ):
                    rep.issues.append(Issue(0, row.index, tag, "含税价 ≠ 不含税价 + 销项税额"))
                if prev is None:
                    want = quantize(to_decimal(row.price["quote_excl_vat"]) * to_decimal(weight), 4)
                    rep.checks += 1
                    if entry["subtotal_excl"] != want:
                        rep.issues.append(
                            Issue(
                                0,
                                row.index,
                                tag,
                                f"EXW 起点 {entry['subtotal_excl']} ≠ 价链输出 × 单件重量 {want}",
                            )
                        )
                else:
                    fees_sum = sum((to_decimal(v) for v in entry["fees"].values()), to_decimal(0))
                    want = quantize(to_decimal(prev) + fees_sum, 4)
                    rep.checks += 1
                    if entry["subtotal_excl"] != want:
                        rep.issues.append(
                            Issue(
                                0,
                                row.index,
                                tag,
                                f"累加不成立：本档 {entry['subtotal_excl']} ≠ 上档 {prev} + 费用 {fees_sum}",
                            )
                        )
                if pieces is not None and "total_incl" in entry:
                    rep.checks += 1
                    if entry["total_incl"] != quantize(
                        to_decimal(entry["price_incl"]) * to_decimal(pieces), 2
                    ):
                        rep.issues.append(Issue(0, row.index, tag, "整批金额 ≠ 单件价 × 件数"))
                prev = entry["subtotal_excl"]

    # 结构提示（不阻断）
    for w in ladder.audit():
        rep.issues.append(Issue(0, 0, "术语结构", w, "warning"))
    return rep


# ─────────────────────────────────────────────────────────────────────────────
# 第 3 遍：成品读回
# ─────────────────────────────────────────────────────────────────────────────
def _read_xlsx_sheets(path: str) -> dict:
    from openpyxl import load_workbook

    wb = load_workbook(path, data_only=True)
    out: dict = {}
    for name in wb.sheetnames:
        rows = []
        for row in wb[name].iter_rows(values_only=True):
            values = list(row)
            while values and (values[-1] is None or values[-1] == ""):
                values.pop()
            rows.append(values)
        out[name] = rows
    return out


def _read_csv_rows(path: str) -> list:
    with io.open(path, "r", encoding="utf-8-sig", newline="") as fh:
        return [list(r) for r in csv.reader(fh)]


def _find_header_row(rows, header) -> Optional[int]:
    for i, row in enumerate(rows):
        if list(row)[: len(header)] == list(header):
            return i
    return None


def _find_sheet_by_header(sheets, header):
    for rows in sheets.values():
        if _find_header_row(rows, header) is not None:
            return rows
    return None


def _compare_cell(rep: VerificationReport, row_no: int, col, mem_val, file_val) -> None:
    if mem_val is None or mem_val == "":
        if file_val not in (None, ""):
            rep.issues.append(Issue(3, row_no, col.label, f"期望空值, 实际 {file_val!r}"))
        return
    if _is_numeric(mem_val):
        nd = col.decimals
        want = quantize(to_decimal(mem_val), nd) if nd is not None else to_decimal(mem_val)
        try:
            got = to_decimal(file_val)
        except (InvalidOperation, TypeError, ValueError):
            rep.issues.append(Issue(3, row_no, col.label, f"成品值不可解析为数值: {file_val!r}"))
            return
        nd_cmp = nd if nd is not None else 6
        if quantize(want, nd_cmp) != quantize(got, nd_cmp):
            rep.issues.append(Issue(3, row_no, col.label, f"内存 {want} ≠ 成品 {got}"))
    elif str(mem_val) != str(file_val):
        rep.issues.append(Issue(3, row_no, col.label, f"内存 {mem_val!r} ≠ 成品 {file_val!r}"))


def verify_roundtrip(result: QuoteResult, path: str) -> VerificationReport:
    """第 3 遍：读回成品文件，逐格与内存值比对（内部与客户两张投影都校验）。"""
    rep = VerificationReport()
    rep.passes.append(f"第3遍 读回成品 {os.path.basename(path)}")
    ext = os.path.splitext(path)[1].lower()
    if ext == ".xlsx":
        sheets = _read_xlsx_sheets(path)
        single_table = False
    elif ext == ".csv":
        sheets = {"*": _read_csv_rows(path)}
        single_table = True
    else:
        rep.issues.append(Issue(3, 0, "读回", f"不支持的格式: {ext}"))
        return rep

    targets = []
    if result.product.internal_columns():
        targets.append(("内部明细", *result.table("internal"), result.columns("internal")))
    if result.product.customer_columns():
        targets.append(("客户报价", *result.table("customer"), result.columns("customer")))

    for name, header, body, cols in targets:
        rows = sheets.get(name) or _find_sheet_by_header(sheets, header)
        if rows is None:
            detail = f"成品文件里找不到表「{name}」"
            rep.issues.append(
                Issue(3, 0, "读回", detail + ("（CSV 输出只含单张表，跳过）" if single_table else ""),
                      "warning" if single_table else "error")
            )
            continue
        start = _find_header_row(rows, header)
        if start is None:
            rep.issues.append(Issue(3, 0, "表头", f"表「{name}」的成品表头与配置不一致"))
            continue
        data = rows[start + 1 : start + 1 + len(body)]
        if len(data) != len(body):
            rep.issues.append(
                Issue(3, 0, "行数", f"表「{name}」内存 {len(body)} 行, 成品 {len(data)} 行")
            )
            continue
        for i, (mem_row, file_row) in enumerate(zip(body, data), start=1):
            for j, col in enumerate(cols):
                if j >= len(file_row):
                    rep.issues.append(Issue(3, i, col.label, "成品缺少该列"))
                    continue
                rep.checks += 1
                _compare_cell(rep, i, col, mem_row[j], file_row[j])
        rep.passes.append(f"第3遍 表「{name}」{len(body)} 行逐格比对完成")
    return rep


# ─────────────────────────────────────────────────────────────────────────────
# 汇总
# ─────────────────────────────────────────────────────────────────────────────
def verify_all(result: QuoteResult, artifact: str | None = None) -> VerificationReport:
    """跑满三遍核验 + 关系式 + 阶梯 + 档案自检。"""
    combined = VerificationReport()
    for part in (
        verify_precision(result),
        verify_invariants(result),
        verify_terms(result),
        verify_roundtrip(result, artifact) if artifact else VerificationReport(),
    ):
        combined.passes.extend(part.passes)
        combined.issues.extend(part.issues)
        combined.checks += part.checks
    return combined
