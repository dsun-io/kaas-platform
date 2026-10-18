"""企业抬头规则（用户 2026-10-18）：SWIFT 8/11 位字母数字。"""
import pytest

from kaas_common.workstation.company_rules import SwiftError, normalize_swift


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
