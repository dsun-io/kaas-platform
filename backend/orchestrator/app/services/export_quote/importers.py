"""表格导入：把上传的规格表解析成可报价的规格行。

设计要点
--------
**为什么需要它**：报价时逐个输入参数太慢。客户常直接甩来一张表
（或我们自己导出的报价表要改汇率重算），需要一次性批量算完。

**核心能力：认得出我们自己导出的表**。导出文件的表头是
`网高(m)` / `竖丝间距(cm)` / `丝径方案` / `镀锌量` / `工艺`，
本模块的表头别名表覆盖中文、英文与内部字段名三种写法，
所以「上传上次导出的 xlsx → 一键重算」是开箱可用的。

**单位随表头走，不靠猜**：
  表头写 `竖丝间距(cm)` → 值 10 当作 10cm（×10 转成内部 mm）
  表头写 `mesh_mm`       → 值 100 当作 100mm
  表头写 `竖丝间距`（无单位）→ 按业务惯例当 cm
把单位认错会整批算错，所以这里不采用「数字多大就猜什么单位」的做法。

**容错策略**：坏行**不拖垮整批**。能认的行照常算，认不了的行连
「第几行 / 哪一列 / 什么值 / 期望什么」一起回报，用户改完再传一次。
"""
from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Iterable, Mapping

from .models import ProductSpec
from .numeric import dec

MAX_ROWS = 2000
MAX_BYTES = 2 * 1024 * 1024  # 2 MB

# 表头 → (目标字段, 当表头带这个单位时如何换算)
# 目标字段与引擎 spec_rows 接受的键一致。
#   height -> height_m（米）
#   mesh   -> mesh_mm（毫米）
# 单位换算写成「表头单位 → 内部单位」的因子。
_ALIASES: tuple[tuple[str, str, dict[str, Any]], ...] = (
    # 网高
    ("height_m", "height", {"unit": "m", "factor": {"m": 1, "cm": Decimal("0.01"),
                                                    "mm": Decimal("0.001")}}),
    ("netheight", "height", {"unit": "m", "factor": {"m": 1}}),
    ("height", "height", {"unit": "m", "factor": {"m": 1}}),
    ("网高", "height", {"unit": "m", "factor": {"m": 1, "cm": Decimal("0.01"),
                                                "mm": Decimal("0.001")}}),
    ("高度", "height", {"unit": "m", "factor": {"m": 1, "cm": Decimal("0.01"),
                                                "mm": Decimal("0.001")}}),
    ("net height", "height", {"unit": "m", "factor": {"m": 1}}),

    # 竖丝间距（内部按 mm 计）
    ("mesh_mm", "mesh", {"unit": "mm", "factor": {"mm": 1}}),
    ("mesh_cm", "mesh", {"unit": "cm", "factor": {"cm": 10}}),
    ("mesh", "mesh", {"unit": "cm", "factor": {"cm": 10, "mm": 1}}),
    ("vertical wire spacing", "mesh", {"unit": "cm", "factor": {"cm": 10, "mm": 1}}),
    ("竖丝间距", "mesh", {"unit": "cm", "factor": {"cm": 10, "mm": 1}}),
    ("网孔", "mesh", {"unit": "cm", "factor": {"cm": 10, "mm": 1}}),
    ("meshspacing", "mesh", {"unit": "cm", "factor": {"cm": 10}}),

    # 卷长
    ("roll_len_m", "roll_len_m", {"unit": "m", "factor": {"m": 1}}),
    ("rolllength", "roll_len_m", {"unit": "m", "factor": {"m": 1}}),
    ("roll length", "roll_len_m", {"unit": "m", "factor": {"m": 1}}),
    ("卷长", "roll_len_m", {"unit": "m", "factor": {"m": 1}}),
    ("每卷长度", "roll_len_m", {"unit": "m", "factor": {"m": 1}}),

    # 卷径
    ("roll_dia_m", "roll_dia_m", {"unit": "m", "factor": {"m": 1}}),
    ("roll_dia_cm", "roll_dia_m", {"unit": "cm", "factor": {"cm": Decimal("0.01")}}),
    ("roldiameter", "roll_dia_m", {"unit": "cm", "factor": {"cm": Decimal("0.01")}}),
    ("roll diameter", "roll_dia_m", {"unit": "cm", "factor": {"cm": Decimal("0.01")}}),
    ("卷径", "roll_dia_m", {"unit": "cm", "factor": {"cm": Decimal("0.01")}}),

    # 三个丝径（允许逐项覆盖，一般由丝径方案带出）
    ("edge_wire_diameter", "de", {"unit": "mm", "factor": {"mm": 1}}),
    ("边丝径", "de", {"unit": "mm", "factor": {"mm": 1}}),
    ("inner_wire_diameter", "dm", {"unit": "mm", "factor": {"mm": 1}}),
    ("内横丝径", "dm", {"unit": "mm", "factor": {"mm": 1}}),
    ("vertical_wire_diameter", "dv", {"unit": "mm", "factor": {"mm": 1}}),
    ("竖丝径", "dv", {"unit": "mm", "factor": {"mm": 1}}),
)

