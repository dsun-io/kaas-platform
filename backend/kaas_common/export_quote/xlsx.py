"""纯标准库的 .xlsx 读取器 —— 批量报价导入用（Cloudflare Python Workers 可跑）。

为什么不用 openpyxl
------------------
Worker 跑在 Pyodide 里，openpyxl 打不进包（依赖 C 扩展/额外分发）。而 .xlsx 本质是
「zip + 一堆 XML」，标准库 `zipfile` + `xml.etree.ElementTree` 就足够把**值**读出来。
本模块只读不写、不做样式计算：目标是把一张表读成 `list[list[str]]`，交给
`importers.parse_table` 复用**同一套**表头/单位/行映射（绝不在这里另写一份列名判定）。

支持范围（批量导入实际会遇到的）
------------------------------
- **工作表**：`xl/workbook.xml`（表名/顺序/r:id）→ `xl/_rels/workbook.xml.rels` →
  `xl/worksheets/sheetN.xml`。默认读第一张，可用 `sheet=` 指定表名；表名不存在时
  **按旧行为回退到第一张**，但会把"实际读了哪张、可用表名有哪些"写进 `warnings`
  （不静默，也不让一次手滑选错就整表导入失败）。
- **单元格**：共享字符串（`xl/sharedStrings.xml`）、inlineStr、富文本 run（拼接 `<t>`，
  跳过 `<rPh>` 注音）、公式缓存值 `<v>`、布尔/错误值、`t="d"` 的 ISO 日期、数值。
- **日期**：按 `xl/styles.xml` 的 `cellXfs → numFmtId` 判断日期/时间格式，把 Excel
  serial 转成 ISO 字符串（`YYYY-MM-DD` 或 `YYYY-MM-DDTHH:MM:SS`；纯时间给 `HH:MM:SS`）。
  单元格有样式但 numFmtId 解析不出来时，**保留数值字符串**并把说明写进 `warnings`。
- **合并单元格**：合并区域内每一格都取**左上角**的值。
- **稀疏表**：缺省的 cell / row 按 `r="A1"` 引用定位补空位（空单元格是 `""`）。
- **上限**：文件大小 / 行数上限复用 `importers.MAX_BYTES` / `MAX_ROWS`（与 CSV 一致）；
  另设列数上限与解压总量上限，避免畸形/炸弹文件把 Worker 内存打满。
- **失败**：一律抛 `importers.ImportError_`（与 CSV 同类，上层统一转 400 `parse_error`），
  文案写「用户下一步能做什么」而不是抛底层异常。

已知不做的（够用且不增加失败面）
------------------------------
- 公式求值（只取 Excel 保存时的缓存值 `<v>`；没有缓存按空值处理）。
- 图表/图片/批注/条件格式/数据验证（读表不需要）。
- `.xls`（OLE2）与 `.xlsb`：不是 zip+XML，明确拒绝并指路另存为 .xlsx/.csv。
"""
from __future__ import annotations

import io
import posixpath
import re
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_FLOOR, ROUND_HALF_UP

# 列数上限：ECMA-376 允许 16384 列，报价表几十列就够；超限多半是畸形文件，
# 卡住可以避免按 `r="XFD1"` 申请超宽行。
MAX_COLS = 256
# 解压总量上限（防 zip bomb）：正常报价表解压后只有几百 KB。
MAX_UNZIPPED = 32 * 1024 * 1024

# 内置 numFmtId 里属于「日期/时间」的那些（ECMA-376 §18.8.30）。
# 27–36、50–58 是各区域设置的日期格式；45–47 是时间/经过时间。
_DATE_NUMFMT_IDS = frozenset(
    {14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47}
    | set(range(27, 37))
    | set(range(50, 59))
)

# 公式/字符串/错误等单元格类型（t 属性）
_CELL_TYPES = frozenset({"n", "s", "str", "inlineStr", "b", "e", "d"})


