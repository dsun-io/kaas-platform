#!/usr/bin/env python
"""归档样例 / 归档文档 PII 回归门禁（2026-10-23 用户裁决：18 份高危样例 + docs/archive 中危项）。

覆盖两类目标：
1. archive/2026-09-trade-doc-xprime-python/sample_docs/ —— 18 份真实单据样例（2026-10-23 已脱敏）
2. docs/archive/** —— 历史审计/交接文档（2026-10-23 第二阶段脱敏）

判据：不得出现真实邮箱 / 国际电话 / 中国手机号 / 18 位身份证 / 真实公司名；
金额、品名、单据号、日期、地名、银行机构名等业务数据按裁决保留。

用法：
    python scripts/check-archive-pii.py                 # 默认扫两个目录
    python scripts/check-archive-pii.py --path DIR      # 只扫指定目录（复用同一套规则）

退出码：0 = 干净；1 = 有命中（打印 文件:行 + 类型 + 打码值）。

设计说明：脚本**不写入任何真实值**，只保留占位符白名单，因此本文件可公开。
局限（写明）：人名/地址/银行账号无法通用识别（脱敏时用一次性映射处理过），
正则只能兜住"再次被写回来"的邮箱/电话/手机号/身份证/公司名。
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SAMPLE_DIR = REPO / "archive" / "2026-09-trade-doc-xprime-python" / "sample_docs"
DOCS_ARCHIVE = REPO / "docs" / "archive"
TEXT_SUFFIXES = {".md", ".txt", ".json", ".html", ".py", ".yml", ".yaml", ".csv"}

# ── 允许值（占位符 / 公开信息 / 明显假值）─────────────────────────────────
EMAIL_ALLOW_DOMAINS = {
    "example.com",          # 本次脱敏统一占位域
    "localhost",            # 本地开发 DSN/账号
    "kaas.dev",             # 项目开发示例域
    "qa.kaas.internal",     # QA 内部示例账号
    "kaas.local",           # e2e 本地示例
    "send.powervoy.com",    # 系统发件域（公开，非个人）
    "db.prisma.io",         # 文档里的 Prisma 示例
    "127.0.0.1",            # 本地 DSN 示例
    "b.co",                 # 文档里明显假地址 a@b.co
    "evil.com",             # 安全审计里的 SSRF 外链白名单边界示例（user@evil.com），非真实地址
}
EMAIL_ALLOW_EXACT = {"***@***"}
PHONE_OK = {"+86-000-0000000", "+86 000 0000 0000", "+61-0-0000-0000", "+61 000 000 000"}
COMPANY_OK = {
    "ACME WIRE MESH PRODUCTS CO., LTD.",
    "ACME TRADING CO., LTD.",
    "Example Fencing Pty Ltd",
    "中国建设银行股份有限公司",  # 公开银行机构名（不属个人身份信息）
}

# 中文公司名：排除明显是普通指代的前缀，避免误报（本|该|贵|对方|买方|卖方|客户|别的…）
CN_COMPANY_RE = re.compile(
    r"(?<![\u4e00-\u9fa5])(?!本|该|贵|对方|买方|卖方|客户|别的|其他|某|推出|有则|中文|注册页|产品图|报价时|个文件|表单|客户方|海运|签发|正本|正式)"
    r"[\u4e00-\u9fa5]{2,12}(?:有限责任公司|股份有限公司|有限公司)"
)
EN_COMPANY_RE = re.compile(
    r"[A-Z][A-Za-z0-9&.,'()\- ]{2,}?(?:CO\.,?\s*LTD\.?|PTY\s+LTD\.?|LLC|INC\.)"
)
EMAIL_RE = re.compile(r"[\w.+-]+@(?:[\w-]+\.)+[A-Za-z]{2,}")
PHONE_RE = re.compile(r"\+\d{1,3}[\d\s\-()]{6,}\d")
CN_MOBILE_RE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
ID18_RE = re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")


def mask(value: str) -> str:
    value = value.strip()
    return value if len(value) <= 4 else value[:3] + "***" + value[-2:]


def scan_file(path: Path) -> list[tuple[int, str, str]]:
    hits: list[tuple[int, str, str]] = []
    text = path.read_text(encoding="utf-8", errors="replace")
    for lineno, line in enumerate(text.splitlines(), 1):
        for m in EMAIL_RE.finditer(line):
            email = m.group(0)
            domain = email.rsplit("@", 1)[-1]
            if email in EMAIL_ALLOW_EXACT or domain in EMAIL_ALLOW_DOMAINS:
                continue
            hits.append((lineno, "email", email))
        for m in PHONE_RE.finditer(line):
            if m.group(0).strip() in PHONE_OK or set(re.sub(r"\D", "", m.group(0))) <= {"0"}:
                continue
            hits.append((lineno, "phone", m.group(0)))
        for m in CN_MOBILE_RE.finditer(line):
            hits.append((lineno, "cn_mobile", m.group(0)))
        for m in ID18_RE.finditer(line):
            hits.append((lineno, "id18", m.group(0)))
        for m in CN_COMPANY_RE.finditer(line):
            value = m.group(0).strip()
            # 脱敏后的占位形态（某/某某/XX/***）一律放行；白名单机构名放行
            if any(tok in value for tok in ("某", "XX", "***", "**")) or value in COMPANY_OK:
                continue
            hits.append((lineno, "cn_company", value))
        for m in EN_COMPANY_RE.finditer(line):
            if not any(m.group(0).strip().endswith(ok) for ok in COMPANY_OK):
                hits.append((lineno, "en_company", m.group(0)))
    return hits


def scan_dir(root: Path) -> tuple[int, int]:
    files = sorted(p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in TEXT_SUFFIXES)
    total = 0
    for f in files:
        for lineno, kind, value in scan_file(f):
            total += 1
            print(f"{f.relative_to(REPO)}:{lineno}: [{kind}] {mask(value)}")
    return len(files), total


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", action="append", default=None,
                    help="只扫指定目录（可重复）；缺省扫 sample_docs + docs/archive")
    args = ap.parse_args()
    targets = [Path(p) for p in args.path] if args.path else [SAMPLE_DIR, DOCS_ARCHIVE]
    files = 0
    hits = 0
    for t in targets:
        if not t.is_absolute():
            t = REPO / t
        if not t.is_dir():
            print(f"FAIL: 目录不存在: {t}")
            return 1
        f, h = scan_dir(t)
        files += f
        hits += h
    if hits:
        print(f"FAIL: 归档文件仍有 {hits} 处疑似 PII（口径见 docs/SECURITY_READONLY_AUDIT_2026-10-23.md）")
        return 1
    print(f"PASS: {files} 个归档文本无 PII 命中（占位符口径一致）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
