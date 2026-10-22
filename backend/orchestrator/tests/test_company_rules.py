"""企业抬头规则：SWIFT 8/11 位字母数字（2026-10-18）+ 税号（2026-10-22）。"""
import pytest

from kaas_common.workstation.company_rules import (
    SwiftError, TaxIdError, normalize_swift, normalize_tax_id,
)


def test_swift_8_and_11_ok_and_uppercased():
    assert normalize_swift("bkchcnbj") == "BKCHCNBJ"
    assert normalize_swift(" bkchcnbj220 ") == "BKCHCNBJ220"


def test_swift_blank_is_none():
    assert normalize_swift(None) is None
    assert normalize_swift("") is None
    assert normalize_swift("   ") is None


@pytest.mark.parametrize("bad", ["BKCHCNB", "BKCHCNBJ12", "BKCHCNBJ2200", "BKCH-CNBJ", "ABCD123!"])
def test_swift_invalid_raises(bad):
    with pytest.raises(SwiftError):
        normalize_swift(bad)


# ── 税号（2026-10-22）：统一社会信用代码 18 位（放宽 6–32 位字母/数字）────────

def test_tax_id_18_digit_ok():
    assert normalize_tax_id("91131125MA0GA4242U") == "91131125MA0GA4242U"


def test_tax_id_lowercase_is_uppercased_and_trimmed():
    assert normalize_tax_id(" 91310000ma1fl1234x ") == "91310000MA1FL1234X"


def test_tax_id_blank_is_none():
    assert normalize_tax_id(None) is None
    assert normalize_tax_id("") is None
    assert normalize_tax_id("   ") is None


@pytest.mark.parametrize("bad", ["12345", "9131000-MA1FL1234X", "税号12345", "A" * 33])
def test_tax_id_invalid_raises_with_contract_code(bad):
    with pytest.raises(TaxIdError) as exc:
        normalize_tax_id(bad)
    assert exc.value.code == "INVALID_TAX_ID"
    assert "6–32" in str(exc.value)