# 变体包：表头别名 → 包名 + 取值别名（值写法 → 选项 name）
_VARIANT_ALIASES = {
    "wire": ("丝径方案", "丝径", "wire", "wire diameter option", "wireoption",
             "wireoption", "wire_option", "网片丝径"),
    "coating": ("表面处理", "镀锌量", "镀锌", "锌层", "coating", "zinc", "zinc coating",
                "zinccoating", "zinc_coating", "surface treatment", "surfacetreatment",
                "surface_treatment"),
    "wave": ("工艺", "波型", "波弯", "wave", "wave type", "wavetype", "wave_type",
             "wave bend", "wavebend"),
}

# 取值别名：把常见写法收敛到产品里声明的选项名。
# 产品里有时会用中文名，这里补上英文/代号/简写。
_VALUE_ALIASES: dict[str, str] = {
    # 丝径方案
    "all wires 2.0": "全丝2.0",
    "all_wire_20": "全丝2.0",
    "2.0x2.0": "全丝2.0",
    "全丝2.0mm": "全丝2.0",
    "all wires 2.5": "全丝2.5",
    "all_wire_25": "全丝2.5",
    "2.5x2.5": "全丝2.5",
    "edge 2.5 + inner 2.0": "边丝2.5+内丝2.0",
    "edge25_inner20": "边丝2.5+内丝2.0",
    "2.5x2.0": "边丝2.5+内丝2.0",
    "边丝2.5内丝2.0": "边丝2.5+内丝2.0",
    # 镀锌量
    "zinc_40": "普锌40g/㎡",
    "40": "普锌40g/㎡",
    "普锌": "普锌40g/㎡",
    "普锌40": "普锌40g/㎡",
    "economical 40 g/m²": "普锌40g/㎡",
    "zinc_200": "重镀锌≥200g/㎡",
    "200": "重镀锌≥200g/㎡",
    "重镀锌": "重镀锌≥200g/㎡",
    "重镀锌200g/㎡": "重镀锌≥200g/㎡",
    "heavier hot-dip ≥200 g/m²": "重镀锌≥200g/㎡",
    # 工艺
    "no_wave": "无波款",
    "0": "无波款",
    "无波": "无波款",
    "without wave bend": "无波款",
    "wave_bend": "波弯款",
    "1": "波弯款",
    "波弯": "波弯款",
    "with wave bend": "波弯款",
}


class ImportError_(ValueError):
    """表格导入失败（整表级）。"""


@dataclass
class Issue:
    """一行一处的问题。row 从 1 开始（指数据行，不含表头）。"""

    row: int
    column: str
    value: Any
    message: str
    severity: str = "error"  # error | warning

    def to_dict(self) -> dict:
        return {
            "row": self.row,
            "column": self.column,
            "value": None if self.value is None else str(self.value),
            "message": self.message,
            "severity": self.severity,
        }


@dataclass
class ParsedTable:
    """解析结果：可用的规格行 + 识别到的列映射 + 问题清单。"""

    rows: list[dict] = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)
    mapping: dict[str, str] = field(default_factory=dict)  # 表头 → 目标字段
    ignored_columns: list[str] = field(default_factory=list)
    total_data_rows: int = 0
    source_name: str = ""

    @property
    def ok(self) -> bool:
        return bool(self.rows)

    @property
    def errors(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == "error"]

    @property
    def warnings(self) -> list[Issue]:
        return [i for i in self.issues if i.severity != "error"]

    def to_dict(self) -> dict:
        return {
            "source_name": self.source_name,
            "total_data_rows": self.total_data_rows,
            "usable_rows": len(self.rows),
            "error_count": len(self.errors),
            "warning_count": len(self.warnings),
            "mapping": self.mapping,
            "ignored_columns": self.ignored_columns,
            "issues": [i.to_dict() for i in self.issues],
            "rows": self.rows,
        }


# ─────────────────────────────────────────────────────────────────────────────
# 单元格解析
# ─────────────────────────────────────────────────────────────────────────────
_TRAILING_PARENS = re.compile(r"[（(]\s*([^（()）]{1,24}?)\s*[)）]\s*$")


