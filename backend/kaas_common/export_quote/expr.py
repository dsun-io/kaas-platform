"""安全的算术表达式求值器。

设计目标：让「重量 / 体积 / 报价」等公式写在配置里而不是代码里，
换产品、换口径都不需要改程序。

安全性：只解析表达式（mode='eval'），只放行白名单内的运算符与函数，
不执行属性访问、下标、lambda、推导式、import。

数值模式：同一表达式可在 Decimal（业务）或 Fraction（精确核验）下求值，
见 numeric.py。非整数指数、无理数开方在 Fraction 模式下会被拒绝，
以免"看起来核验通过"实则失真。
"""
from __future__ import annotations

import ast
from decimal import localcontext

from .numeric import DECIMAL, FRACTION, PRECISION, dec, is_integral


class ExpressionError(ValueError):
    """表达式非法或求值失败。"""


_BIN_OPS = {
    ast.Add: "add",
    ast.Sub: "sub",
    ast.Mult: "mul",
    ast.Div: "div",
    ast.FloorDiv: "floordiv",
    ast.Mod: "mod",
    ast.Pow: "pow",
}

_CMP_OPS = {
    ast.Lt: "lt",
    ast.LtE: "le",
    ast.Gt: "gt",
    ast.GtE: "ge",
    ast.Eq: "eq",
    ast.NotEq: "ne",
}

_FUNCTIONS = ("min", "max", "abs", "round", "floor", "ceil", "sqrt")


class _Evaluator:
    def __init__(self, mode, scope):
        self.mode = mode
        self.scope = scope

    def _binop(self, node):
        op = type(node.op)
        if op not in _BIN_OPS:
            raise ExpressionError(f"不允许的运算符: {op.__name__}")
        name = _BIN_OPS[op]
        if name == "div":
            return self.mode.divide(self.eval(node.left), self.eval(node.right))
        if name == "pow":
            return self.mode.power(self.eval(node.left), self.eval(node.right))
        left, right = self.eval(node.left), self.eval(node.right)
        if name == "add":
            return left + right
        if name == "sub":
            return left - right
        if name == "mul":
            return left * right
        if name == "floordiv":
            return self.mode.floor(self.mode.divide(left, right))
        if name == "mod":
            return left - self.mode.floor(self.mode.divide(left, right)) * right
        raise ExpressionError(f"未实现: {name}")

    def _unary(self, node):
        if isinstance(node.op, ast.UAdd):
            return +self.eval(node.operand)
        if isinstance(node.op, ast.USub):
            return -self.eval(node.operand)
        if isinstance(node.op, ast.Not):
            return not self._truth(self.eval(node.operand))
        raise ExpressionError("不允许的一元运算符")

    def _compare(self, node):
        left = self.eval(node.left)
        for op_node, right_node in zip(node.ops, node.comparators):
            op = type(op_node)
            if op not in _CMP_OPS:
                raise ExpressionError("不允许的比较运算符")
            right = self.eval(right_node)
            name = _CMP_OPS[op]
            ok = {
                "lt": left < right,
                "le": left <= right,
                "gt": left > right,
                "ge": left >= right,
                "eq": left == right,
                "ne": left != right,
            }[name]
            if not ok:
                return False
            left = right
        return True

    def _call(self, node):
        if not isinstance(node.func, ast.Name):
            raise ExpressionError(f"只允许调用内置函数: {', '.join(_FUNCTIONS)}")
        fname = node.func.id
        if fname not in _FUNCTIONS:
            raise ExpressionError(f"不允许的函数: {fname}")
        if node.keywords:
            raise ExpressionError("函数不支持关键字参数")
        return self._apply(fname, [self.eval(a) for a in node.args])

    def _apply(self, fname, args):
        if fname == "min":
            return min(args)
        if fname == "max":
            return max(args)
        if fname == "abs":
            return abs(args[0])
        if fname == "sqrt":
            return self.mode.sqrt(args[0])
        if fname == "floor":
            return self.mode.floor(args[0])
        if fname == "ceil":
            return self.mode.ceil(args[0])
        if fname == "round":
            if len(args) == 1:
                digits = 0
            else:
                if not is_integral(args[1]):
                    raise ExpressionError("round 的小数位数必须是整数")
                digits = int(args[1])
            return self.mode.quantize(args[0], digits)
        raise ExpressionError(f"未实现的函数: {fname}")

    @staticmethod
    def _truth(value):
        if isinstance(value, str):
            return bool(value)
        return value != 0

    def eval(self, node):
        if isinstance(node, ast.Expression):
            return self.eval(node.body)
        if isinstance(node, ast.Constant):
            v = node.value
            if isinstance(v, (bool, str, int, float)):
                return self.mode.convert(v)
            raise ExpressionError(f"不允许的常量类型: {v!r}")
        if isinstance(node, ast.Name):
            if node.id not in self.scope:
                raise ExpressionError(f"未定义变量: {node.id}")
            return self.scope[node.id]
        if isinstance(node, ast.BinOp):
            return self._binop(node)
        if isinstance(node, ast.UnaryOp):
            return self._unary(node)
        if isinstance(node, ast.Compare):
            return self._compare(node)
        if isinstance(node, ast.BoolOp):
            values = [self.eval(v) for v in node.values]
            if isinstance(node.op, ast.And):
                return all(self._truth(v) for v in values)
            if isinstance(node.op, ast.Or):
                return any(self._truth(v) for v in values)
            raise ExpressionError("不允许的逻辑运算符")
        if isinstance(node, ast.IfExp):
            if self._truth(self.eval(node.test)):
                return self.eval(node.body)
            return self.eval(node.orelse)
        if isinstance(node, ast.Call):
            return self._call(node)
        raise ExpressionError(f"不允许的语法: {type(node).__name__}")


class Formula:
    """预编译的表达式。"""

    def __init__(self, source: str):
        self.source = source
        try:
            self.tree = ast.parse(source, mode="eval")
        except SyntaxError as exc:
            raise ExpressionError(f"表达式语法错误 {source!r}: {exc}") from exc

    def evaluate(self, scope, mode=DECIMAL):
        prepared = self._prepare_scope(scope, mode)
        with localcontext() as ctx:
            ctx.prec = PRECISION
            try:
                return _Evaluator(mode, prepared).eval(self.tree)
            except ExpressionError:
                raise
            except ValueError as exc:
                raise ExpressionError(f"表达式 {self.source!r} 求值失败: {exc}") from exc

    def _prepare_scope(self, scope, mode):
        """把配置里的标量转成当前数值模式的类型。

        带引号的数值（YAML 里常见，如 "0.10"）会被识别成数值，
        否则 a * b 会因为 str * Decimal 抛出难以理解的错误。
        名为 name 的键一律保持字符串，避免把规格名 "2.5" 误当数字。
        """
        out = {}
        for key, value in scope.items():
            if value is None or isinstance(value, bool):
                out[key] = value
                continue
            if isinstance(value, str):
                if key == "name":
                    out[key] = value
                    continue
                try:
                    out[key] = mode.convert(dec(value))
                except Exception:  # noqa: BLE001 - 非数值字符串原样保留
                    out[key] = value
                continue
            out[key] = mode.convert(value)
        return out

    def __repr__(self):
        return f"Formula({self.source!r})"


_cache: dict[str, Formula] = {}


def compile_formula(source: str | Formula) -> Formula:
    if isinstance(source, Formula):
        return source
    if source not in _cache:
        _cache[source] = Formula(source)
    return _cache[source]


def evaluate(source: str | Formula, scope, mode=DECIMAL):
    return compile_formula(source).evaluate(scope, mode)
