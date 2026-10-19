"""数值模式：同一套公式可在 Decimal（业务）与 Fraction（独立核验）下求值。

- Decimal 模式：正式业务路径，按声明的小数位逐级落定
- Fraction 模式：核验路径，全程精确有理数、不做任何舍入，用于反证 Decimal 结果

两种模式共用同一份公式源码，因此"核验"是真正的独立重算，
而不是把同一段代码跑两遍。
"""
from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP, localcontext
from fractions import Fraction

PRECISION = 60


def dec(value) -> Decimal:
    """把标量转成 Decimal（走字符串，避免二进制浮点误差）。"""
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        raise TypeError("bool 不是数值")
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        return Decimal(repr(value))
    if isinstance(value, str):
        return Decimal(value.strip())
    raise TypeError(f"无法转换为 Decimal: {value!r}")


def frac(value) -> Fraction:
    """把标量转成 Fraction。经 Decimal 中转，保证 0.00617 这类小数精确。"""
    if isinstance(value, Fraction):
        return value
    return Fraction(dec(value))


def quantize(x: Decimal, nd: int | None) -> Decimal:
    """按小数位四舍五入（银行家舍入与业务预期不符，故用 HALF_UP）。"""
    if nd is None:
        return x
    return x.quantize(Decimal(1).scaleb(-nd), rounding=ROUND_HALF_UP)


def _round_half_up_int(f: Fraction) -> int:
    sign = -1 if f < 0 else 1
    a = -f if f < 0 else f
    q, r = divmod(a.numerator, a.denominator)
    if 2 * r >= a.denominator:
        q += 1
    return sign * q


def quantize_frac(x: Fraction, nd: int | None) -> Fraction:
    if nd is None:
        return x
    scale = 10**nd
    return Fraction(_round_half_up_int(x * scale), scale)


def to_decimal(x) -> Decimal:
    """把任意模式的结果还原成 Decimal，便于统一输出。"""
    if isinstance(x, Decimal):
        return x
    if isinstance(x, Fraction):
        with localcontext() as ctx:
            ctx.prec = PRECISION
            return Decimal(x.numerator) / Decimal(x.denominator)
    return dec(x)


def is_integral(x) -> bool:
    if isinstance(x, Fraction):
        return x.denominator == 1
    if isinstance(x, Decimal):
        return x == x.to_integral_value()
    return float(x).is_integer()


def _isqrt_exact(n: int):
    if n < 0:
        raise ValueError("负数不能开平方")
    r = int(n**0.5)
    for cand in (r - 1, r, r + 1):
        if cand >= 0 and cand * cand == n:
            return cand
    return None


class DecimalMode:
    """业务计算模式。"""

    name = "decimal"
    exact = False

    @staticmethod
    def convert(value):
        if isinstance(value, (bool, str)) or value is None:
            return value
        return dec(value)

    @staticmethod
    def divide(a, b):
        return a / b

    @staticmethod
    def power(a, b):
        if not is_integral(b):
            raise ValueError("Decimal 模式下指数必须是整数，非整数次幂请改用 sqrt()")
        return a ** int(b)

    @staticmethod
    def floor(a):
        return a.to_integral_value(rounding="ROUND_FLOOR")

    @staticmethod
    def ceil(a):
        return a.to_integral_value(rounding="ROUND_CEILING")

    @staticmethod
    def sqrt(a):
        return a.sqrt()

    @staticmethod
    def quantize(a, nd):
        return quantize(a, nd)

    @staticmethod
    def to_decimal(a):
        return a


class FractionMode:
    """核验模式：全程精确有理数，不做任何舍入。"""

    name = "fraction"
    exact = True

    @staticmethod
    def convert(value):
        if isinstance(value, (bool, str)) or value is None:
            return value
        return frac(value)

    @staticmethod
    def divide(a, b):
        return Fraction(a, b)

    @staticmethod
    def power(a, b):
        if not is_integral(b):
            raise ValueError("Fraction 模式下指数必须是整数")
        return a ** int(b)

    @staticmethod
    def floor(a):
        return Fraction(a.numerator // a.denominator)

    @staticmethod
    def ceil(a):
        return Fraction(-((-a.numerator) // a.denominator))

    @staticmethod
    def sqrt(a):
        n = _isqrt_exact(a.numerator)
        d = _isqrt_exact(a.denominator)
        if n is None or d is None:
            raise ValueError("Fraction 模式下 sqrt 仅支持完全平方数（否则核验失真）")
        return Fraction(n, d)

    @staticmethod
    def quantize(a, nd):
        return quantize_frac(a, nd)

    @staticmethod
    def to_decimal(a):
        return to_decimal(a)


DECIMAL = DecimalMode()
FRACTION = FractionMode()
