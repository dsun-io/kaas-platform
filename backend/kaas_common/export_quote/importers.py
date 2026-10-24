"""表格导入：把上传的规格表解析成可报价的规格行。

设计要点
--------
**为什么需要它**：报价时逐个输入参数太慢。客户常直接甩来一张表
（或我们自己导出的报价表要改汇率重算），需要一次性批量算完。

**核心能力：认得出我们自己导出的表**。导出文件的表头是
`网高(m)` / `竖丝间距(cm)` / `丝径方案` / `镀锌量` / `工艺`，
本模块的表头别名表覆盖中文、英文与内部字段名三种写法，
所以「上传上次导出的 xlsx → 一键重算」是开箱可用的。

**读表不依赖第三方库**（2026-10-21 C7）：xlsx 由 `.xlsx` 里的纯标准库读取器
（`zipfile` + `xml.etree`）负责，CSV 用 `csv`。两条路径读出来的都是
`list[list[str]]`，随后**共用同一份** `_build_header_map / _resolve_column / 行映射`
—— 不允许为 xlsx 另写一套字段判定（两套口径必然漂移）。
注意：`build_template_xlsx`（服务端生成 Excel 模板）仍然只在有 openpyxl 的
开发环境可用；线上 Worker 的模板由前端浏览器生成（`format=xlsx` 维持 501）。

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
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Mapping

from .models import ProductSpec
from .numeric import dec

MAX_ROWS = 2000
MAX_BYTES = 2 * 1024 * 1024  # 2 MB

# 老 .xls（OLE2 复合文档）的魔数：不是 zip+XML，读不了 ⇒ 明确指路另存为。
_OLE2_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

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
        key = numeric_map[base]
        ni = next(n for n in product.numeric_inputs if n.key == key)
        # 单位换算：沿用**语义别名表**（「竖丝间距(cm)」→ ×10）。
        # 尺寸类改成自由数值后就不走别名表了，少了这一步
        # 「10cm」会被当成 10mm —— **差十倍**（实测踩到过）。
        alias_meta = (scalar_map.get(base) or (None, {}))[1]
        # 表头不带单位时按**业务惯例单位**算（文档口径：「竖丝间距」无单位即 cm），
        # 而不是当成"没有单位、因子为 1" —— 后者会把 10cm 读成 10mm。
        eff_unit = (unit or (alias_meta or {}).get("unit") or ni.ui_unit
                    or ni.unit)
        factor = _numeric_factor(ni, eff_unit, alias_meta)
        return ("numeric", key, {"factor": {eff_unit: str(factor)}}, eff_unit)
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


def _numeric_factor(ni, unit: str, alias_meta: Mapping[str, Any] | None = None) -> Decimal:
    """自由数值列：表头单位 → **引擎内部单位**的换算因子。

    三档，按优先级：
      1. 产品**显式声明**的 `unit_factors`（新产品的正路，最明确）
      2. **语义别名表**的因子（既有业务惯例：「竖丝间距(cm)」填 10 就是 10cm）
      3. `ui_scale` 推断（界面值 = 引擎值 × ui_scale，故要除以它）
    """
    declared = ni.unit_factors or {}
    if unit and unit in declared:
        return Decimal(str(declared[unit]))
    factor = (alias_meta or {}).get("factor") or {}
    if unit and unit in factor:
        return Decimal(str(factor[unit]))
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


def _read_xlsx(
    data: bytes,
    sheet: str | None = None,
    warnings: list[str] | None = None,
) -> list[list[Any]]:
    """xlsx → 行列表。**纯标准库**（`zipfile` + `xml.etree`），见 `.xlsx` 模块说明。

    2026-10-21 C7：此前这里依赖 openpyxl，线上 Worker（Pyodide）装不进去，
    于是上传侧只能显式拒绝 xlsx。改成共享内核里的纯 stdlib 读取器后，
    CSV 与 .xlsx 走**同一个** `parse_table` 做字段映射，不会出现两套口径。
    """
    from .xlsx import read_xlsx

    return read_xlsx(data, sheet=sheet, warnings=warnings)


def _xlsx_sheet_name(data: bytes, sheet: str | None) -> str:
    """xlsx **实际会读取**的工作表名（与 `xlsx._pick_sheet` 同口径）。

    指定了表名且命中就用它；没命中时 xlsx 读取器会静默回落第一张表（并记 warning），
    这里也回落第一张 —— 免得响应里的 sheet 名与实际解析对象不一致。
    只解析 `xl/workbook.xml` 的 `<sheet name>`，不做关系解析：调用点已经成功读完整张表，
    这里只用于回显。任何异常都退回入参（显示用的名字不该把预览弄挂）。
    """
    import zipfile
    from xml.etree import ElementTree

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            blob = zf.read("xl/workbook.xml")
        root = ElementTree.fromstring(blob)
        names = [
            el.get("name") or ""
            for el in root.iter()
            if el.tag.rsplit("}", 1)[-1] == "sheet"
        ]
    except Exception:  # noqa: BLE001 - 仅回显用，读不出来就退回调用方给的名字
        return str(sheet or "")
    if not names:
        return str(sheet or "")
    if sheet:
        for name in names:
            if name == sheet:
                return name
        wanted = str(sheet).strip().lower()
        for name in names:
            if name.strip().lower() == wanted:
                return name
    return names[0]


def read_table(
    data: bytes,
    filename: str = "",
    sheet: str | None = None,
    *,
    warnings: list[str] | None = None,
    sheet_out: dict | None = None,
) -> list[list[Any]]:
    """上传文件 → 行列表（CSV / xlsx 共用同一份表头识别，见模块说明）。

    `sheet_out`（可选出参）：把**实际读取的工作表名**写进 `sheet_out["name"]`
    （CSV 记 `"CSV"`）。整单导入预览要把「实际读了哪张表」回报给用户，
    而 xlsx 读取器在表名不命中时会回落第一张，调用方无从得知 —— 所以由这里回填。
    """

    def _mark_read(sheet_name: str) -> None:
        if sheet_out is not None:
            sheet_out["name"] = sheet_name

    if len(data) > MAX_BYTES:
        raise ImportError_(
            "文件过大（%.1f MB），上限 %d MB" % (len(data) / 1048576, MAX_BYTES // 1048576)
        )
    name = (filename or "").lower()
    if name.endswith(".xlsx") or name.endswith(".xlsm"):
        rows = _read_xlsx(data, sheet, warnings)
        _mark_read(_xlsx_sheet_name(data, sheet))
        return rows
    if name.endswith(".xls"):
        raise ImportError_("不支持老的 .xls 格式，请另存为 .xlsx 或 .csv")
    if name.endswith(".csv") or name.endswith(".txt"):
        _mark_read("CSV")
        return _read_csv(data)
    # 没给后缀：先按 xlsx 的魔数（zip）试探；OLE2 是老的 .xls，指路另存为；
    # 其余一律按 CSV 处理（与旧行为一致）。
    if data[:2] == b"PK":
        rows = _read_xlsx(data, sheet, warnings)
        _mark_read(_xlsx_sheet_name(data, sheet))
        return rows
    if data[:8] == _OLE2_MAGIC:
        raise ImportError_("不支持老的 .xls 格式，请另存为 .xlsx 或 .csv")
    _mark_read("CSV")
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
    # xlsx 读取器可能带出"单元格格式无法解析、已按数值读取"这类提示（不抛异常）；
    # 收进 issues 的 warning 里，让预览页能和其它问题一起展示。
    xlsx_warnings: list[str] = []
    grid = read_table(data, filename, sheet, warnings=xlsx_warnings)
    out = ParsedTable(source_name=filename or "")
    for message in xlsx_warnings:
        out.issues.append(Issue(0, "", None, message, severity="warning"))
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
            col_target[idx] = ("numeric", target, {
                "unit": unit,
                "factor": meta["factor"],
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
    # 自由数值列的**示例值**（已换算成表头单位）。它不是必填，但示例行要写出来，
    # 否则用户不知道这一列该按什么量级、什么单位填。
    default: Any = None

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
    except (InvalidOperation, TypeError, ValueError, ZeroDivisionError):  # pragma: no cover - 非数值轴不换算
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
            factor = _unit_factor(meta, unit)
            out.append(TemplateColumn(
                header, "numeric", target, False, unit,
                [], factor,
                ni.note or f"自由数值（{ni.unit}）；留空则用默认值",
                (None if ni.default is None
                 else _display_value(ni.default, factor)),
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


# ─────────────────────────────────────────────────────────────────────────────
# 整单批量导入（R-D，2026-10-23）
# ─────────────────────────────────────────────────────────────────────────────
# 口径（用户弹窗拍板）：**单表 + 产品列**，一行 = 订单里的一个产品行；
# 规格列 = 所选产品 `template_columns` 的**并集**（某行只填它自己产品的列，其余留空）。
# 列名识别**完全复用**单产品那套（`_norm_header / _build_header_map / _resolve_column`）：
# 多产品不是另写一套表头别名，而是「先按产品列定位产品，再用该产品自己的列映射解析规格」。
#
# 与单产品 `parse_table` 的差异只有三点，且都是整单化本身带来的：
#   1. 多了 4 个公共列（件数 / 成本 / 成本口径 / 包装方式 / 本行利润率）；
#   2. 规格列按行产品的映射解析（不同产品的同名列可能落到不同字段）；
#   3. **坏行不丢**：解析结果行都返回（`row_errors` 非空 = 该行不可用），
#      这样前端能逐行显示「第几行为什么不能用」，而不是只看到一个总数。
#
# 本模块**不落库、不算价**：整单预览只做解析 + 行级校验，填工作台后走工作台既有算价链路。

#: 整单公共列（模板列顺序）。kind=common，不进产品规格并集。
ORDER_COMMON_HEADERS: tuple[str, ...] = (
    "产品",
    "件数（卷）",
    "成本",
    "成本口径（含税/不含税）",
    "包装方式",
    "本行利润率（%）",
)

#: 公共列表头别名（比较前先归一化：小写、去空白/下划线/连字符/中点）。
#: 带括号单位的表头会被 `_norm_header` 拆掉括号，所以这里登记的是**基名**。
_ORDER_COMMON_ALIASES: dict[str, str] = {
    # 产品
    "产品": "product", "产品名称": "product", "产品名": "product", "品名": "product",
    "产品编码": "product", "产品代码": "product", "产品key": "product", "sku": "product",
    "product": "product", "productkey": "product", "productname": "product",
    # 件数（卷）
    "件数": "pieces", "卷数": "pieces", "数量": "pieces", "件数卷": "pieces",
    "pieces": "pieces", "quantity": "pieces", "qty": "pieces",
    # 成本
    "成本": "cost", "成本价": "cost", "单卷成本": "cost", "成本单价": "cost",
    "cost": "cost", "unitcost": "cost", "costprice": "cost",
    # 成本口径（含税/不含税）
    "成本口径": "cost_basis", "价格口径": "cost_basis", "口径": "cost_basis",
    "成本是否含税": "cost_basis", "costbasis": "cost_basis", "taxbasis": "cost_basis",
    # 包装方式
    "包装方式": "packaging", "包装方法": "packaging", "包装方案": "packaging",
    "包装": "packaging", "packaging": "packaging", "packagingmethod": "packaging",
    # 本行利润率（%）
    "本行利润率": "profit_pct", "利润率": "profit_pct", "本行利润": "profit_pct",
    "profitpct": "profit_pct", "profitrate": "profit_pct", "profitmargin": "profit_pct",
}

#: 公共列 → 落点名（预览 `mapping` 的右侧文案）。
_ORDER_COMMON_MAPPING: dict[str, str] = {
    "product": "产品",
    "pieces": "件数",
    "cost": "成本",
    "cost_basis": "成本口径",
    "packaging": "包装方式",
    "profit_pct": "利润率",
}

#: 「成本口径」取值别名（归一化后比较）→ 引擎口径 pretax | incl_tax。
_ORDER_COST_BASIS: dict[str, str] = {
    "不含税": "pretax", "不含税价": "pretax", "不含税成本": "pretax",
    "税前": "pretax", "税前价": "pretax", "未税": "pretax", "未含税": "pretax",
    "pretax": "pretax", "excl": "pretax", "excltax": "pretax",
    "excludedtax": "pretax", "withouttax": "pretax",
    "含税": "incl_tax", "含税价": "incl_tax", "含税成本": "incl_tax", "已含税": "incl_tax",
    "incltax": "incl_tax", "incl": "incl_tax", "includedtax": "incl_tax",
    "withtax": "incl_tax",
}


@dataclass
class OrderTemplateColumn:
    """整单模板的一列：common（整单公共）或 spec（规格列，多产品并集）。"""

    header: str
    kind: str  # common | spec
    products: list[str] = field(default_factory=list)  # 适用产品名（spec 列才有意义）
    unit: str = ""
    options: list[str] = field(default_factory=list)
    note: str = ""

    def to_dict(self) -> dict:
        return {
            "header": self.header,
            "kind": self.kind,
            "products": list(self.products),
            "unit": self.unit,
            "options": list(self.options),
            "note": self.note,
        }


@dataclass
class OrderParsedTable:
    """整单解析结果：归一化的产品行 + 行级问题 + 列映射。

    `rows` 包含**所有非空数据行**（含不可用行）：不可用行的 `row_errors` 非空，
    前端据此逐行显示原因；`usable_rows` 才是「可直接填入工作台」的行数。
    """

    rows: list[dict] = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)
    mapping: dict[str, str] = field(default_factory=dict)
    ignored_columns: list[str] = field(default_factory=list)
    total_data_rows: int = 0
    source_name: str = ""
    sheet: str = ""
    expected_columns: list[str] = field(default_factory=list)
    products: list[dict] = field(default_factory=list)

    @property
    def errors(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == "error"]

    @property
    def warnings(self) -> list[Issue]:
        return [i for i in self.issues if i.severity != "error"]

    @property
    def usable_rows(self) -> int:
        return sum(1 for row in self.rows if not row.get("row_errors"))

    def to_dict(self) -> dict:
        return {
            "source_name": self.source_name,
            "sheet": self.sheet,
            "total_data_rows": self.total_data_rows,
            "usable_rows": self.usable_rows,
            "error_count": len(self.errors),
            "warning_count": len(self.warnings),
            "products": [dict(p) for p in self.products],
            "mapping": dict(self.mapping),
            "ignored_columns": list(self.ignored_columns),
            "issues": [i.to_dict() for i in self.issues],
            "rows": [
                dict(row, spec=dict(row["spec"]), row_errors=list(row["row_errors"]))
                for row in self.rows
            ],
            "expected_columns": list(self.expected_columns),
        }


def _order_compact(value: Any) -> str:
    text = "" if value is None else str(value)
    return re.sub(r"[\s_\-·.]", "", text).lower()


def _order_out_number(value: Decimal) -> Any:
    """Decimal → 契约里的 JSON number（整数值给 int，其余给 float）。"""
    if value == value.to_integral_value():
        return int(value)
    return float(value)


def _order_common_columns(specs: list[ProductSpec]) -> list[OrderTemplateColumn]:
    methods: list[str] = []
    for spec in specs:
        for item in (spec.packaging or []):
            if not isinstance(item, Mapping):
                continue
            method = str(item.get("method") or "").strip()
            if method and method not in methods:
                methods.append(method)
    return [
        OrderTemplateColumn(
            "产品", "common",
            note="必填。填产品中文名 / 任一英文名，或产品 key（不是规格列）"),
        OrderTemplateColumn(
            "件数（卷）", "common",
            note="必填。该行产品的件数（卷），必须大于 0"),
        OrderTemplateColumn(
            "成本", "common",
            note="必填。该行产品的单卷成本，口径见「成本口径」列"),
        OrderTemplateColumn(
            "成本口径（含税/不含税）", "common", options=["不含税", "含税"],
            note="可留空，默认「不含税」（pretax）"),
        OrderTemplateColumn(
            "包装方式", "common", options=methods,
            note="可留空 = 用产品默认包装；按产品 packaging[].method 匹配"),
        OrderTemplateColumn(
            "本行利润率（%）", "common",
            note="可留空 = 继承整单默认利润率"),
    ]


def order_template_columns(products: Iterable[ProductSpec]) -> list[OrderTemplateColumn]:
    """整单模板的列定义：6 个公共列 + 各产品模板列的**并集**（按首次出现排序）。

    并集规则：表头文字相同即视为同一列（同一套引擎表头，单位也一致）；
    `products` 记录该列适用于哪些产品（前端「填写说明」据此告诉用户哪行该填它）。
    """
    specs = [p for p in (products or []) if p is not None]
    cols = _order_common_columns(specs)
    by_header: dict[str, OrderTemplateColumn] = {}
    for spec in specs:
        product_name = spec.name or spec.key
        for col in template_columns(spec):
            existing = by_header.get(col.header)
            if existing is None:
                existing = OrderTemplateColumn(
                    header=col.header,
                    kind="spec",
                    products=[product_name],
                    unit=col.unit,
                    options=list(col.options),
                    note=col.note,
                )
                by_header[col.header] = existing
                cols.append(existing)
                continue
            if product_name not in existing.products:
                existing.products.append(product_name)
            for option in col.options:
                if option not in existing.options:
                    existing.options.append(option)
            if not existing.note and col.note:
                existing.note = col.note
    return cols


def order_template_headers(products: Iterable[ProductSpec]) -> list[str]:
    """整单模板表头 —— 与 `order_template_columns` 同序，可直接写进模板首行。"""
    return [c.header for c in order_template_columns(products)]


def _order_product_lookup(products: Iterable[ProductSpec]) -> dict[str, list[ProductSpec]]:
    """归一化 token（key / 名称 / **全部**英文名）→ 产品。同名多产品时由匹配时报"不唯一"。

    英文名不止一个（团队资料 `name_en_list` 去掉主名后经 Worker 写进
    `name_en_aliases`）：客户/业务填的是哪个写法，都要能认出同一个产品。
    归一化由 `_order_compact` 统一做（大小写 / 空格 / 下划线 / 连字符不敏感）。
    """
    lookup: dict[str, list[ProductSpec]] = {}
    for spec in products:
        seen: set[str] = set()
        tokens = [spec.key, spec.name, spec.name_en]
        tokens.extend(getattr(spec, "name_en_aliases", None) or [])
        for token in tokens:
            compact = _order_compact(token)
            if not compact or compact in seen:
                continue
            seen.add(compact)
            bucket = lookup.setdefault(compact, [])
            if all(spec.key != other.key for other in bucket):
                bucket.append(spec)
    return lookup


def _order_match_product(
    raw: Any,
    lookup: Mapping[str, list[ProductSpec]],
    available: str,
) -> tuple[ProductSpec | None, str | None]:
    """「产品」单元格 → 产品定义（key / 名称 / 全部英文名，大小写与空白不敏感）。"""
    text = str(raw or "").strip()
    if not text:
        return None, "缺少「产品」：请填产品名称或 key"
    hits = lookup.get(_order_compact(text)) or []
    if len(hits) == 1:
        return hits[0], None
    if hits:
        return None, "产品 %r 不唯一（匹配到 %s）；请改用产品 key" % (
            text, "、".join("%s(%s)" % (p.name or p.key, p.key) for p in hits))
    return None, "未识别的产品 %r；可选: %s" % (text, available)


def _order_check_bounds(ni: Any, value: Decimal, column: str, raw: Any,
                        add_error: Any) -> None:
    """自由数值列的上下界校验（与引擎 `_numeric_value` 同口径，提前到预览阶段）。"""
    try:
        low = None if ni.min_value is None else _to_decimal(ni.min_value)
        high = None if ni.max_value is None else _to_decimal(ni.max_value)
    except (InvalidOperation, TypeError, ValueError):
        return
    label = ni.label or ni.key
    if low is not None and value < low:
        add_error(column, raw, "「%s」=%s 小于下界 %s" % (label, value, ni.min_value))
    elif high is not None and value > high:
        add_error(column, raw, "「%s」=%s 大于上界 %s" % (label, value, ni.max_value))


def _order_known_targets(product: ProductSpec) -> set[str]:
    """产品能接受的规格字段集合（与引擎 `spec_from_partial` 的 known 同口径）。

    **为什么必须有这一步**：整单表的规格列是多个产品模板列的并集，
    同一个表头在别的产品下可能被 `_resolve_column` 认成一个该产品并不存在的字段
    （如「网高(m)」在勾花网里会退化成语义角色 `height`）。若不筛掉，
    用户把值填错列时预览看不出问题，到工作台算价才炸「无法识别的规格字段」——
    那正是预览端点要提前拦住的。所以「本产品不认识的落点」直接视为该产品不适用。
    """
    known = set(product.constants or {})
    known.update(ax.name for ax in product.axes)
    known.update(vg.name for vg in product.variants)
    known.update(ni.key for ni in product.numeric_inputs)
    for vg in product.variants:
        for opt in vg.options:
            known.update(k for k in opt if k not in ("name", "name_en", "code"))
        known.add(f"{vg.name}_code")
        known.add(f"{vg.name}_en")
    return known


def _parse_order_row(
    r_i: int,
    raw_row: list[Any],
    *,
    headers: Mapping[int, str],
    common_idx: Mapping[str, int],
    spec_columns: set[int],
    applicable_idx: Mapping[str, set[int]],
    product_targets: Mapping[str, Mapping[int, tuple[str, str, dict]]],
    lookup: Mapping[str, list[ProductSpec]],
    available: str,
) -> tuple[dict, list[Issue], ProductSpec | None]:
    """解析整单表的一行 → (归一化行, 本行 issues, 命中的产品定义)。

    单独成函数（不塞在 `parse_order_table` 的循环里）：行内错误要能"就地"记进
    `row_errors`，而循环级的闭包会让代码难读、也会踩 ruff B023（循环变量进闭包）。
    坏行不抛异常 —— 问题都变成 issues 返回，由调用方决定哪些行可用。
    """
    issues: list[Issue] = []
    row: dict[str, Any] = {
        "row": r_i,
        "product_key": "",
        "product_name": "",
        "spec": {},
        "pieces": 0,
        "cost": 0,
        "cost_basis": "pretax",
        "packaging_method": None,
        "packaging_id": None,
        "profit_pct": None,
        "row_errors": [],
    }
    row_errors: list[str] = row["row_errors"]
    spec_values: dict[str, Any] = row["spec"]

    def cell(slug: str) -> Any:
        idx = common_idx.get(slug)
        if idx is None:
            return None
        return raw_row[idx] if idx < len(raw_row) else None

    def column_of(slug: str, fallback: str) -> str:
        idx = common_idx.get(slug)
        return headers.get(idx, fallback) if idx is not None else fallback

    def add_error(column: str, value: Any, message: str) -> None:
        issues.append(Issue(r_i, column, value, message))
        row_errors.append(message)

    def read_required(slug: str, label: str) -> Decimal | None:
        raw = cell(slug)
        column = column_of(slug, label)
        if raw is None or str(raw).strip() == "":
            add_error(column, None, "缺少「%s」" % label)
            return None
        try:
            return _to_decimal(raw)
        except ValueError:
            add_error(column, raw, "「%s」不是数字: %r" % (label, raw))
            return None

    # 1) 产品（决定后面的规格列怎么解析）
    spec: ProductSpec | None = None
    raw_product = cell("product")
    if raw_product is None or str(raw_product).strip() == "":
        add_error(column_of("product", "产品"), None,
                  "缺少「产品」：请填产品名称或 key")
    else:
        spec, problem = _order_match_product(raw_product, lookup, available)
        if spec is None:
            add_error(column_of("product", "产品"), raw_product,
                      problem or "未识别的产品")
        else:
            row["product_key"] = spec.key
            row["product_name"] = spec.name

    # 2) 公共数值列
    pieces = read_required("pieces", "件数（卷）")
    if pieces is not None:
        if pieces <= 0:
            add_error(column_of("pieces", "件数（卷）"), cell("pieces"),
                      "「件数（卷）」必须大于 0")
        else:
            row["pieces"] = _order_out_number(pieces)

    cost = read_required("cost", "成本")
    if cost is not None:
        if cost < 0:
            add_error(column_of("cost", "成本"), cell("cost"), "「成本」不能为负")
        else:
            row["cost"] = _order_out_number(cost)

    raw_profit = cell("profit_pct")
    if raw_profit is not None and str(raw_profit).strip() != "":
        try:
            row["profit_pct"] = _order_out_number(_to_decimal(raw_profit))
        except ValueError:
            add_error(column_of("profit_pct", "本行利润率（%）"), raw_profit,
                      "「本行利润率（%）」不是数字: %r" % (raw_profit,))

    raw_basis = cell("cost_basis")
    if raw_basis is not None and str(raw_basis).strip() != "":
        basis = _ORDER_COST_BASIS.get(_order_compact(raw_basis))
        if basis is None:
            add_error(column_of("cost_basis", "成本口径（含税/不含税）"), raw_basis,
                      "「成本口径」只能是 含税 / 不含税（或 incl_tax / pretax）")
        else:
            row["cost_basis"] = basis

    # 3) 包装方式：按产品 packaging[].method 匹配 id（方法名原文回填供回显）
    raw_packaging = cell("packaging")
    if raw_packaging is not None and str(raw_packaging).strip() != "":
        method = str(raw_packaging).strip()
        row["packaging_method"] = method
        if spec is not None:
            matched = None
            for item in (spec.packaging or []):
                if (isinstance(item, Mapping)
                        and _loose_str_eq(item.get("method"), method)):
                    matched = item  # 多个同名 method：取第一个（与引擎 _pick_packaging 一致）
                    break
            if matched is not None:
                pid = matched.get("id")
                row["packaging_id"] = None if pid is None else str(pid)
            else:
                known = "、".join(
                    str(item.get("method") or item.get("name") or item.get("id"))
                    for item in (spec.packaging or [])
                    if isinstance(item, Mapping)
                )
                issues.append(Issue(
                    r_i, column_of("packaging", "包装方式"), method,
                    "产品「%s」没有 packaging[].method = %r 的包装方案%s；"
                    "将使用产品默认包装"
                    % (spec.name or spec.key, method,
                       ("（可选: %s）" % known) if known else "（该产品未配置包装）"),
                    severity="warning",
                ))

    # 4) 规格列：用**该行产品自己的**列映射解析
    if spec is not None:
        targets = product_targets.get(spec.key, {})
        for idx, (kind, target, meta) in targets.items():
            value = raw_row[idx] if idx < len(raw_row) else None
            if value is None or str(value).strip() == "":
                continue  # 允许留空：其它产品的列本行本来就该空
            column = headers.get(idx, target)
            try:
                if kind == "variant":
                    spec_values[target] = _coerce_variant(spec, target, value)
                else:
                    number = _to_decimal(value)
                    unit = meta.get("unit")
                    factor = meta.get("factor") or {}
                    if unit and unit in factor:
                        number = number * Decimal(str(factor[unit]))
                    if kind == "numeric":
                        ni = next(
                            (n for n in spec.numeric_inputs if n.key == target),
                            None,
                        )
                        if ni is not None:
                            _order_check_bounds(ni, number, column, value, add_error)
                    spec_values[target] = number
            except ValueError as exc:
                add_error(column, value, str(exc))

        # 有可选档位的变体包必须填（空档位包由定价数据补，引擎允许不填）
        for vg in spec.variants:
            if not vg.options or vg.name in spec_values:
                continue
            column = next(
                (headers[idx] for idx, (kind, target, _m) in targets.items()
                 if kind == "variant" and target == vg.name),
                vg.label or vg.name,
            )
            add_error(
                column, None,
                "缺少「%s」；可选: %s" % (
                    vg.label or vg.name,
                    ", ".join(str(o.get("name")) for o in vg.options)))

        # 独立规格轴必须给全（当前产品都是自由数值，保留通用性）
        for ax in spec.axes:
            if ax.name in spec_values:
                continue
            column = next(
                (headers[idx] for idx, (_kind, target, _m) in targets.items()
                 if target == ax.name),
                ax.label or ax.name,
            )
            add_error(
                column, None,
                "缺少规格轴「%s」；可选值: %s" % (
                    ax.label or ax.name,
                    ", ".join(str(o) for o in ax.options)))

        # 自由数值参数：没填就用产品默认值（与引擎 spec_from_partial 同口径），
        # 这样返回的行是**完整规格**，工作台不必再补默认值。
        for ni in spec.numeric_inputs:
            if ni.key in spec_values or ni.default is None:
                continue
            try:
                spec_values[ni.key] = _to_decimal(ni.default)
            except (InvalidOperation, TypeError, ValueError):
                continue

        # 填了**别的产品的规格列**：不阻断（可能只是复制粘贴），但要明确说"已忽略"，
        # 否则用户以为这一列生效了，算出来的价却按默认值走。
        applicable = applicable_idx.get(spec.key, set())
        for idx in spec_columns:
            if idx in applicable:
                continue
            value = raw_row[idx] if idx < len(raw_row) else None
            if value is None or str(value).strip() == "":
                continue
            column = headers.get(idx, "")
            issues.append(Issue(
                r_i, column, value,
                "列「%s」不适用于产品「%s」，该值已忽略" % (
                    column, spec.name or spec.key),
                severity="warning",
            ))

    return row, issues, spec


def parse_order_table(
    data: bytes,
    products: Iterable[ProductSpec],
    filename: str = "",
    sheet: str | None = None,
) -> OrderParsedTable:
    """把「整单表」（单表 + 产品列）解析成归一化的产品行。

    :param products: **可报价产品**集合（由 Worker 传入注册表 ∪ 团队可见租户产品）。
        解析器不查产品库 —— 与单产品 `parse_table` 一样只认传进来的定义。
    :raises ImportError_: 整表级失败（空表 / 超行数 / 缺「产品」「件数」「成本」列 / 无数据行）。

    逐行策略：坏行**不阻断**其它行。产品认不出来、必填列缺失、数值超范围、变体包没填，
    都记成**该行**的 error（`row_errors`），行仍返回给前端展示；包装方式匹配不上、
    重复行等只记 warning，不阻断。
    """
    specs = [p for p in (products or []) if p is not None]
    xlsx_warnings: list[str] = []
    sheet_out: dict = {}
    grid = read_table(
        data, filename, sheet, warnings=xlsx_warnings, sheet_out=sheet_out,
    )
    out = OrderParsedTable(
        source_name=filename or "",
        sheet=str(sheet_out.get("name") or sheet or ""),
        expected_columns=order_template_headers(specs),
    )
    for message in xlsx_warnings:
        out.issues.append(Issue(0, "", None, message, severity="warning"))
    if not grid:
        raise ImportError_("表格是空的")
    if len(grid) > MAX_ROWS + 1:
        raise ImportError_(
            "数据行 %d 超过上限 %d 行，请拆分后再传" % (len(grid) - 1, MAX_ROWS)
        )

    # ── 表头分派：公共列 vs 规格列 ──
    header_row = grid[0]
    headers: dict[int, str] = {}
    common_idx: dict[str, int] = {}
    spec_idx: list[int] = []
    for idx, raw in enumerate(header_row):
        if raw is None or not str(raw).strip():
            continue
        text = str(raw)
        headers[idx] = text
        base, _unit = _norm_header(text)
        slug = _ORDER_COMMON_ALIASES.get(_order_compact(base))
        if slug is None:
            spec_idx.append(idx)
        elif slug in common_idx:
            # 同一个公共列出现两次：第一列生效，其余记 ignored（不静默覆盖）
            out.ignored_columns.append(text)
        else:
            common_idx[slug] = idx
            out.mapping[text] = _ORDER_COMMON_MAPPING[slug]

    missing_required = [
        label for slug, label in (
            ("product", "产品"), ("pieces", "件数（卷）"), ("cost", "成本"),
        ) if slug not in common_idx
    ]
    if missing_required:
        raise ImportError_(
            "缺少必需列：%s。整单导入至少需要「产品」「件数（卷）」「成本」三列"
            % "、".join(missing_required)
        )

    # ── 每个产品各自的规格列映射（同一表头在不同产品下可能落到不同字段）──
    #
    # 两条判定，顺序不能反：
    #   1. **模板表头按归属产品分派**：若这个表头出现在某个产品的 `template_headers`
    #      里，就只对那个产品生效。否则「网孔/刺尖间距(cm)」（勾花网自己的列）会通过
    #      别名基名命中鹿网的 mesh_mm，把 cm 值当 mm 收下 —— 差十倍且**静默**。
    #   2. 不是任何产品模板表头的列（用户改成别名写法）：按 `_resolve_column` 认，
    #      但落点必须是该产品真实存在的字段（`_order_known_targets`），否则不算数。
    template_owners: dict[str, set[str]] = {
        spec.key: set(template_headers(spec)) for spec in specs
    }
    all_template_headers: set[str] = set()
    for owner_headers in template_owners.values():
        all_template_headers |= owner_headers

    product_targets: dict[str, dict[int, tuple[str, str, dict]]] = {}
    applicable_idx: dict[str, set[int]] = {}
    header_targets: dict[int, dict[str, str]] = {idx: {} for idx in spec_idx}
    for spec in specs:
        maps = _build_header_map(spec)
        known = _order_known_targets(spec)
        own_headers = template_owners[spec.key]
        targets: dict[int, tuple[str, str, dict]] = {}
        for idx in spec_idx:
            header = headers[idx]
            if header in all_template_headers and header not in own_headers:
                # 属于别的产品的列：本产品不适用（见上面第 1 条）
                continue
            resolved = _resolve_column(spec, header, maps)
            if resolved is None:
                continue
            kind, target, meta, unit = resolved
            if target not in known:
                # 该表头落到本产品不存在的字段 → 本产品不适用（上面第 2 条）
                continue
            if kind == "variant":
                targets[idx] = ("variant", target, {})
            elif kind == "numeric":
                targets[idx] = ("numeric", target, {
                    "unit": unit, "factor": meta["factor"]})
            else:
                targets[idx] = ("scalar", target, {
                    "unit": unit, "factor": meta["factor"]})
            header_targets[idx][spec.key] = target
        product_targets[spec.key] = targets
        applicable_idx[spec.key] = set(targets)

    # 至少对一个产品有落点的规格列：用于提示「填了不适用本行产品的列」
    spec_columns: set[int] = {idx for idx, per in header_targets.items() if per}

    for idx in spec_idx:
        text = headers[idx]
        per_product = header_targets[idx]
        if not per_product:
            out.ignored_columns.append(text)
            continue
        unique = set(per_product.values())
        if len(unique) == 1:
            out.mapping[text] = "规格:" + next(iter(unique))
        else:
            # 同名列对多产品落到不同字段：逐个标出，避免用户以为只有一个落点
            out.mapping[text] = "规格:" + " / ".join(
                "%s@%s" % (target, key) for key, target in per_product.items())

    # ── 逐行解析 ──
    lookup = _order_product_lookup(specs)
    available = "、".join("%s(%s)" % (p.name or p.key, p.key) for p in specs) or "（无）"
    seen_rows: dict[tuple, int] = {}
    product_stats: dict[str, dict] = {}
    consumed_any = False

    for r_i, raw_row in enumerate(grid[1:], start=1):
        if raw_row is None or all(
            c is None or str(c).strip() == "" for c in raw_row
        ):
            continue  # 跳过空行
        consumed_any = True
        out.total_data_rows += 1
        row, row_issues, spec = _parse_order_row(
            r_i, raw_row,
            headers=headers,
            common_idx=common_idx,
            spec_columns=spec_columns,
            applicable_idx=applicable_idx,
            product_targets=product_targets,
            lookup=lookup,
            available=available,
        )
        out.issues.extend(row_issues)
        if spec is not None:
            stat = product_stats.setdefault(spec.key, {
                "product_key": spec.key,
                "product_name": spec.name,
                "rows": 0,
            })
            stat["rows"] += 1

        # 重复行：同产品 + 同规格 → 提示（可能是误重复，也可能是两行同规格）
        if row["product_key"] and not row["row_errors"]:
            signature = (
                row["product_key"],
                tuple(sorted((str(k), str(v)) for k, v in row["spec"].items())),
            )
            first = seen_rows.get(signature)
            if first is None:
                seen_rows[signature] = r_i
            else:
                product_idx = common_idx.get("product")
                out.issues.append(Issue(
                    r_i,
                    headers.get(product_idx, "产品") if product_idx is not None else "产品",
                    row["product_name"],
                    "与第 %d 行的产品+规格重复（如确为两行请保留）" % first,
                    severity="warning",
                ))

        out.rows.append(row)

    if not consumed_any:
        raise ImportError_("表格里没有数据行")
    out.products = list(product_stats.values())
    return out


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
                default = getattr(c, "default", None)
                row.append("" if default is None else _as_number(default))
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