# ─────────────────────────────────────────────────────────────────────────────
# XML / zip 小工具
# ─────────────────────────────────────────────────────────────────────────────
def _local(tag: str) -> str:
    """去掉 XML 命名空间，只留 localName（`{ns}row` → `row`）。"""
    return tag.rsplit("}", 1)[-1]


def _attr(el: ET.Element, name: str) -> str | None:
    """按 localName 取属性（`r:id` 的属性名带命名空间，不能直接用 `el.get("id")`）。"""
    for key, value in el.attrib.items():
        if _local(key) == name:
            return value
    return None


def _parse_xml(blob: bytes, what: str, import_error) -> ET.Element:
    try:
        return ET.fromstring(blob)
    except ET.ParseError as exc:
        raise import_error("xlsx 内部 XML 损坏（%s）：%s" % (what, exc)) from exc


def _column_index(ref: str) -> int | None:
    """`B12` → 1（0 基列号）。只认列字母，行号由调用方按 `r` 取。"""
    letters = ""
    for ch in ref:
        if ch.isalpha():
            letters += ch
        else:
            break
    if not letters:
        return None
    index = 0
    for ch in letters.upper():
        index = index * 26 + (ord(ch) - ord("A") + 1)
    return index - 1


def _split_ref(ref: str) -> tuple[int, int] | None:
    """`B12` → (11, 1)（0 基行列）。"""
    if not ref:
        return None
    col = _column_index(ref)
    digits = re.sub(r"^[A-Za-z]+", "", ref)
    if col is None or not digits.isdigit():
        return None
    return int(digits) - 1, col


def _rich_text(node: ET.Element | None) -> str:
    """`<si>` / `<is>` 里的文本：拼所有 `<t>`，跳过 `<rPh>`（注音）子树。"""
    if node is None:
        return ""
    parts: list[str] = []

    def walk(el: ET.Element) -> None:
        for child in el:
            tag = _local(child.tag)
            if tag == "rPh":
                continue
            if tag == "t":
                parts.append(child.text or "")
            else:
                walk(child)

    walk(node)
    return "".join(parts)


def _open_zip(data: bytes, import_error) -> zipfile.ZipFile:
    try:
        return zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, OSError) as exc:
        raise import_error(
            "不是有效的 .xlsx 文件（无法按 zip 打开）。"
            "如果这是老的 .xls，请在 Excel 里「另存为」.xlsx 或 CSV 后再上传"
        ) from exc


def _read_part(zf: zipfile.ZipFile, name: str, import_error) -> bytes | None:
    """读 zip 内一个部件；不存在返回 None（sharedStrings/styles 允许缺省）。"""
    try:
        info = zf.getinfo(name)
    except KeyError:
        return None
    if info.file_size > MAX_UNZIPPED:
        raise import_error("xlsx 内部文件（%s）解压后过大，已拒绝解析" % name)
    try:
        return zf.read(name)
    except (zipfile.BadZipFile, OSError) as exc:
        raise import_error("xlsx 内部文件损坏（%s）" % name) from exc


def _check_unzipped_size(zf: zipfile.ZipFile, import_error) -> None:
    total = sum(getattr(info, "file_size", 0) for info in zf.infolist())
    if total > MAX_UNZIPPED:
        raise import_error(
            "xlsx 解压后体积过大（%.1f MB > %d MB 上限），已拒绝解析"
            % (total / 1048576.0, MAX_UNZIPPED // 1048576)
        )


# ─────────────────────────────────────────────────────────────────────────────
# 工作簿结构：sheet 名 → 目标 XML
# ─────────────────────────────────────────────────────────────────────────────
def _normalize_target(target: str) -> str:
    """`worksheets/sheet1.xml` / `/xl/worksheets/sheet1.xml` / `../x` → zip 内路径。"""
    target = (target or "").strip().replace("\\", "/")
    if not target:
        return ""
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join("xl", target))


