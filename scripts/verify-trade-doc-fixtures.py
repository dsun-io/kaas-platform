"""用归档的 Python 渲染器复验前端基线：确保 TypeScript 版仍是 Python 版的忠实移植。

> ⚠️ **2026-10-21 起（TODO C10）本脚本降级为「历史对照工具」**：单证模板加了
> 签章区原子块（`keep-together`，见 `frontend/src/lib/trade-doc/assets.json`），
> TS 渲染器**有意**偏离归档 Python 实现 ⇒ 默认会报 18/18 差异（首个差异即 C10 CSS），
> **这是预期，不是回归**。当前 TS 侧唯一真源是 `frontend/src/lib/trade-doc/__tests__/render.test.ts`
> 的 18 份逐字节基线；归档 Python 作为历史留档，不再同步。
> 需要看"差异仍只是模板外壳"时用：`python scripts/verify-trade-doc-fixtures.py --allow-divergence`
> （有差异也退出 0，并打印说明）。

为什么必需（历史上）
----------
改了样例数据之后重生基线，如果只跑前端测试，那只是「TS 对 TS」自证，
失去了「逐字节对齐旧实现」的意义。本脚本用**旧实现**渲染同一份数据，
与前端基线逐字节比对 —— 两边一致才说明迁移与基线都还站得住。

用法：python scripts/verify-trade-doc-fixtures.py [--allow-divergence]
退出码：0 = 全部一致（或 `--allow-divergence` 下有差异）；1 = 存在差异
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ARCHIVE = ROOT / "archive" / "2026-09-trade-doc-xprime-python"
RENDERER = ARCHIVE / "app" / "renderers" / "trade_doc_renderer.py"
DATA = ROOT / "frontend" / "src" / "lib" / "trade-doc" / "sample-data.json"
GOLDEN = ROOT / "frontend" / "src" / "lib" / "trade-doc" / "__fixtures__" / "html"

# 按【文件路径】直接加载归档渲染器，不走 `app.renderers` 这个包名。
# 原因（踩过的坑）：归档里没有 `app/__init__.py`（它仍在编排器中服役，没被搬走），
# 于是归档的 `app` 只能算「命名空间包」，而编排器的 `app` 是带 __init__.py 的常规包，
# 后者在 sys.path 扫描中胜出 → `import app.renderers` 实际去编排器找，必然 ModuleNotFoundError。
# 归档渲染器只用标准库、模板路径基于 __file__ 定位，因此按路径加载完全等价、且不受干扰。
if not RENDERER.exists():
    print(f"[FATAL] 归档渲染器不存在：{RENDERER}")
    raise SystemExit(2)

_spec = importlib.util.spec_from_file_location("archived_trade_doc_renderer", RENDERER)
if _spec is None or _spec.loader is None:
    print(f"[FATAL] 无法为归档渲染器建立加载器：{RENDERER}")
    raise SystemExit(2)
_mod = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _mod
try:
    _spec.loader.exec_module(_mod)
except Exception as ex:
    print(f"[FATAL] 执行归档渲染器失败：{type(ex).__name__}: {ex}")
    raise SystemExit(2)

render_trade_doc = _mod.render_trade_doc

payload = json.loads(DATA.read_text(encoding="utf-8"))
doc_types = payload["doc_types"]
base = payload["base"]
other_extra = payload["other_extra"]

print("=" * 78)
print("归档 Python 渲染器  ↔  前端 TypeScript 基线  逐字节比对")
print("=" * 78)

bad = []
for doc_type in doc_types:
    data = {**base, **(other_extra if doc_type == "other" else {})}
    try:
        py_html = render_trade_doc(doc_type, data)
    except Exception as ex:
        bad.append(doc_type)
        print(f"  FAIL  {doc_type:22} Python 渲染失败：{type(ex).__name__}: {ex}")
        continue

    golden_path = GOLDEN / f"sample_{doc_type}.html"
    if not golden_path.exists():
        bad.append(doc_type)
        print(f"  FAIL  {doc_type:22} 基线文件不存在")
        continue

    # 统一按 LF 比较（基线按 LF 写入；Python 端在 Windows 上可能产出 CRLF）
    ts_html = golden_path.read_text(encoding="utf-8").replace("\r\n", "\n")
    py_norm = py_html.replace("\r\n", "\n")

    if py_norm == ts_html:
        print(f"  OK    {doc_type:22} {len(ts_html):>6} 字节一致")
        continue

    bad.append(doc_type)
    idx = 0
    while idx < min(len(py_norm), len(ts_html)) and py_norm[idx] == ts_html[idx]:
        idx += 1
    print(f"  FAIL  {doc_type:22} 长度 {len(py_norm)} vs 基线 {len(ts_html)}，首个差异 @{idx}")
    print(f"        Python : {py_norm[idx:idx + 60]!r}")
    print(f"        基线   : {ts_html[idx:idx + 60]!r}")

print()
if bad:
    if "--allow-divergence" in sys.argv[1:]:
        print(f"⚠ {len(bad)} 类不一致 —— 但已传 --allow-divergence：")
        print("  自 TODO C10（2026-10-21）起 TS 模板有意偏离归档 Python（签章区原子块），")
        print("  本脚本只作历史对照；TS 侧基线以 frontend 的 render.test.ts 为准。")
        raise SystemExit(0)
    print(f"✗ {len(bad)} 类不一致：{', '.join(bad)}")
    print("  （若差异仅来自 C10 的 keep-together 模板改动，加 --allow-divergence 可放行）")
    raise SystemExit(1)
print(f"✓ {len(doc_types)} 类全部逐字节一致（TypeScript 渲染 == 归档 Python 渲染）")