def _norm_header(raw: Any) -> tuple[str, str]:
    """把表头拆成（基名, 单位），都小写去空白。

    `竖丝间距(cm)` → ("竖丝间距", "cm")
    `Net Height (m)` → ("net height", "m")
    `卷长(m/卷)`   → ("卷长", "m")      ← 括号里带中文量词的也要认
    `mesh_mm`      → ("mesh_mm", "")
    """
    s = str(raw or "").strip()
    unit = ""
    m = _TRAILING_PARENS.search(s)
    if m:
        inner = m.group(1).strip()
        # `m/卷` / `USD/卷` 只取斜杠前的计量单位
        cand = inner.split("/")[0].strip()
        cand = cand.replace("³", "3").replace("²", "2").lower()
        # 纯中文量词（如 `根`）不是可换算单位，但仍要连同括号一起去掉，
        # 否则 `横丝数(根)` 这种表头会因为多了括号而认不出来
        unit = cand if re.fullmatch(r"[a-z0-9µμ]+", cand or "") else ""
        s = s[: m.start()].strip()
    # 归一：小写、去掉下划线/空格/中点等，便于匹配
    compact = re.sub(r"[\s_\-·.]", "", s).lower()
    return compact, unit


def _resolve_role(product: ProductSpec, role: str) -> str | None:
    """把语义角色（height/mesh）解析成产品**真实的规格轴名**。

    导入器不该假设轴叫什么：牛栏网叫 `height_m` / `mesh_mm`，
    换个产品可能叫别的。所以别名表只负责认出「这是网高」，
    再由产品定义决定它落在哪个键上。
    """
    axis_names = [ax.name for ax in product.axes]
    if role in axis_names:
        return role
    exact = {
        "height": ("height_m", "height", "net_height_m"),
        "mesh": ("mesh_mm", "mesh_cm", "mesh_width_mm", "mesh"),
    }.get(role, ())
    for candidate in exact:
        if candidate in axis_names:
            return candidate
    # 退一步：按前缀猜（height_m / height_cm 都算网高）
    for name in axis_names:
        if name.lower().startswith(role.lower()):
            return name
    return None


def _build_header_map(product: ProductSpec) -> tuple[dict, dict, dict, set]:
    """构造 表头基名 → 目标字段 的查找表。

    返回 (scalar, variant, numeric, variant_codes)。
    """
    scalar: dict[str, tuple[str, dict]] = {}
    for alias, target, meta in _ALIASES:
        compact = re.sub(r"[\s_\-·.]", "", alias).lower()
        scalar.setdefault(compact, (target, meta))

    # 自由数值参数：按「标签 / 英文名 / key」认。
    # 必须**先于**语义别名（_ALIASES）判定 —— 因为 height_m / mesh_mm 现在
    # 本身就是自由数值参数，而 _ALIASES 里的「网高 / 竖丝间距」会把它们
    # 解析成语义角色（height / mesh），角色只在 axes 里找得到，
    # 于是表头认不出来 → 整表导入失败。
    numeric: dict[str, str] = {}
    for ni in product.numeric_inputs:
        for alias in (ni.label, ni.label_en, ni.key):
            if not alias:
                continue
            # 两种写法都要登记：完整标签（「丝径(mm)」）与**去掉单位后的基名**
            # （「丝径」）—— 表头解析会先把单位拆出来（_norm_header），
            # 只登记带单位的那种就会认不出模板自己写出去的列名。
            for form in (str(alias), _norm_header(alias)[0]):
                compact = re.sub(r"[\s_\-·.]", "", str(form)).lower()
                if compact:
                    numeric.setdefault(compact, ni.key)

    variant: dict[str, str] = {}
    for group, aliases in _VARIANT_ALIASES.items():
        # 只有产品真的声明了这个变体包才认
        if not any(v.name == group for v in product.variants):
            continue
        for alias in aliases:
            compact = re.sub(r"[\s_\-·.]", "", alias).lower()
            variant.setdefault(compact, group)

    # 产品变体包自身的名字与标签也认（wire / 丝径方案）。
    # 注意只在该键尚未被 _VARIANT_ALIASES 认领时才登记 ——
    # 否则「镀锌量」这种输出列标签（spec.coating，锌层克数）会与变体包
    # 的 label（表面处理）指向同一个包，导致「表面处理」列被误判为可填参数。
    for v in product.variants:
        for alias in (v.name, v.label, v.label_en):
            if alias:
                compact = re.sub(r"[\s_\-·.]", "", str(alias)).lower()
                if compact in variant:
                    continue
                variant.setdefault(compact, v.name)

    # 变体包 label 的**前缀**也认（如「表面处理」导出为「表面处理」，
    # 但值列可能写「热镀锌」而非完整选项名 —— 值级模糊匹配由 _coerce_variant 负责，
    # 这里只负责把「表头」映射到包）。
    # 已在上面按完整 label 登记，无需额外处理。

    known_variant_codes = set()
    for v in product.variants:
        known_variant_codes.add(f"{v.name}_code")

    return scalar, variant, numeric, known_variant_codes