def _sheet_entries(
    zf: zipfile.ZipFile, import_error
) -> tuple[list[tuple[str, str]], dict[str, str], bool]:
    """返回 ([(表名, 目标XML)] 按工作簿顺序, relId→目标XML, date1904)。"""
    workbook_blob = _read_part(zf, "xl/workbook.xml", import_error)
    if workbook_blob is None:
        raise import_error(
            "这个 zip 里没有 xl/workbook.xml：它看起来不是 Excel .xlsx 文件"
            "（.xls 请先另存为 .xlsx 或 CSV）"
        )
    root = _parse_xml(workbook_blob, "xl/workbook.xml", import_error)

    date1904 = False
    rel_map: dict[str, str] = {}
    rels_blob = _read_part(zf, "xl/_rels/workbook.xml.rels", import_error)
    if rels_blob is not None:
        rels_root = _parse_xml(rels_blob, "xl/_rels/workbook.xml.rels", import_error)
        for rel in rels_root:
            if _local(rel.tag) != "Relationship":
                continue
            rid = _attr(rel, "Id")
            target = _normalize_target(_attr(rel, "Target") or "")
            if rid and target:
                rel_map[rid] = target

    entries: list[tuple[str, str]] = []
    for el in root.iter():
        tag = _local(el.tag)
        if tag == "workbookPr":
            value = (_attr(el, "date1904") or "").lower()
            date1904 = value in ("1", "true")
        elif tag == "sheet":
            name = _attr(el, "name") or ""
            rid = _attr(el, "id") or ""
            target = rel_map.get(rid, "")
            entries.append((name, target))

    if not entries:
        raise import_error("xlsx 里没有任何工作表")
    return entries, rel_map, date1904


def _pick_sheet(
    entries: list[tuple[str, str]],
    sheet: str | None,
    warnings: list[str],
) -> tuple[str, str]:
    names = [name for name, _ in entries]
    if sheet is None:
        return entries[0]
    for name, target in entries:
        if name == sheet:
            return name, target
    # 大小写/首尾空格这类"手滑"给一次机会
    wanted = str(sheet).strip().lower()
    for name, target in entries:
        if name.strip().lower() == wanted:
            return name, target
    # 兼容旧 openpyxl 路径的**兜底**语义（缺失的表名 → 读第一张），
    # 但不静默：把"实际读了哪张"记进 warnings，页面能提示用户选错了表名。
    fallback_name, fallback_target = entries[0]
    warnings.append(
        "没有名为「%s」的工作表，已按默认读取第一张表「%s」；"
        "可用的表：%s" % (sheet, fallback_name, "、".join(names))
    )
    return fallback_name, fallback_target


# ─────────────────────────────────────────────────────────────────────────────
# 样式（只为判定日期格式）
# ─────────────────────────────────────────────────────────────────────────────
def _read_styles(
    zf: zipfile.ZipFile, import_error
) -> tuple[list[int], dict[int, str]]:
    """返回 (cellXfs 每项的 numFmtId 列表, 自定义 numFmtId → formatCode)。"""
    blob = _read_part(zf, "xl/styles.xml", import_error)
    if blob is None:
        return [], {}
    root = _parse_xml(blob, "xl/styles.xml", import_error)
    xf_numfmts: list[int] = []
    custom: dict[int, str] = {}
    for el in root.iter():
        tag = _local(el.tag)
        if tag == "numFmt":
            try:
                fmt_id = int(_attr(el, "numFmtId") or "")
            except ValueError:
                continue
            custom[fmt_id] = _attr(el, "formatCode") or ""
        elif tag == "cellXfs":
            for xf in el:
                if _local(xf.tag) != "xf":
                    continue
                try:
                    xf_numfmts.append(int(_attr(xf, "numFmtId") or "0"))
                except ValueError:
                    xf_numfmts.append(0)
    return xf_numfmts, custom


def _is_date_format_code(code: str) -> bool:
    """formatCode 里有没有日期/时间占位符（`yyyy-mm-dd`、`h:mm` …）。"""
    text = code or ""
    text = re.sub(r'"[^"]*"', "", text)        # 引号内是字面量
    text = re.sub(r"\\.", "", text)            # 反斜杠转义
    text = re.sub(r"\[[^\]]*\]", "", text)     # [Red] / [$-404] / [h] 之类
    text = re.sub(r"[_*].", "", text)          # 下划线/星号占位符
    return bool(re.search(r"[ymdhs]", text, re.IGNORECASE))


