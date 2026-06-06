import re

_SYSTEM_HINTS = (
    "订单",
    "物流",
    "退款",
    "已发货",
    "系统",
    "拼多多",
    "平台",
    "通知",
    "工单",
    "风险提示",
)

_LIKELY_QUESTION_TAIL = re.compile(r"[？?！!吗呢嘛吧呀么咯蛤呐]$")
_LIKELY_QUESTION_HINT = (
    "怎么",
    "什么",
    "多少",
    "为什么",
    "为啥",
    "请问",
    "有没有",
    "能不能",
    "可以吗",
    "行吗",
    "多久",
    "几天",
    "包邮",
    "有货",
    "订单",
    "物流",
    "退款",
)


def _looks_like_buyer_question(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    if _LIKELY_QUESTION_TAIL.search(t):
        return True
    for hint in _LIKELY_QUESTION_HINT:
        if hint in t:
            return True
    return False


def is_system_message(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    if len(t) > 2000:
        return True
    for h in _SYSTEM_HINTS:
        if h in t:
            if _looks_like_buyer_question(t) and len(t) >= 5:
                continue
            return True
    return False


def normalize_buyer_id(raw: str) -> str:
    s = re.sub(r"\s+", " ", (raw or "").strip())
    return s or "pdd_buyer"


def fingerprint(buyer_id: str, message: str, time_token: str | None) -> str:
    msg = (message or "").strip()
    tt = time_token if time_token else "__no_ts__"
    return f"{buyer_id}\x1f{msg}\x1f{tt}"