def _resolve_column(
    product: ProductSpec,
    raw_header: Any,
    maps: tuple[dict, dict, set] | None = None,
) -> tuple[str, str, dict, str] | None:
    """表头 → (类别, 目标, 别名元数据, 实际单位)；认不出来返回 None。

    **解析与模板生成共用这一处**，所以「上传时能认的表头」与
    「模板里写出去的表头」永远是同一套，不会各改各的而对不上。
    """
    scalar_map, variant_map, numeric_map, _codes = maps or _build_header_map(product)
    base, unit = _norm_header(raw_header)
    if base in variant_map:
        return "variant", variant_map[base], {}, ""
    if base in numeric_map:
        # 自由数值：不做枚举校验（取值连续），单位换算交给调用方按 ui_scale 处理。
        key = numeric_map[base]
        ni = next(n for n in product.numeric_inputs if n.key == key)
        return "numeric", key, {}, (unit or ni.ui_unit or ni.unit)
    if base in scalar_map:
        target, meta = scalar_map[base]
        # 语义角色 → 产品真实轴名（height → height_m / mesh → mesh_mm）
        target = _resolve_role(product, target) or target
        return "scalar", target, meta, (unit or meta.get("unit", ""))
    return None


def _unit_factor(meta: Mapping[str, Any], unit: str) -> Decimal:
    """表头单位 → 内部单位的换算因子；没有就按 1（不换算）。"""
    factor = (meta or {}).get("factor") or {}
    if unit in factor:
        return Decimal(str(factor[unit]))
    return Decimal(1)


def _numeric_factor(ni, unit: str) -> Decimal:
    """自由数值列：表头单位 → **引擎内部单位**的换算因子。

    界面值 = 引擎值 × ui_scale（卷径 0.30m 显示成 30 公分），
    所以表头写界面单位时要**除以** ui_scale；写引擎单位时因子为 1。
    """
    ui_unit = ni.ui_unit or ni.unit
    scale = ni.ui_scale or 1
    if unit and ui_unit and unit == ui_unit and scale != 1:
        return Decimal(1) / Decimal(str(scale))
    return Decimal(1)


def _to_decimal(value: Any) -> Decimal:
    s = str(value).strip()
    m = re.match(r"^([+-]?\d+(?:\.\d+)?)", s)
    if not m:
        raise ValueError("不是数字: %r" % value)
    return dec(m.group(1))


def _coerce_variant(product: ProductSpec, group: str, value: Any) -> str:
    """把单元格值收敛到变体包的选项名。"""
    raw = str(value).strip()
    if not raw:
        raise ValueError("空值")

    vg = next(v for v in product.variants if v.name == group)
    # 1) 直接就是选项名 / 英文名 / code
    for opt in vg.options:
        if raw == str(opt.get("name")) or raw == str(opt.get("name_en")):
            return str(opt.get("name"))
        if _loose_str_eq(opt.get("code"), raw):
            return str(opt.get("name"))
    # 2) 走别名表
    alias = _VALUE_ALIASES.get(raw) or _VALUE_ALIASES.get(raw.lower())
    if alias:
        for opt in vg.options:
            if str(opt.get("name")) == alias:
                return alias
    # 3) 去掉单位/空白再试一次
    squeeze = re.sub(r"[\s]", "", raw)
    for opt in vg.options:
        if squeeze == re.sub(r"[\s]", "", str(opt.get("name"))):
            return str(opt.get("name"))
    # 4) 前缀/包含匹配（如导出列写「热镀锌」而完整选项是「热镀锌 40g/㎡」）
    #    只在唯一命中时才认，避免「热镀锌」同时匹配 40/200/260 三档而静默选错。
    candidates = [
        str(opt.get("name"))
        for opt in vg.options
        if str(opt.get("name")).startswith(raw) or raw.startswith(str(opt.get("name")))
    ]
    if len(candidates) == 1:
        return candidates[0]
    if candidates:
        raise ValueError(
            f"取值 {raw!r} 匹配到多个选项: {candidates}；请写完整选项名"
        )
    raise ValueError(
        f"无法识别的取值 {raw!r}；可选: "
        + ", ".join(str(o.get("name")) for o in vg.options)
    )


def _loose_str_eq(a, b) -> bool:
    if a is None or b is None:
        return False
    return str(a).strip().lower() == str(b).strip().lower()


# ─────────────────────────────────────────────────────────────────────────────
# 读表
# ─────────────────────────────────────────────────────────────────────────────
def _read_csv(data: bytes) -> list[list[Any]]:
    for enc in ("utf-8-sig", "utf-8", "gb18030", "cp936"):
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ImportError_("无法识别 CSV 编码，请另存为 UTF-8")
    # 嗅探分隔符（逗号 / 制表符 / 分号）
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;")
    except csv.Error:
        dialect = csv.excel
    return [list(r) for r in csv.reader(io.StringIO(text), dialect)]