def _is_date_numfmt(
    numfmt_id: int,
    custom: dict[int, str],
    warnings: list[str],
    ref: str,
) -> bool:
    if numfmt_id in _DATE_NUMFMT_IDS:
        return True
    if numfmt_id in custom:
        return _is_date_format_code(custom[numfmt_id])
    if 0 <= numfmt_id <= 49:
        # 0–49 里除日期外的内置格式（General/数值/百分比/科学计数/分数/文本）
        return False
    warnings.append(
        "单元格 %s 的单元格格式（numFmtId=%d）无法解析，已按数值读取；"
        "若它是日期，请把该列改成「文本」或「常规」格式后再上传" % (ref, numfmt_id)
    )
    return False


# ─────────────────────────────────────────────────────────────────────────────
# 值转换
# ─────────────────────────────────────────────────────────────────────────────
def _number_text(raw: str) -> str:
    """数值规范化：展开科学计数（1E+2 → 100），去掉多余尾零；解析不了保留原文。"""
    text = (raw or "").strip()
    if not text:
        return ""
    try:
        value = Decimal(text)
    except InvalidOperation:
        return text
    if not value.is_finite():
        return text
    normalized = value.normalize()
    out = format(normalized, "f")
    if out in ("", "-0"):
        return "0"
    return out


