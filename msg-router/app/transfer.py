from dataclasses import dataclass

_TRANSFER_KEYWORDS = ("转人工", "找人工", "真人", "人工客服")

_TRANSFER_REPLY = "已为您记录，正在为您转接人工客服，请稍候。"


@dataclass(frozen=True)
class TransferCheckResult:
    should_transfer: bool
    standard_reply: str | None = None


def check_transfer_intent(text: str) -> TransferCheckResult:
    if not text:
        return TransferCheckResult(False)
    normalized = text.strip()
    for kw in _TRANSFER_KEYWORDS:
        if kw in normalized:
            return TransferCheckResult(True, _TRANSFER_REPLY)
    return TransferCheckResult(False)
