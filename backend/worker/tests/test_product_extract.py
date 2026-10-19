"""chain.py 产品信息提取逻辑的确定性单元测试。

覆盖「脚本为主」的核心：官网 HTML → 产品字段提取、规格正则结构化、
布尔解析、SSRF 防护、三态过滤。

chain.py 依赖 Worker 运行时（`from main import app`），这里用 stub 顶替 main，
只加载纯函数进行验证 —— 无需 Cloudflare runtime、无需数据库、无需网络。

运行：
    cd backend/worker
    python -m pytest tests/ -q            # 或用任意 3.13+ 解释器直接执行
    python tests/test_product_extract.py
"""
import sys
import types
from pathlib import Path

# ── stub `main`（chain.py 从它导入 app / _acquire / _get_current_user）──────
from fastapi import FastAPI

_stub = types.ModuleType("main")
_stub.app = FastAPI()
_stub._acquire = lambda request: None
_stub._get_current_user = lambda: {"id": 1}
_stub.DEFAULT_TENANT = "default"


async def _stub_next_inquiry_no(conn, customer):
    raise NotImplementedError("stub：纯函数测试不触库")


_stub._next_inquiry_no = _stub_next_inquiry_no
sys.modules["main"] = _stub

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import chain  # noqa: E402

FAILS = []


def check(name, cond, extra=""):
    if not cond:
        FAILS.append(f"{name} {extra}")


SAMPLE_HTML = """<!doctype html>
<html><head>
<title>Protect Kazakhstan — Fencing &amp; Geogrid</title>
<meta property="og:image" content="https://shop.npoprotect.kz/img/mesh-248.jpg">
<meta name="description" content="Оградительная пластиковая сетка 2.0mm HDPE, 50x50mm mesh">
</head><body>
<h1>Оградительная пластиковая сетка</h1>
<p>Пластиковая сетка HDPE 2.0mm, размер ячейки 50x50mm, рулон 1.5m x 25m.</p>
<a href="/products/geogrid-40kn">Георешётка 40 кН</a>
<a href="/contact">Контакты</a>
<script>var x = "<h1>SHOULD_NOT_APPEAR</h1>";</script>
</body></html>"""


def test_extract_product_from_html():
    """Google Places 看不到产品 → 爬官网提取产品名/图片/规格/链接。"""
    d = chain.extract_product_from_html(SAMPLE_HTML, "https://shop.npoprotect.kz/")
    assert d["product_name"] == "Оградительная пластиковая сетка"
    assert d["product_name_source"] == "h1"
    assert d["product_image_url"] == "https://shop.npoprotect.kz/img/mesh-248.jpg"
    assert d["link_url"] == "https://shop.npoprotect.kz/products/geogrid-40kn"
    assert "Оградительная пластиковая сетка 2.0mm HDPE" in d["spec_raw"]
    assert "рулон 1.5m x 25m" in d["spec_raw"]
    # script 内容必须剥离，HTML 实体必须还原
    assert "SHOULD_NOT_APPEAR" not in d["spec_raw"]
    assert "Fencing & Geogrid" in d["page_title"]


def test_extract_falls_back_to_title_without_h1():
    html = "<html><head><title>Wire Mesh Supplier</title></head><body><p>x</p></body></html>"
    d = chain.extract_product_from_html(html, "https://a.com/")
    assert d["product_name"] == "Wire Mesh Supplier"
    assert d["product_name_source"] == "title"


def test_abs_url():
    assert chain._abs_url("https://a.com/x", "https://b.com/y") == "https://b.com/y"
    assert chain._abs_url("https://a.com/x", "/p/1") == "https://a.com/p/1"
    assert chain._abs_url("https://a.com/x", "//cdn.a.com/z") == "https://cdn.a.com/z"


def test_template_spec_extract_is_deterministic():
    """规格结构化走脚本正则（确定性），AI 未启用也能产出。"""
    spec = chain._template_spec_extract({
        "product_name": "Оградительная пластиковая сетка",
        "spec_raw": "Пластиковая сетка HDPE 2.0mm, размер ячейки 50x50mm, рулон 1.5m x 25m.",
    })["spec_normalized"]
    assert spec["size_a"] == "50" and spec["size_b"] == "50"
    assert "hdpe" in spec["materials"]
    assert "2.0mm" in spec["dimensions"]


def test_template_spec_extract_never_invents():
    """空输入返回 None —— 不臆测。"""
    assert chain._template_spec_extract({"product_name": None, "spec_raw": None})[
        "spec_normalized"] is None


def test_as_bool_tristate():
    """能否提供解析真值；未知值落 None（不臆测为 False）。"""
    assert chain._as_bool("TRUE") is True
    assert chain._as_bool("false") is False
    assert chain._as_bool("是") is True
    assert chain._as_bool("否") is False
    assert chain._as_bool("1") is True
    assert chain._as_bool("0") is False
    for unknown in ("", "n/a", "-", "хаха", None):
        assert chain._as_bool(unknown) is None


def test_ssrf_guard_blocks_internal_targets():
    """爬取只允许公网 http(s)：防 CSV/线索注入内网或云元数据地址。"""
    for ok in ("https://shop.npoprotect.kz/", "http://example.com/products",
               "https://sub.example.co.uk/x"):
        assert chain._is_safe_crawl_url(ok) is True, ok
    for bad in ("file:///etc/passwd", "ftp://example.com/x", "javascript:alert(1)",
                "http://localhost/admin", "http://127.0.0.1:8080/",
                "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/",
                "http://192.168.1.1/", "http://172.16.0.1/", "http://[::1]/",
                "http://internal/", "http:///nohost"):
        assert chain._is_safe_crawl_url(bad) is False, bad


def test_crawl_byte_cap_defined():
    assert 50_000 <= chain.MAX_CRAWL_BYTES <= 2_000_000


def test_research_list_supports_tristate_filter():
    """can_supply 三态在服务端过滤（true/false/unknown）。"""
    import inspect
    src = inspect.getsource(chain.research_list)
    assert "can_supply IS NULL" in src
    assert "can_supply IS TRUE" in src
    assert "can_supply IS FALSE" in src


def test_subscription_codes_registered():
    """情报体系三工位订阅编码已登记（本期不激活，填行即生效）。"""
    assert "intel_full" in chain.SUB_CODES["intel"]
    assert "intel_research_starter" in chain.SUB_CODES["research"]
    assert "full_chain" in chain.SUB_CODES["research"]
    assert "full_chain" in chain.SUB_CODES["intel"]


def test_ai_tasks_have_script_fallbacks():
    """AI 为辅：每个新增任务都必须有确定性兜底（脚本/模板）。"""
    assert chain.TASKS["spec_extract"]["template_fn"] is chain._template_spec_extract
    assert "product_translate" in chain.TASKS
    assert chain.TASKS["product_translate"]["template_fn"] is chain._template_product_translate


# ── 无 pytest 时的直接执行入口（保持零依赖）───────────────────────────────
if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    for name, fn in tests:
        try:
            fn()
            print(f"  PASS  {name}")
        except AssertionError as e:
            print(f"  FAIL  {name}  {e}")
            FAILS.append(name)
    print()
    if FAILS:
        print(f"RESULT: FAIL ({len(FAILS)}): {FAILS}")
        sys.exit(1)
    print(f"RESULT: PASS ({len(tests)} tests)")
