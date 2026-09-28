"""税务档案（RateSet）与出口退税率查询。

为什么要把法定税率做成"档案"而不是几个配置项
------------------------------------------------
国家的税率会变（印花税 5%→6%、增值税 13%→12%、出口退税率调整）。
如果税率散落在每份报价单里，政策一变就要翻出历史单子逐个改，
历史报价也就无法复现。

所以做法是：
  1. 法定税率集中在 `rate_sets/*.yaml`，每份档案带 **生效日期**
  2. 报价单只引用档案编号（如 `CN-2026-09`）
  3. 政策变化 → **新增**一份档案，不改旧文件
     ⇒ 三月出的单子在九月仍能逐分复现，历史报价永不被污染
  4. 报价政策里显式填的税率表示"本单覆盖"，缺省（None）则继承档案

关于出口退税率的自动查询
------------------------
退税率按产品的 HS 编码确定，国家会调整。查询接口设计为**可插拔 Provider**：

  - `LocalLibraryProvider`：读取档案里的 `export_rebate.by_hs_code` 表（离线可用，
    也是其它 provider 失败时的兜底）
  - `HttpRebateProvider`：调用外部查询服务（见 settings 的 REBATE_RATE_API_URL /
    REBATE_RATE_API_KEY）。**需要自己订阅或自建**：目前没有面向公众、免鉴权、
    长期稳定的官方退税率 API（中国国际贸易单一窗口、税务总局的退税率文库
    都需要资质与鉴权）。因此这里只提供标准接口与调用约定，
    接入哪家服务由部署方决定。
  - `CachedProvider`：TTL 缓存，避免高频重复查询与限流
  - 组合顺序：HTTP → 本地库 → 报错

**失败时不猜**：查不到就抛 `RebateRateNotFound`，由业务确认。
猜一个退税率会让整张报价单系统性偏低，是这里最贵的错误。
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable, Mapping, Protocol, runtime_checkable

from .numeric import dec

logger = logging.getLogger(__name__)

RATE_SETS_DIR = Path(__file__).parent / "rate_sets"


class RateSetError(ValueError):
    """税务档案不合法。"""


class RebateRateNotFound(LookupError):
    """退税率查不到 —— 明确报错，不猜。"""


# ─────────────────────────────────────────────────────────────────────────────
# 税务档案
# ─────────────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class StampDuty:
    """印花税：默认按加工利润计征，税率与基数都可调。"""

    rate: Any = 0
    base: str = "profit"  # profit | cost | base_quote

    @property
    def summary(self) -> str:
        base_label = {
            "profit": "加工利润",
            "cost": "税前成本",
            "base_quote": "基础报价",
        }.get(self.base, self.base)
        return f"{base_label} × {float(self.rate):.2%}" if self.rate else "未配置"


@dataclass(frozen=True)
class RateSet:
    """一份税务档案：某国某时段的法定税率集合。"""

    code: str
    name: str = ""
    country: str = ""
    effective_from: date | None = None
    effective_to: date | None = None
    source: str = ""

    output_rate_default: Any = None  # 默认销项税率
    output_rate_export: Any = 0  # 出口零税率
    output_rate_reduced: Any = None  # 低税率档

    stamp_duty: StampDuty = field(default_factory=StampDuty)

    rebate_by_hs: Mapping[str, Any] = field(default_factory=dict)
    rebate_default: Any = None  # 未收录时的兜底；None 表示不猜
    rebate_source: str = ""

    notes: tuple = ()

    # ---------- 生效期 ----------
    def covers(self, when: date) -> bool:
        if self.effective_from and when < self.effective_from:
            return False
        if self.effective_to and when > self.effective_to:
            return False
        return True

    def lookup_rebate(self, hs_code: str | None):
        """按 HS 编码取退税率；查不到返回 None（由调用方决定是否报错）。"""
        if hs_code:
            key = normalize_hs(hs_code)
            if key in self.rebate_by_hs:
                return self.rebate_by_hs[key]
            # 支持前缀匹配（HS 前 8 位/10 位口径不同）
            for k, v in self.rebate_by_hs.items():
                if key.startswith(k) or k.startswith(key):
                    return v
        return self.rebate_default

    def warnings(self) -> list[str]:
        out: list[str] = []
        if self.stamp_duty.rate is None:
            out.append(f"档案 {self.code} 未配置印花税率")
        if not self.rebate_by_hs and self.rebate_default is None:
            out.append(
                f"档案 {self.code} 既没有 HS 退税率表、也没有默认退税率："
                "退税率查询会失败（这是刻意的，避免猜错导致报价整体偏低）"
            )
        return out


def normalize_hs(hs_code: str) -> str:
    """HS 编码归一到纯数字字符串。"""
    return "".join(ch for ch in str(hs_code) if ch.isdigit())


def _as_date(value) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    return datetime.strptime(str(value), "%Y-%m-%d").date()


def rate_set_from_dict(raw: Mapping[str, Any]) -> RateSet:
    vat = raw.get("vat") or {}
    rebate = raw.get("export_rebate") or {}
    stamp_raw = raw.get("stamp_duty") or {}
    table = {
        normalize_hs(k): v for k, v in (rebate.get("by_hs_code") or {}).items()
    }
    return RateSet(
        code=str(raw.get("code") or ""),
        name=str(raw.get("name") or ""),
        country=str(raw.get("country") or ""),
        effective_from=_as_date(raw.get("effective_from")),
        effective_to=_as_date(raw.get("effective_to")),
        source=str(raw.get("source") or ""),
        output_rate_default=vat.get("output_rate_default"),
        output_rate_export=vat.get("output_rate_export", 0),
        output_rate_reduced=vat.get("output_rate_reduced"),
        stamp_duty=StampDuty(
            rate=stamp_raw.get("rate"),
            base=str(stamp_raw.get("base", "profit")),
        ),
        rebate_by_hs=table,
        rebate_default=rebate.get("default"),
        rebate_source=str(rebate.get("source") or ""),
        notes=tuple(raw.get("notes") or ()),
    )


class RateSetRegistry:
    """税务档案注册表：按编号或日期解析。"""

    def __init__(self, rate_sets: Iterable[RateSet]):
        self._by_code: dict[str, RateSet] = {}
        for rs in rate_sets:
            if not rs.code:
                raise RateSetError("税务档案缺少 code")
            self._by_code[rs.code] = rs

    @classmethod
    def from_dir(cls, directory: Path | str | None = None) -> "RateSetRegistry":
        base = Path(directory) if directory else RATE_SETS_DIR
        sets: list[RateSet] = []
        if base.is_dir():
            # 同时支持 .json 与 .yaml：
            #   · 开发后端（CPython）用 yaml，历史文件不动；
            #   · 线上 Worker（Pyodide）**装不了/不该装 yaml**，镜像里只放 .json。
            # 因此 yaml 的 import 必须**惰性**（写在分支里）—— 顶层 import yaml
            # 会让整个引擎在 Worker 里根本导不进来，这是本次移植的第一个硬障碍。
            for path in sorted(base.iterdir()):
                suffix = path.suffix.lower()
                if suffix not in (".json", ".yaml", ".yml"):
                    continue
                with path.open("r", encoding="utf-8") as fh:
                    if suffix == ".json":
                        raw = json.load(fh) or {}
                    else:
                        import yaml  # noqa: PLC0415 - 惰性：仅在读到 yaml 时才需要

                        raw = yaml.safe_load(fh) or {}
                rs = rate_set_from_dict(raw)
                if not rs.code:
                    rs = RateSet(**{**rs.__dict__, "code": path.stem})
                sets.append(rs)
        if not sets:
            raise RateSetError(f"未找到任何税务档案: {base}")
        return cls(sets)

    @property
    def codes(self) -> list[str]:
        return sorted(self._by_code)

    def all(self) -> list[RateSet]:
        return [self._by_code[c] for c in self.codes]

    def get(self, code: str) -> RateSet:
        rs = self._by_code.get(code)
        if rs is None:
            raise RateSetError(
                f"未找到税务档案 {code!r}；可用: {', '.join(self.codes)}"
            )
        return rs

    def resolve(self, code: str | None, when: date | None = None) -> RateSet:
        """按编号取档案；编号为空则按日期取当前生效的一份。"""
        if code:
            rs = self.get(code)
            if when and not rs.covers(when):
                raise RateSetError(
                    f"税务档案 {code} 的生效期 {rs.effective_from} ~ {rs.effective_to} "
                    f"不覆盖 {when}，请改用当时生效的档案"
                )
            return rs
        when = when or date.today()
        candidates = [rs for rs in self.all() if rs.covers(when)]
        if not candidates:
            raise RateSetError(f"{when} 没有生效的税务档案")
        # 生效日最晚的一份优先
        candidates.sort(key=lambda r: (r.effective_from or date.min), reverse=True)
        return candidates[0]


# ─────────────────────────────────────────────────────────────────────────────
# 退税率查询 Provider
# ─────────────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class RebateResult:
    """退税率查询结果（带来源，便于审计）。"""

    hs_code: str
    rebate_rate: Any
    source: str
    cached: bool = False


@runtime_checkable
class RebateRateProvider(Protocol):
    """退税率查询接口。查不到应抛 RebateRateNotFound，而不是返回猜测值。"""

    async def lookup(self, hs_code: str) -> RebateResult:  # pragma: no cover - 协议
        ...


class LocalLibraryProvider:
    """本地库：读税务档案的 HS 退税率表。离线可用、无外部依赖。"""

    name = "rate_set"

    def __init__(self, rate_set: RateSet):
        self.rate_set = rate_set

    async def lookup(self, hs_code: str) -> RebateResult:
        value = self.rate_set.lookup_rebate(hs_code)
        if value is None:
            raise RebateRateNotFound(
                f"税务档案 {self.rate_set.code} 未收录 HS {hs_code} 的出口退税率，"
                "请补充档案或人工确认后填入报价单"
            )
        return RebateResult(
            hs_code=normalize_hs(hs_code),
            rebate_rate=value,
            source=f"rate_set:{self.rate_set.code}",
        )


class HttpRebateProvider:
    """HTTP 查询：接入部署方订阅的退税率服务。

    约定：GET {base_url}?hs_code=XXXX  →
        {"rebate_rate": 0.10, "source": "..."}  或  {"data": {...}}

    没有面向公众、免鉴权、长期稳定的官方退税率 API，因此 base_url 与密钥
    由部署方通过 settings 配置；未配置时本 provider 直接报"未启用"。
    """

    name = "http"

    def __init__(self, base_url: str, api_key: str = "", timeout: float = 8.0):
        self.base_url = (base_url or "").strip()
        self.api_key = api_key or ""
        self.timeout = timeout

    @property
    def enabled(self) -> bool:
        return bool(self.base_url)

    async def lookup(self, hs_code: str) -> RebateResult:
        if not self.enabled:
            raise RebateRateNotFound("未配置 REBATE_RATE_API_URL，HTTP 退税率查询未启用")

        # httpx 与 retry_request 都**只能惰性导入**：
        #   · 线上 Worker（Pyodide）里没有 httpx，也没有 app.services.* 这个包路径；
        #   · 只有显式配置了 REBATE_RATE_API_URL 才会走到这里。
        # 所以这里把 ImportError 翻译成业务异常 —— 否则线上只会得到一个看不懂的
        # ModuleNotFoundError，而"退税率查不到"本就是一个明确的业务结论。
        try:
            import httpx

            from app.services.http_utils import retry_request
        except ImportError as exc:  # pragma: no cover - 仅 Worker/裁剪环境触发
            raise RebateRateNotFound(
                "当前运行环境不支持 HTTP 退税率查询（未内置 httpx），请改用本地退税表"
            ) from exc

        headers = {"Accept": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        url = self.base_url
        params = {"hs_code": normalize_hs(hs_code)}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await retry_request(client, "GET", url, headers=headers, params=params)
        if resp.status_code >= 400:
            raise RebateRateNotFound(
                f"退税率服务返回 {resp.status_code}: {resp.text[:200]}"
            )
        payload = resp.json() if resp.content else {}
        data = payload.get("data") if isinstance(payload, dict) else None
        node = data if isinstance(data, dict) else payload
        value = None
        if isinstance(node, dict):
            for k in ("rebate_rate", "rebateRate", "rate", "rebate"):
                if node.get(k) is not None:
                    value = node[k]
                    break
        if value is None:
            raise RebateRateNotFound(
                f"退税率服务未返回 rebate_rate 字段（HS {hs_code}）: {str(payload)[:200]}"
            )
        return RebateResult(
            hs_code=normalize_hs(hs_code),
            rebate_rate=value,
            source=str((node or {}).get("source") or f"http:{self.base_url}"),
        )


class CachedProvider:
    """给任意 provider 加 TTL 缓存，降低外部调用频率。"""

    name = "cached"

    def __init__(self, inner: RebateRateProvider, ttl_seconds: int = 24 * 3600):
        self.inner = inner
        self.ttl = timedelta(seconds=ttl_seconds)
        self._cache: dict[str, tuple[datetime, RebateResult]] = {}
        # 负缓存：避免反复打一个查不到的外部接口
        self._misses: dict[str, datetime] = {}

    @property
    def enabled(self) -> bool:
        return provider_enabled(self.inner)

    @property
    def source_label(self) -> str:
        return provider_source_label(self.inner)

    def __repr__(self) -> str:  # pragma: no cover - 便于排查
        return f"CachedProvider({self.source_label}, ttl={self.ttl})"

    async def lookup(self, hs_code: str) -> RebateResult:
        key = normalize_hs(hs_code)
        now = datetime.now(timezone.utc)
        hit = self._cache.get(key)
        if hit and now - hit[0] < self.ttl:
            prev = hit[1]
            return RebateResult(prev.hs_code, prev.rebate_rate, prev.source, cached=True)
        miss_at = self._misses.get(key)
        if miss_at and now - miss_at < self.ttl:
            raise RebateRateNotFound(f"HS {key} 近期查询失败（负缓存内不再重试）")
        try:
            result = await self.inner.lookup(hs_code)
        except RebateRateNotFound:
            self._misses[key] = now
            raise
        self._cache[key] = (now, result)
        return result

    def clear(self) -> None:
        self._cache.clear()
        self._misses.clear()


class ChainProvider:
    """按顺序尝试多个 provider，全部失败才抛错。"""

    name = "chain"

    def __init__(self, providers: Iterable[RebateRateProvider]):
        self.providers = [p for p in providers if p is not None]

    @property
    def enabled(self) -> bool:
        return any(provider_enabled(p) for p in self.providers)

    @property
    def source_label(self) -> str:
        return " → ".join(provider_source_label(p) for p in self.providers)

    def __repr__(self) -> str:  # pragma: no cover - 便于排查
        return f"ChainProvider({self.source_label})"

    async def lookup(self, hs_code: str) -> RebateResult:
        errors: list[str] = []
        for p in self.providers:
            try:
                return await p.lookup(hs_code)
            except RebateRateNotFound as exc:
                errors.append(f"{getattr(p, 'name', type(p).__name__)}: {exc}")
            except Exception as exc:  # noqa: BLE001 - 外部服务异常不应中断兜底
                logger.warning("退税率 provider %s 异常: %s", getattr(p, "name", p), exc)
                errors.append(f"{getattr(p, 'name', type(p).__name__)}: {exc}")
        raise RebateRateNotFound(
            f"HS {hs_code} 的出口退税率在所有来源都查不到；"
            "请人工确认后填入报价单。明细: " + " | ".join(errors)
        )


def provider_enabled(provider) -> bool:
    """该 provider 当下是否能取到值（HTTP 未配置 URL 时为 False）。"""
    flag = getattr(provider, "enabled", None)
    if isinstance(flag, bool):
        return flag
    return provider is not None


def provider_source_label(provider) -> str:
    """可读的来源标签，用于诊断与接口回显。"""
    for attr in ("source_label", "name"):
        value = getattr(provider, attr, None)
        if isinstance(value, str) and value:
            return value
    return type(provider).__name__


def build_default_provider(
    rate_set: RateSet,
    api_url: str = "",
    api_key: str = "",
    ttl_seconds: int = 24 * 3600,
) -> RebateRateProvider:
    """默认组合：HTTP（若已配置）→ 本地档案库，整体带缓存。"""
    chain = ChainProvider(
        [HttpRebateProvider(api_url, api_key), LocalLibraryProvider(rate_set)]
    )
    return CachedProvider(chain, ttl_seconds=ttl_seconds)