def _read_xlsx(data: bytes, sheet: str | None = None) -> list[list[Any]]:
    try:
        from openpyxl import load_workbook
    except ImportError as exc:  # pragma: no cover - 依赖已在 pyproject 声明
        raise ImportError_("缺少 openpyxl，无法读取 xlsx") from exc
    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        ws = wb[sheet] if sheet and sheet in wb.sheetnames else wb[wb.sheetnames[0]]
        return [list(r) for r in ws.iter_rows(values_only=True)]
    finally:
        wb.close()


def read_table(data: bytes, filename: str = "", sheet: str | None = None) -> list[list[Any]]:
    if len(data) > MAX_BYTES:
        raise ImportError_(
            "文件过大（%.1f MB），上限 %d MB" % (len(data) / 1048576, MAX_BYTES // 1048576)
        )
    name = (filename or "").lower()
    if name.endswith(".xlsx") or name.endswith(".xlsm"):
        return _read_xlsx(data, sheet)
    if name.endswith(".xls"):
        raise ImportError_("不支持老的 .xls 格式，请另存为 .xlsx 或 .csv")
    if name.endswith(".csv") or name.endswith(".txt"):
        return _read_csv(data)
    # 没给后缀：先按 xlsx 的魔数试探，再退回 CSV
    if data[:2] == b"PK":
        return _read_xlsx(data, sheet)
    return _read_csv(data)


# ─────────────────────────────────────────────────────────────────────────────
# 解析成规格行
# ─────────────────────────────────────────────────────────────────────────────
def parse_table(
    data: bytes,
    product: ProductSpec,
    filename: str = "",
    sheet: str | None = None,
) -> ParsedTable:
    """把上传的表格解析成 `spec_rows`（可直接喂给引擎）。"""
    grid = read_table(data, filename, sheet)
    out = ParsedTable(source_name=filename or "")
    if not grid:
        raise ImportError_("表格是空的")

    header_row = grid[0]
    if len(grid) > MAX_ROWS + 1:
        raise ImportError_(
            "数据行 %d 超过上限 %d 行，请拆分后再传" % (len(grid) - 1, MAX_ROWS)
        )

    scalar_map, variant_map, numeric_map, _codes = _build_header_map(product)
    maps = (scalar_map, variant_map, numeric_map, _codes)

    # 列映射
    col_target: dict[int, tuple[str, str, dict]] = {}
    for idx, raw in enumerate(header_row):
        if raw is None or not str(raw).strip():
            continue
        resolved = _resolve_column(product, raw, maps)
        if resolved is None:
            out.ignored_columns.append(str(raw))
            continue
        kind, target, meta, unit = resolved
        if kind == "variant":
            col_target[idx] = ("variant", target, {})
        elif kind == "numeric":
            ni = next(n for n in product.numeric_inputs if n.key == target)
            col_target[idx] = ("numeric", target, {
                "unit": unit,
                "factor": {unit: str(_numeric_factor(ni, unit))},
            })
        else:
            col_target[idx] = ("scalar", target, {"unit": unit,
                                                  "factor": meta["factor"]})
        out.mapping[str(raw)] = target

    if not col_target:
        raise ImportError_(
            "没有识别到任何规格列。表头需包含：%s 等（中英文均可，"
            "建议直接用系统下载的模板）"
            % "、".join(c.header for c in template_columns(product)[:4])
        )
    # 缺哪些必需列早点说清楚
    have_variants = {t for kind, t, _ in col_target.values() if kind == "variant"}
    for v in product.variants:
        if v.name not in have_variants:
            out.issues.append(Issue(
                0, v.label or v.name, None,
                "表里没有「%s」列，该规格无法确定" % (v.label or v.name),
            ))

    # 逐行解析
    consumed_any = False
    for r_i, raw_row in enumerate(grid[1:], start=1):
        if raw_row is None or all(
            c is None or str(c).strip() == "" for c in raw_row
        ):
            continue  # 跳过空行
        consumed_any = True
        out.total_data_rows += 1
        spec: dict[str, Any] = {}
        row_bad = False

        for idx, (kind, target, meta) in col_target.items():
            value = raw_row[idx] if idx < len(raw_row) else None
            if value is None or str(value).strip() == "":
                continue  # 允许留空：变体包可从其它列推、覆盖项本就可选
            try:
                if kind == "variant":
                    spec[target] = _coerce_variant(product, target, value)
                else:
                    num = _to_decimal(value)
                    unit = meta.get("unit")
                    factor = meta.get("factor") or {}
                    if unit and unit in factor:
                        num = num * Decimal(str(factor[unit]))
                    spec[target] = num
            except ValueError as exc:
                row_bad = True
                out.issues.append(Issue(
                    r_i, str(header_row[idx]), value, str(exc)
                ))

        if row_bad:
            continue
        if not spec:
            continue
        out.rows.append(spec)

    if not consumed_any:
        raise ImportError_("表格里没有数据行")
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 模板
# ─────────────────────────────────────────────────────────────────────────────
# 模板不是另写一套表头，而是**从产品声明里反推**：
# 拿产品自己的输出列（也就是导出报价表用的那些列名）逐列去问解析器
# 「这个表头你认得吗」，认得就写进模板。因此
#   模板表头 ≡ 导出文件表头 ≡ 解析器认得的表头
# 三边永远一致；将来产品加列或改列名，模板和解析一起跟着走，不会漏改一处。
@dataclass
class TemplateColumn:
    """模板里的一列。"""

    header: str          # 写进模板的表头（与导出文件一致）
    kind: str            # variant | scalar
    target: str          # 变体包名 或 目标字段名
    required: bool
    unit: str = ""
    options: list[str] = field(default_factory=list)  # 可选值（含单位换算后的显示值）
    factor: Decimal = Decimal(1)  # 表头单位 → 内部单位
    note: str = ""

    def to_dict(self) -> dict:
        return {
            "header": self.header,
            "kind": self.kind,
            "target": self.target,
            "required": self.required,
            "unit": self.unit,
            "options": list(self.options),
            "note": self.note,
        }


def _display_value(value: Any, factor: Decimal) -> Any:
    """把内部单位的值换算成表头单位下的显示值（100mm → 表头写 cm 时显示 10）。"""
    if factor == 1:
        return value
    try:
        q = dec(str(value)) / factor
    except Exception:  # pragma: no cover - 非数值轴不换算
        return value
    q = q.normalize()
    if q == q.to_integral_value():
        return int(q)
    return float(q)


def template_columns(product: ProductSpec) -> list[TemplateColumn]:
    """一份产品的可填参数列 —— 也就是「模板该有哪些列」。

    顺序沿用产品输出列的顺序，所以模板与导出的报价表长得一样，
    「导出 → 改 → 再导入」不用另对照列名。
    """
    maps = _build_header_map(product)
    out: list[TemplateColumn] = []
    seen: set[str] = set()

    def add(header: str, resolved) -> None:
        kind, target, meta, unit = resolved
        if kind == "variant":
            vg = next(v for v in product.variants if v.name == target)
            out.append(TemplateColumn(
                header, "variant", target, True, "",
                [str(o.get("name")) for o in vg.options],
                Decimal(1), vg.label or vg.name,
            ))
        elif kind == "numeric":
            ni = next(n for n in product.numeric_inputs if n.key == target)
            out.append(TemplateColumn(
                header, "numeric", target, False, unit,
                [], _numeric_factor(ni, unit),
                ni.note or f"自由数值（{ni.unit}）；留空则用默认值",
            ))
        else:
            factor = _unit_factor(meta, unit)
            is_axis = any(ax.name == target for ax in product.axes)
            note = ""
            if is_axis:
                ax = next(a for a in product.axes if a.name == target)
                note = "可选值: " + " / ".join(
                    str(_display_value(o, factor)) for o in ax.options
                )
            else:
                note = "可留空：默认按丝径方案自动带出，只有需要覆盖时才填"
            out.append(TemplateColumn(
                header, "scalar", target, is_axis, unit,
                ([] if not is_axis else [
                    str(_display_value(o, factor))
                    for o in next(a for a in product.axes if a.name == target).options
                ]),
                factor, note,
            ))
        seen.add(target)

    # 1) 走过产品自己的输出列（= 导出报价表的列）
    for col in product.columns:
        if getattr(col, "internal", False):
            continue
        header = getattr(col, "label", "") or ""
        if not header:
            continue
        resolved = _resolve_column(product, header, maps)
        if resolved is None:
            continue  # 计算列/描述列：不是可填参数，不进模板（填了也会被忽略）
        if resolved[1] in seen:
            continue
        add(header, resolved)

    # 2) 兜底：产品声明了、但输出列里没有的参数（例如某产品没给它配输出列），
    #    仍要出现在模板里，否则该规格无从填写、整表都算不了。
    for ax in product.axes:
        if ax.name in seen:
            continue
        for candidate in (ax.label, ax.name):
            if not candidate:
                continue
            resolved = _resolve_column(product, candidate, maps)
            if resolved is not None and resolved[1] == ax.name:
                add(candidate, resolved)
                break
    for vg in product.variants:
        if vg.name in seen:
            continue
        for candidate in (vg.label, vg.name):
            if not candidate:
                continue
            resolved = _resolve_column(product, candidate, maps)
            if resolved is not None and resolved[1] == vg.name:
                add(candidate, resolved)
                break

    # 3) 自由数值参数：产品没给它配输出列时，模板里也必须有这一列，
    #    否则该尺寸无从填写（它不进规格轴，靠第 2 步的轴兜底捞不到）。
    for ni in product.numeric_inputs:
        if ni.key in seen:
            continue
        for candidate in (ni.label, ni.label_en, ni.key):
            if not candidate:
                continue
            resolved = _resolve_column(product, candidate, maps)
            if resolved is not None and resolved[1] == ni.key:
                add(candidate, resolved)
                break

    return out


def template_headers(product: ProductSpec) -> list[str]:
    """模板表头 —— 与导出文件的列名一致，保证「导出→改→再导入」闭环。"""
    return [c.header for c in template_columns(product)]


def _example_rows(product: ProductSpec, columns: list[TemplateColumn],
                  examples: int) -> list[list[Any]]:
    """示例行：必需参数取真实可选值轮换，可选覆盖项留空（留空就是按方案默认）。

    规格轴写**数字**而不是数字字符串：Excel 里数字串会被当文本，
    既是「绿三角」告警，也会让用户后续公式/排序出错。
    """
    required = [c for c in columns if c.required and c.options]
    if not required or examples <= 0:
        return []
    rows = []
    for i in range(examples):
        row = []
        for c in columns:
            if not c.required:
                row.append("")
                continue
            value: Any = c.options[i % len(c.options)]
            if c.kind in ("scalar", "numeric"):
                value = _as_number(value)
            row.append(value)
        rows.append(row)
    return rows


def _as_number(value: str) -> Any:
    """数字字符串回转成数值；不是数字就原样返回。"""
    s = str(value).strip()
    if not re.fullmatch(r"[+-]?\d+(\.\d+)?", s):
        return value
    q = dec(s).normalize()
    if q == q.to_integral_value():
        return int(q)
    return float(q)


def build_template_csv(product: ProductSpec, examples: int = 3) -> str:
    """生成可直接填写的 CSV 模板。"""
    cols = template_columns(product)
    lines = [",".join(c.header for c in cols)]
    for row in _example_rows(product, cols, examples):
        lines.append(",".join("" if v is None else str(v) for v in row))
    return "\n".join(lines) + "\n"


# xlsx 下拉框：内联候选串超过这个长度就改用隐藏工作表 + 区域引用
_INLINE_DV_MAX = 240


def _si_column_width(header: str, values: Iterable[Any] = ()) -> float:
    """中文按 2 个字符宽估算，够用即可。"""
    def width(v: Any) -> int:
        s = str(v or "")
        return sum(2 if ord(ch) > 0x2E80 else 1 for ch in s)

    n = max([width(header)] + [width(v) for v in values])
    return min(40.0, max(9.0, n + 3))


def _add_dropdown(ws, column: int, options: list[str], rows: int,
                  lists_ws, lists_col: int) -> None:
    """给一列加 Excel 下拉校验，让用户从可选值里挑，避免手打出错。"""
    from openpyxl.worksheet.datavalidation import DataValidation

    inline = ",".join(options)
    if len(inline) <= _INLINE_DV_MAX:
        formula = '"%s"' % inline
    else:
        # 候选太长：写到隐藏工作表，用区域引用
        for i, opt in enumerate(options, start=2):
            lists_ws.cell(row=i, column=lists_col, value=opt)
        col_letter = lists_ws.cell(row=1, column=lists_col).column_letter
        formula = "=%s!$%s$2:$%s$%d" % (
            lists_ws.title, col_letter, col_letter, len(options) + 1)

    dv = DataValidation(type="list", formula1=formula, allow_blank=True,
                        showDropDown=False)
    # 只做引导，不硬拦：我们接受别名与简写（「普锌」=「普锌40g/㎡」），
    # 硬拦会把这些合法写法也挡在外面，反而逼用户来问为什么填不进去。
    # 取值对不对统一由导入器判定 —— 报错会点明第几行哪一列什么值。
    dv.showErrorMessage = False
    dv.promptTitle = "可选值"
    dv.prompt = "建议从下拉里选；用系统认得的别名/简写也能通过校验。"
    dv.showInputMessage = True
    ws.add_data_validation(dv)
    dv.add("%s2:%s%d" % (ws.cell(row=1, column=column).column_letter,
                         ws.cell(row=1, column=column).column_letter,
                         max(rows, 2)))


def build_template_xlsx(product: ProductSpec, examples: int = 3,
                        example_rows: int = 60) -> bytes:
    """生成 Excel 模板（.xlsx）：规格表 + 示例 + 填写说明。

    为什么要有 Excel 版：这是业务真正在用的东西 —— 表头能加粗冻结、
    可选值做成下拉框、说明和表摆在一起。CSV 版保留给脚本化批量生成。
    """
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill
    except ImportError as exc:  # pragma: no cover - 依赖已在 pyproject 声明
        raise ImportError_("缺少 openpyxl，无法生成 xlsx 模板") from exc

    cols = template_columns(product)
    if not cols:
        raise ImportError_("产品「%s」没有可填的规格参数，无法生成模板" % product.name)

    wb = Workbook()

    # ── 工作表 1：规格表（解析器默认读第一个工作表，所以它必须排第一）──
    ws = wb.active
    ws.title = "规格表"
    head_font = Font(bold=True, color="FFFFFF")
    head_fill = PatternFill("solid", fgColor="4472C4")
    for j, c in enumerate(cols, start=1):
        cell = ws.cell(row=1, column=j, value=c.header)
        cell.font = head_font
        cell.fill = head_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")
        ws.column_dimensions[cell.column_letter].width = _si_column_width(
            c.header, c.options)
    ws.freeze_panes = "A2"

    lists_ws = None
    lists_col = 0
    for j, c in enumerate(cols, start=1):
        if not c.options:
            continue
        lists_col += 1
        if lists_ws is None:
            lists_ws = wb.create_sheet("lists")
            lists_ws.sheet_state = "hidden"
        _add_dropdown(ws, j, c.options, example_rows, lists_ws, lists_col)

    # ── 工作表 2：示例（可复制到「规格表」）──
    ws2 = wb.create_sheet("示例")
    for j, c in enumerate(cols, start=1):
        cell = ws2.cell(row=1, column=j, value=c.header)
        cell.font = Font(bold=True)
        ws2.column_dimensions[cell.column_letter].width = _si_column_width(
            c.header, c.options)
    rows = _example_rows(product, cols, max(examples, 0))
    if not rows:
        ws2.cell(row=2, column=1, value="（该产品没有带可选值的必需参数）")
    for i, row in enumerate(rows, start=2):
        for j, v in enumerate(row, start=1):
            ws2.cell(row=i, column=j, value=v)

    # ── 工作表 3：填写说明 ──
    ws3 = wb.create_sheet("填写说明")
    ws3.column_dimensions["A"].width = 22
    ws3.column_dimensions["B"].width = 12
    ws3.column_dimensions["C"].width = 10
    ws3.column_dimensions["D"].width = 78
    r = 1

    def line(a="", b="", c="", d="", bold=False) -> None:
        nonlocal r
        for j, v in enumerate((a, b, c, d), start=1):
            cell = ws3.cell(row=r, column=j, value=v)
            if bold:
                cell.font = Font(bold=True)
        r += 1

    line("产品", product.name, "", "key: %s" % product.key, bold=True)
    line("可上传的工作表", "「规格表」", "",
         "解析器只读第一个工作表；「示例」「填写说明」不会被上传计算")
    line("数据行上限", MAX_ROWS, "行", "超过请拆分成多个文件")
    line("文件大小上限", MAX_BYTES // 1048576, "MB", "支持 .xlsx 与 .csv；老式 .xls 请先另存为 .xlsx")
    r += 1

    line("列名", "必填", "单位", "填写说明", bold=True)
    for c in cols:
        line(c.header, "是" if c.required else "否", c.unit or "", c.note)
    r += 1

    line("单位规则", "", "",
         "列名括号里的就是该列的计量单位：「竖丝间距(cm)」填 10 表示 10cm，"
         "「网高(m)」填 1.2 表示 1.2m。按单位填原值即可，不要自己换算成别的单位。",
         bold=True)
    line("留空规则", "", "",
         "非必填列留空表示「按所选丝径方案自动带出」（如卷长、卷径、边丝径）；"
         "需要按实际装箱或来料调整时才填。")
    line("取值规则", "", "",
         "有下拉框的列请从下拉里选；大小写、空格、简写都会被尽量识别"
         "（如「普锌」=「普锌40g/㎡」），实在认不出会在导入结果里点名。")
    line("容错规则", "", "",
         "一行填错不影响其它行：可用的行照常报价，出错的行连同"
         "「第几行 / 哪一列 / 什么值 / 期望什么」一起回报，改完再传一次即可。")
    line("导出闭环", "", "",
         "本模板的列名与系统导出的报价表一致，导出的表格可以不改表头直接上传重算；"
         "导出表里的计算列（净重、体积、售价、税额…）会被忽略，只取规格参数重算。")
    line("换算口径", "", "",
         "长度用 m、竖丝间距用 cm（对外口径）、直径用 mm；"
         "重量与体积由系统按产品公式算出，不需要在表里填。")

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
