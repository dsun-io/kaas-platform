import re

_SYSTEM_HINTS = (
    "订单",
    "物流",
    "退款",
    "已发货",
    "已签收",
    "支付成功",
    "系统消息",
    "淘宝通知",
    "天猫通知",
    "旺旺消息",
    "邀请下单",
    "催付",
    "卡片消息",
    "[交易",
    "【交易",
    "您购买的",
    "商品快照",
    "退换货",
    "维权",
)


def is_system_message(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    if len(t) > 2000:
        return True
    for h in _SYSTEM_HINTS:
        if h in t:
            return True
    return False


_TIME_TAIL = re.compile(
    r"(?:\s|^)(\d{1,2}:\d{2}(?::\d{2})?)\s*$"
)


def extract_time_token(text: str) -> str | None:
    m = _TIME_TAIL.search((text or "").strip())
    return m.group(1) if m else None


def normalize_buyer_id(raw: str) -> str:
    s = (raw or "").strip()
    s = re.sub(r"\s+", " ", s)
    return s or "unknown_buyer"


def fingerprint_key(buyer_id: str, message: str, time_token: str | None) -> str:
    msg = (message or "").strip()
    tt = time_token if time_token else "__no_ts__"
    return f"{buyer_id}\x1f{msg}\x1f{tt}"