def _serial_to_iso(raw: str, date1904: bool) -> str | None:
    """Excel 日期 serial → ISO 字符串；超出可表示范围返回 None（调用方保留数值）。"""
    try:
        serial = Decimal((raw or "").strip())
    except InvalidOperation:
        return None
    if not serial.is_finite() or serial < 0:
        return None
    try:
        # 纯时间（0 ≤ serial < 1）：Excel 存当天的小数部分
        if not date1904 and serial < 1:
            total = int(
                (serial * 86400).to_integral_value(rounding=ROUND_HALF_UP)
            ) % 86400
            return "%02d:%02d:%02d" % (total // 3600, total % 3600 // 60, total % 60)

        days = int(serial.to_integral_value(rounding=ROUND_FLOOR))
        fraction = serial - days
        if date1904:
            base = datetime(1904, 1, 1)
        else:
            # Excel 的 1900 闰年 bug：serial < 60 要补 1 天（1 → 1900-01-01）
            base = datetime(1899, 12, 30)
            if serial < 60:
                days += 1
        seconds = int(
            (fraction * 86400).to_integral_value(rounding=ROUND_HALF_UP)
        )
        moment = base + timedelta(days=days, seconds=seconds)
        if fraction == 0:
            return moment.date().isoformat()
        return moment.replace(microsecond=0).isoformat()
    except (OverflowError, ValueError):
        return None


def _cell_value(
    cell: ET.Element,
    shared: list[str],
    xf_numfmts: list[int],
    custom_fmts: dict[int, str],
    date1904: bool,
    warnings: list[str],
    ref: str,
    import_error,
) -> str:
    """单个 `<c>` → 字符串值（空单元格返回 ""）。"""
    cell_type = _attr(cell, "t") or "n"
    if cell_type not in _CELL_TYPES:
        cell_type = "n"

    inline = next((ch for ch in cell if _local(ch.tag) == "is"), None)
    value_el = next((ch for ch in cell if _local(ch.tag) == "v"), None)
    raw = value_el.text if value_el is not None else None

    if cell_type == "inlineStr":
        return _rich_text(inline)
    if cell_type == "s":
        if raw is None or raw.strip() == "":
            return ""
        try:
            return shared[int(raw)]
        except (ValueError, IndexError):
            warnings.append(
                "单元格 %s 引用了不存在的共享字符串（索引 %r），已按空值读取"
                % (ref, raw)
            )
            return ""
    if cell_type == "str":
        return raw or ""
    if cell_type == "b":
        if raw is None or raw.strip() == "":
            return ""
        return "TRUE" if raw.strip().lower() in ("1", "true") else "FALSE"
    if cell_type == "e":
        return raw or ""
    if cell_type == "d":
        if not raw:
            return ""
        # ISO 8601 原样归一（去掉可能的尾 Z，保持与其它日期同形）
        text = raw.strip()
        return text[:-1] if text.endswith("Z") else text

    # 数值（t="n" 或缺省）
    if raw is None or raw.strip() == "":
        return ""
    style_index = _attr(cell, "s")
    numfmt_id: int | None = None
    if style_index is not None:
        try:
            numfmt_id = xf_numfmts[int(style_index)]
        except (ValueError, IndexError):
            warnings.append(
                "单元格 %s 的样式索引（s=%r）无效，已按数值读取"
                % (ref, style_index)
            )
    if numfmt_id is not None and _is_date_numfmt(
        numfmt_id, custom_fmts, warnings, ref
    ):
        iso = _serial_to_iso(raw, date1904)
        if iso is not None:
            return iso
    return _number_text(raw)


# ─────────────────────────────────────────────────────────────────────────────
# 工作表
# ─────────────────────────────────────────────────────────────────────────────
def _read_shared_strings(
    zf: zipfile.ZipFile, import_error
) -> list[str]:
    blob = _read_part(zf, "xl/sharedStrings.xml", import_error)
    if blob is None:
        return []
    root = _parse_xml(blob, "xl/sharedStrings.xml", import_error)
    return [_rich_text(si) for si in root if _local(si.tag) == "si"]


def _read_worksheet(
    blob: bytes,
    sheet_name: str,
    *,
    shared: list[str],
    xf_numfmts: list[int],
    custom_fmts: dict[int, str],
    date1904: bool,
    warnings: list[str],
    max_rows: int,
    import_error,
) -> list[list[str]]:
    root = _parse_xml(blob, "工作表「%s」" % sheet_name, import_error)
    sheet_data = next(
        (el for el in root.iter() if _local(el.tag) == "sheetData"), None
    )
    if sheet_data is None:
        return []

    rows: list[list[str]] = []
    last_row_index = -1
    for row_el in sheet_data:
        if _local(row_el.tag) != "row":
            continue
        row_attr = _attr(row_el, "r")
        if row_attr and row_attr.isdigit():
            row_index = int(row_attr) - 1
        else:
            row_index = last_row_index + 1
        if row_index < 0:
            row_index = 0
        if row_index > max_rows:
            # 与 parse_table 的 CSV 口径同一句话（header 之外最多 max_rows 行）
            raise import_error(
                "数据行 %d 超过上限 %d 行，请拆分后再传" % (row_index, max_rows)
            )

        cells: dict[int, str] = {}
        last_col = -1
        for cell in row_el:
            if _local(cell.tag) != "c":
                continue
            ref = _attr(cell, "r") or ""
            col_index = _column_index(ref) if ref else None
            if col_index is None:
                col_index = last_col + 1
            last_col = col_index
            if col_index >= MAX_COLS:
                raise import_error(
                    "列数超过上限 %d 列（看到第 %d 列），请精简表格后再传"
                    % (MAX_COLS, col_index + 1)
                )
            cell_ref = ref or "R%dC%d" % (row_index + 1, col_index + 1)
            cells[col_index] = _cell_value(
                cell, shared, xf_numfmts, custom_fmts, date1904,
                warnings, cell_ref, import_error,
            )

        while len(rows) <= row_index:
            rows.append([])
        width = (max(cells) + 1) if cells else 0
        row = [""] * width
        for col_index, value in cells.items():
            row[col_index] = value
        rows[row_index] = row
        last_row_index = row_index

    # 末尾整行空白（Excel 会为"设置过格式但没填内容"的行存 `<row>`）不算数据：
    # 去掉它们，免得白占 MAX_ROWS 额度、也让"只有表头"能走到 parse_table 的
    # "表格里没有数据行"提示。
    while rows and all(not str(v).strip() for v in rows[-1]):
        rows.pop()
    if not rows:
        return []

    _apply_merged_cells(root, rows, import_error)
    return rows


def _apply_merged_cells(
    root: ET.Element, rows: list[list[str]], import_error
) -> None:
    """合并单元格：区域内每一格都取左上角的值（任务口径）。"""
    for merge in root.iter():
        if _local(merge.tag) != "mergeCell":
            continue
        ref = _attr(merge, "ref") or ""
        if ":" not in ref:
            continue
        start_text, end_text = ref.split(":", 1)
        start = _split_ref(start_text)
        end = _split_ref(end_text)
        if start is None or end is None:
            continue
        row1, col1 = start
        row2, col2 = end
        if row1 >= len(rows) or row1 < 0:
            continue
        anchor_row = rows[row1]
        if col1 >= len(anchor_row):
            continue
        value = anchor_row[col1]
        if value == "":
            continue
        for row_index in range(row1, min(row2, len(rows) - 1) + 1):
            row = rows[row_index]
            for col_index in range(col1, min(col2, MAX_COLS - 1) + 1):
                if col_index < len(row):
                    if row[col_index] == "":
                        row[col_index] = value
                    continue
                row.extend([""] * (col_index - len(row)))
                row[col_index] = value


# ─────────────────────────────────────────────────────────────────────────────
# 对外入口
# ─────────────────────────────────────────────────────────────────────────────
def read_xlsx(
    data: bytes,
    sheet: str | None = None,
    *,
    warnings: list[str] | None = None,
) -> list[list[str]]:
    """把 .xlsx 字节读成行列表（第一行是表头，值一律转成字符串）。

    :param data: 文件字节（与 CSV 共用 2 MB 上限）
    :param sheet: 表名；None = 工作簿里的第一张表
    :param warnings: 可选出参：把"格式无法解析、已按数值读取"之类的提示追加进来，
        由调用方决定是否呈现给用户（不抛异常，避免因为一个样式丢整张表）
    :raises importers.ImportError_: 非 zip / 不是 xlsx / 缺工作表 / 超行数·列数/解压过大
    """
    # 延迟导入：xlsx.py 只用 importers 的常量和异常类，importers 又反向调用本模块，
    # 顶层互相 import 会成环。运行期（read_table 调用时）两边都已加载，安全。
    from .importers import ImportError_, MAX_BYTES, MAX_ROWS

    warn = warnings if warnings is not None else []
    if not data:
        raise ImportError_("文件是空的")
    if len(data) > MAX_BYTES:
        raise ImportError_(
            "文件过大（%.1f MB），上限 %d MB"
            % (len(data) / 1048576.0, MAX_BYTES // 1048576)
        )

    zf = _open_zip(data, ImportError_)
    try:
        _check_unzipped_size(zf, ImportError_)
        entries, _rels, date1904 = _sheet_entries(zf, ImportError_)
        if isinstance(sheet, str) and not sheet.strip():
            sheet = None
        name, target = _pick_sheet(entries, sheet, warn)
        if not target:
            raise ImportError_(
                "xlsx 结构不完整：工作表「%s」缺少关系定义（xl/_rels/workbook.xml.rels）"
                % name
            )
        blob = _read_part(zf, target, ImportError_)
        if blob is None:
            raise ImportError_(
                "xlsx 结构不完整：找不到工作表「%s」的数据（%s）" % (name, target)
            )
        shared = _read_shared_strings(zf, ImportError_)
        xf_numfmts, custom_fmts = _read_styles(zf, ImportError_)
        return _read_worksheet(
            blob,
            name,
            shared=shared,
            xf_numfmts=xf_numfmts,
            custom_fmts=custom_fmts,
            date1904=date1904,
            warnings=warn,
            max_rows=MAX_ROWS,
            import_error=ImportError_,
        )
    finally:
        zf.close()


__all__ = ["read_xlsx", "MAX_COLS", "MAX_UNZIPPED"]
