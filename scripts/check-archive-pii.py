#!/usr/bin/env python
"""归档真实样例 PII 回归门禁（2026-10-23 用户裁决：仅 18 份高危样例脱敏）。

判据：archive/2026-09-trade-doc-xprime-python/sample_docs/ 下 18 份真实单据样例，
不得再出现真实公司名 / 电话 / 邮箱 / 银行账号 / 身份证 / 手机号；占位符必须与
本次脱敏口径一致（金额、品名、HS 编码、日期等业务数据按裁决保留，不在此门禁范围）。

用法：
    python scripts/check-archive-pii.py            # 默认扫描 sample_docs
    python scripts/check-archive-pii.py --path DIR # 其他目录（复用同一套规则）

退出码：0 = 干净；1 = 有命中（打印 文件:行 + 类型 + 打码值）。
设计说明：脚本**不写入任何真实值**（脱敏映射一次性执行后删除），只保留占位符白名单，
因此本文件本身可以公开。
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_DIR = REPO / "archive" / "2026-09-trade-doc-xprime-python" / "sample_docs"

EMAIL_OK = {"***@***"}
PHONE_OK = {"+86-000-0000000", "+61-0-0000-0000"}
COMPANY_OK = {"ACME WIRE MESH PRODUCTS CO., LTD.", "Example Fencing Pty Ltd"}

EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+")
PHONE_RE = re.compile(r"\+\d[\d\s\-()]{6,}\d")
ACCT_RE = re.compile(r"A/C\s*[:：]?\s*([\d ]{8,})")
COMPANY_RE = re.compile(
    r"[A-Z][A-Za-z0-9&.,'()\- ]{2,}?(?:CO\.,?\s*LTD\.?|PTY\s+LTD\.?|LLC|INC\.|LIMITED)"
)
CN_COMPANY_RE = re.compile(r"[\u4e00-\u9fa5]{2,}(?:有限责任公司|股份有限公司|有限公司)")
CN_MOBILE_RE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
ID18_RE = re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")


def mask(value: str) -> str:
    value = value.strip()
    if len(value) <= 4:
        return value[0] + "***"
    return value[:3] + "***" + value[-2:]


def scan_file(path: Path) -> list[tuple[int, str, str]]:
    hits: list[tuple[int, str, str]] = []
    text = path.read_text(encoding="utf-8")
    for lineno, line in enumerate(text.splitlines(), 1):
        for m in EMAIL_RE.finditer(line):
            if m.group(0) not in EMAIL_OK:
                hits.append((lineno, "email", m.group(0)))
        for m in PHONE_RE.finditer(line):
            if m.group(0) not in PHONE_OK:
                hits.append((lineno, "phone", m.group(0)))
        for m in ACCT_RE.finditer(line):
            digits = re.sub(r"\D", "", m.group(1))
            if digits and set(digits) != {"0"}:
                hits.append((lineno, "bank_account", m.group(1)))
        for m in COMPANY_RE.finditer(line):
            # 允许 "For and on behalf of <占位公司>" 这类前缀：按后缀匹配占位符白名单
            if not any(m.group(0).strip().endswith(ok) for ok in COMPANY_OK):
                hits.append((lineno, "company", m.group(0)))
        for m in CN_COMPANY_RE.finditer(line):
            hits.append((lineno, "cn_company", m.group(0)))
        for m in CN_MOBILE_RE.finditer(line):
            hits.append((lineno, "cn_mobile", m.group(0)))
        for m in ID18_RE.finditer(line):
            hits.append((lineno, "id18", m.group(0)))
    return hits


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", default=str(DEFAULT_DIR))
    args = ap.parse_args()
    target = Path(args.path)
    if not target.is_absolute():
        target = REPO / target
    if not target.is_dir():
        print(f"FAIL: 目录不存在: {target}")
        return 1
    files = sorted(target.glob("*.html"))
    if not files:
        print(f"FAIL: {target} 下没有 .html 文件（口径变了？）")
        return 1
    total = 0
    for f in files:
        for lineno, kind, value in scan_file(f):
            total += 1
            print(f"{f.relative_to(REPO)}:{lineno}: [{kind}] {mask(value)}")
    if total:
        print(f"FAIL: 归档样例仍有 {total} 处疑似 PII（口径见 docs/SECURITY_READONLY_AUDIT_2026-10-23.md）")
        return 1
    print(f"PASS: {len(files)} 份归档样例无 PII 命中（占位符口径一致）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
