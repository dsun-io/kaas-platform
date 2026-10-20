"""`doc_set_items.trigger_expr` 的**受限安全求值器**（A12，纯 stdlib）。

为什么需要它
------------
`trade_doc_doc_set_items.trigger_expr` 从 A7 起就只存不求值（清单里一项单证
"在什么条件下才该出"）。典型场景：**无木质包装就不出非木质包装声明**
（`wood_packing == false` 时 PD 声明不适用）。没有求值器时，清单只能把
`trigger_expr` 原样回给界面，既不判断适用性、也拦不住写坏的表达式。

安全边界（**本模块绝不使用 `eval` / `exec`**）
-----------------------------------------------
手写「词法分析 → 递归下降解析 → 解释执行」三层，语言被刻意做小：

    表达式   := or
    or       := and ("or" and)*
    and      := not ("and" not)*
    not      := "not" not | comparison
    comparison := primary (("=="|"!="|">"|">="|"<"|"<="|"in"|"not" "in") primary)?
    primary  := "(" expr ")" | "[" list "]" | 字面量 | 事实键
    字面量    := 整数 | 浮点 | "字符串" | '字符串' | True/False/None
    事实键    := 标识符（可带点号路径，如 facts.packaging.has_wood）

- **没有任何副作用**：不调用函数、不做属性访问、不读写文件/环境；
- 只做比较与逻辑：没有算术表达式（除字面量前的负号）、没有下标/切片/推导式；
- 有**长度/记号/嵌套**上限（见 `MAX_EXPR_LENGTH` 等）⇒ 恶意超长表达式在解析前被拒，
  不会用栈深度或 CPU 拖死 Worker；
- 错误一律是**结构化** `TriggerError(code, message)`，API 层可直接放进 `detail`。

事实键的解析顺序（Kernel 支持嵌套与扁平两种 facts 形态）
--------------------------------------------------------
1. `facts.<a>.<b>`：先去掉可选前缀 `facts`，按**嵌套 dict** 逐段下钻；
2. 下钻失败 ⇒ 试**扁平点号键** `"<a>.<b>"`（`extract_facts` 产生的就是扁平键）；
3. 仍失败 ⇒ 试**最后一段**作为扁平键（`has_wood` 直查 facts）；
4. 都不在 ⇒ `TriggerError("TRIGGER_UNKNOWN_KEY")` —— **不猜默认值**，
   否则"写错键名"会静默变成"条件永远不成立"，那比报错危险得多。

值比较口径
----------
`extract_facts` 的 `Fact.value` 恒为**字符串**，所以比较要容忍数值/布尔的字符串形态：
- `==`/`!=`：布尔对布尔（含 `"true"/"false"` 形态）→ 布尔比较；两侧可转数值 → 数值比较；
  否则按字符串比较（事实值已归一）；
- `>`/`>=`/`<`/`<=`：**只允许数值**，否则 `TRIGGER_TYPE`（拿文本比大小基本是写错了）；
- `in`：右侧是列表字面量（成员判定）或字符串（子串判定）。

求值时机（调用方职责，内核不读库）
----------------------------------
- 写入：`validate_trigger(expr)` 只做**语法/复杂度**校验（允许未知键：键可能随 payload 演进）；
- 读取：`evaluate_trigger(expr, facts)` 才真正求值；未知键/类型错在读取时暴露；
- `resolve_doc_set(items, facts)` 把清单项标注成 `applicable` / `skipped_by_trigger` /
  `trigger_error`（**不删除**任何项 —— 清单是审计对象，跳过项也要能解释为什么跳过）。
"""
from __future__ import annotations

import re
from typing import Any, Iterable, Mapping, Optional, Sequence

# ── 错误码（API `detail.code` 直接复用；与内核其它码同一命名风格）───────────
TRIGGER_SYNTAX = "TRIGGER_SYNTAX"
TRIGGER_UNKNOWN_KEY = "TRIGGER_UNKNOWN_KEY"
TRIGGER_TYPE = "TRIGGER_TYPE"
TRIGGER_TOO_COMPLEX = "TRIGGER_TOO_COMPLEX"

# ── 复杂度上限（防恶意/误写超长表达式；正常业务表达式远小于此）─────────────
MAX_EXPR_LENGTH = 2000
MAX_TOKENS = 200
MAX_DEPTH = 32

_BOOL_TRUE = {"true", "yes", "y", "1", "on"}
_BOOL_FALSE = {"false", "no", "n", "0", "off", "none", "null", ""}
_NUMBER_RE = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)\Z")
_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_COMPARE_OPS = {"==", "!=", ">", ">=", "<", "<="}
_RESERVED = {"and", "or", "not", "in"}


class TriggerError(Exception):
    """触发条件表达式的**结构化**错误（内核不抛裸异常给 API）。"""

    def __init__(self, code: str, message: str, position: Optional[int] = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.position = position

    def as_dict(self) -> dict:
        data: dict = {"code": self.code, "message": self.message}
        if self.position is not None:
            data["position"] = self.position
        return data


# ── 词法分析 ───────────────────────────────────────────────────────────────

class _Token:
    __slots__ = ("kind", "value", "pos")

    def __init__(self, kind: str, value: Any, pos: int) -> None:
        self.kind = kind      # IDENT / STRING / NUMBER / KEYWORD / OP / LPAREN / ...
        self.value = value
        self.pos = pos

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return f"_Token({self.kind!r}, {self.value!r}, {self.pos})"


def _syntax(message: str, position: int) -> TriggerError:
    return TriggerError(TRIGGER_SYNTAX, message, position)


def _tokenize(expr: str) -> list[_Token]:
    tokens: list[_Token] = []
    i = 0
    length = len(expr)
    # 负号只在"该出现值"的位置当负号；其余位置是语法错（本语言没有减法）
    expect_value = True

    while i < length:
        ch = expr[i]

        if ch.isspace():
            i += 1
            continue

        if len(tokens) >= MAX_TOKENS:
            raise TriggerError(
                TRIGGER_TOO_COMPLEX,
                f"表达式记号过多（上限 {MAX_TOKENS}）",
                i,
            )

        if ch == "(":
            tokens.append(_Token("LPAREN", ch, i))
            i += 1
            expect_value = True
            continue
        if ch == ")":
            tokens.append(_Token("RPAREN", ch, i))
            i += 1
            expect_value = False
            continue
        if ch == "[":
            tokens.append(_Token("LBRACKET", ch, i))
            i += 1
            expect_value = True
            continue
        if ch == "]":
            tokens.append(_Token("RBRACKET", ch, i))
            i += 1
            expect_value = False
            continue
        if ch == ",":
            tokens.append(_Token("COMMA", ch, i))
            i += 1
            expect_value = True
            continue

        # 比较运算（两字符优先，避免 `>=` 被拆成 `>` + `=`）
        two = expr[i:i + 2]
        if two in ("==", "!=", ">=", "<="):
            tokens.append(_Token("OP", two, i))
            i += 2
            expect_value = True
            continue
        if ch in (">", "<"):
            tokens.append(_Token("OP", ch, i))
            i += 1
            expect_value = True
            continue
        if ch == "-":
            if not expect_value:
                raise _syntax("负号只能出现在值前面（本语言没有减法）", i)
            start = i
            number, i = _scan_number(expr, i)
            tokens.append(_Token("NUMBER", number, start))
            expect_value = False
            continue
        if ch == "+":
            if not expect_value:
                raise _syntax("正号只能出现在值前面", i)
            start = i
            number, i = _scan_number(expr, i)
            tokens.append(_Token("NUMBER", number, start))
            expect_value = False
            continue

        if ch.isdigit() or (ch == "." and i + 1 < length and expr[i + 1].isdigit()):
            start = i
            number, i = _scan_number(expr, i)
            tokens.append(_Token("NUMBER", number, start))
            expect_value = False
            continue

        if ch in ("'", '"'):
            start = i
            text, i = _scan_string(expr, i)
            tokens.append(_Token("STRING", text, start))
            expect_value = False
            continue

        match = _IDENT_RE.match(expr, i)
        if match:
            word = match.group(0)
            start = i
            i = match.end()
            # 点号路径：允许 `facts.packaging.has_wood` 这类事实键
            while i < length and expr[i] == ".":
                nxt = _IDENT_RE.match(expr, i + 1)
                if not nxt:
                    raise _syntax("点号后必须是标识符", i)
                word = f"{word}.{nxt.group(0)}"
                i = nxt.end()
            lowered = word.lower()
            if lowered in ("true", "false", "none", "null"):
                tokens.append(_Token("KEYWORD", lowered, start))
                expect_value = False
            elif lowered in _RESERVED:
                tokens.append(_Token("KEYWORD", lowered, start))
                expect_value = True
            else:
                tokens.append(_Token("IDENT", word, start))
                expect_value = False
            continue

        raise _syntax(f"无法识别的字符 {ch!r}", i)

    tokens.append(_Token("EOF", "", length))
    return tokens


def _scan_number(expr: str, start: int) -> tuple[Any, int]:
    """扫描数字字面量；非法数字（如 `1.2.3`）直接给语法错。"""
    i = start
    if expr[i] in "+-":
        i += 1
    digits = False
    while i < len(expr) and expr[i].isdigit():
        digits = True
        i += 1
    if i < len(expr) and expr[i] == ".":
        i += 1
        while i < len(expr) and expr[i].isdigit():
            digits = True
            i += 1
    if not digits:
        raise _syntax("数字格式错误", start)
    # 数字后面紧跟标识符字符（`1abc`）或第二个点（`1.2.3`）都算写错
    if i < len(expr) and (expr[i].isalnum() or expr[i] in "_."):
        raise _syntax("数字格式错误（后面紧跟了标识符或第二个小数点）", start)
    text = expr[start:i]
    try:
        return (int(text) if "." not in text else float(text)), i
    except ValueError:  # pragma: no cover - 上面的扫描已排除
        raise _syntax("数字格式错误", start) from None


def _scan_string(expr: str, start: int) -> tuple[str, int]:
    """扫描单/双引号字符串；仅支持 `\\` 转义（`\\n`/`\\t` 按普通转义处理）。"""
    quote = expr[start]
    i = start + 1
    parts: list[str] = []
    while i < len(expr):
        ch = expr[i]
        if ch == "\\":
            if i + 1 >= len(expr):
                raise _syntax("字符串以反斜杠结尾", i)
            nxt = expr[i + 1]
            parts.append({"n": "\n", "t": "\t", "r": "\r"}.get(nxt, nxt))
            i += 2
            continue
        if ch == quote:
            return "".join(parts), i + 1
        parts.append(ch)
        i += 1
    raise _syntax("字符串没有闭合的引号", start)


# ── 递归下降解析（AST 用元组：("lit", v) / ("ref", path) / ...）────────────

class _Parser:
    def __init__(self, tokens: Sequence[_Token]) -> None:
        self.tokens = list(tokens)
        self.pos = 0
        self.depth = 0

    # ── 基础 ──
    @property
    def _current(self) -> _Token:
        return self.tokens[self.pos]

    def _advance(self) -> _Token:
        token = self.tokens[self.pos]
        self.pos += 1
        return token

    def _at_keyword(self, *words: str) -> bool:
        return self._current.kind == "KEYWORD" and self._current.value in words

    def _enter(self) -> None:
        self.depth += 1
        if self.depth > MAX_DEPTH:
            raise TriggerError(
                TRIGGER_TOO_COMPLEX,
                f"表达式嵌套过深（上限 {MAX_DEPTH} 层）",
                self._current.pos,
            )

    def _leave(self) -> None:
        self.depth -= 1

    # ── 文法 ──
    def parse(self) -> Any:
        node = self._parse_or()
        if self._current.kind != "EOF":
            raise _syntax(
                f"表达式末尾有多余内容 {self._current.value!r}",
                self._current.pos,
            )
        return node

    def _parse_or(self) -> Any:
        node = self._parse_and()
        while self._at_keyword("or"):
            self._advance()
            node = ("or", node, self._parse_and())
        return node

    def _parse_and(self) -> Any:
        node = self._parse_not()
        while self._at_keyword("and"):
            self._advance()
            node = ("and", node, self._parse_not())
        return node

    def _parse_not(self) -> Any:
        if self._at_keyword("not"):
            self._advance()
            self._enter()
            try:
                return ("not", self._parse_not())
            finally:
                self._leave()
        return self._parse_comparison()

    def _parse_comparison(self) -> Any:
        left = self._parse_primary()
        token = self._current

        if token.kind == "OP" and token.value in _COMPARE_OPS:
            self._advance()
            return ("cmp", token.value, left, self._parse_primary())

        if self._at_keyword("in"):
            self._advance()
            return ("in", left, self._parse_primary(), False)

        if self._at_keyword("not") and self.tokens[self.pos + 1].kind == "KEYWORD" \
                and self.tokens[self.pos + 1].value == "in":
            self._advance()  # not
            self._advance()  # in
            return ("in", left, self._parse_primary(), True)

        return left

    def _parse_primary(self) -> Any:
        token = self._current

        if token.kind == "LPAREN":
            self._advance()
            self._enter()
            try:
                node = self._parse_or()
            finally:
                self._leave()
            if self._current.kind != "RPAREN":
                raise _syntax("缺少右括号", self._current.pos)
            self._advance()
            return node

        if token.kind == "LBRACKET":
            self._advance()
            items: list[Any] = []
            if self._current.kind != "RBRACKET":
                while True:
                    items.append(self._parse_primary())
                    if self._current.kind == "COMMA":
                        self._advance()
                        continue
                    break
            if self._current.kind != "RBRACKET":
                raise _syntax("列表字面量缺少右方括号", self._current.pos)
            self._advance()
            return ("list", items)

        if token.kind == "STRING":
            self._advance()
            return ("lit", token.value)

        if token.kind == "NUMBER":
            self._advance()
            return ("lit", token.value)

        if token.kind == "KEYWORD":
            if token.value in ("true",):
                self._advance()
                return ("lit", True)
            if token.value in ("false",):
                self._advance()
                return ("lit", False)
            if token.value in ("none", "null"):
                self._advance()
                return ("lit", None)
            raise _syntax(f"关键字 {token.value!r} 不能作为值", token.pos)

        if token.kind == "IDENT":
            self._advance()
            return ("ref", str(token.value).split("."))

        raise _syntax(
            f"这里需要一个值，但读到 {token.value!r}" if token.kind != "EOF"
            else "表达式不完整",
            token.pos,
        )


def parse_trigger(expr: str) -> Any:
    """解析表达式并返回 AST（**不求值**，供 `validate_trigger` 与调试使用）。"""
    if not isinstance(expr, str):
        raise TriggerError(TRIGGER_SYNTAX, "表达式必须是字符串")
    if len(expr) > MAX_EXPR_LENGTH:
        raise TriggerError(
            TRIGGER_TOO_COMPLEX,
            f"表达式过长（{len(expr)} 字符，上限 {MAX_EXPR_LENGTH}）",
        )
    return _Parser(_tokenize(expr)).parse()


# ── 求值 ───────────────────────────────────────────────────────────────────

def _as_number(value: Any) -> Optional[float]:
    """把事实值/字面量转成数值；不是数值形态返回 None（不做四舍五入）。"""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if _NUMBER_RE.match(text):
            try:
                return float(text)
            except ValueError:  # pragma: no cover
                return None
    return None


def _as_bool(value: Any) -> Optional[bool]:
    """把「布尔字面量的常见文本形态」转成 bool；不确定返回 None。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if value in (0, 1):
            return bool(value)
        return None
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in _BOOL_TRUE:
            return True
        if lowered in _BOOL_FALSE:
            return False
    return None


def _truthy(value: Any) -> bool:
    """条件语境下的真值：事实值是**字符串**，`"false"` 必须当假而非"非空即真"。"""
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered == "":
            return False
        if lowered in _BOOL_TRUE:
            return True
        if lowered in _BOOL_FALSE:
            return False
        return True
    return bool(value)


def _equals(left: Any, right: Any) -> bool:
    """`==` / `!=` / `in` 的同一套相等口径（数值优先，其次布尔，最后字符串）。"""
    left_number = _as_number(left)
    right_number = _as_number(right)
    if left_number is not None and right_number is not None:
        return left_number == right_number

    if isinstance(left, bool) or isinstance(right, bool):
        left_bool = _as_bool(left)
        right_bool = _as_bool(right)
        if left_bool is not None and right_bool is not None:
            return left_bool is right_bool
        raise TriggerError(
            TRIGGER_TYPE,
            f"布尔比较的右侧不是布尔形态：{left!r} 与 {right!r}",
        )

    return str(left) == str(right)


def _compare(op: str, left: Any, right: Any) -> bool:
    left_number = _as_number(left)
    right_number = _as_number(right)
    if left_number is None or right_number is None:
        raise TriggerError(
            TRIGGER_TYPE,
            f"大小比较只允许数值：{left!r} {op} {right!r}",
        )
    if op == ">":
        return left_number > right_number
    if op == ">=":
        return left_number >= right_number
    if op == "<":
        return left_number < right_number
    return left_number <= right_number


def _resolve_ref(path: Sequence[str], facts: Mapping[str, Any]) -> Any:
    """事实键解析（嵌套 → 扁平点号 → 最后一段），未知键抛 `TRIGGER_UNKNOWN_KEY`。"""
    segments = list(path)
    # 允许 `facts.packaging.has_wood` 的可选前缀
    if segments and segments[0].lower() == "facts":
        segments = segments[1:]
    if not segments:
        raise TriggerError(TRIGGER_UNKNOWN_KEY, "空的事实键")

    cursor: Any = facts
    for index, segment in enumerate(segments):
        if isinstance(cursor, Mapping) and segment in cursor:
            cursor = cursor[segment]
            continue
        break
    else:
        return cursor

    dotted = ".".join(segments)
    if dotted in facts:
        return facts[dotted]
    if segments[-1] in facts:
        return facts[segments[-1]]

    raise TriggerError(
        TRIGGER_UNKNOWN_KEY,
        f"未知事实键：{'.'.join(path)}",
    )


def _eval(node: Any, facts: Mapping[str, Any]) -> Any:
    tag = node[0]

    if tag == "lit":
        return node[1]

    if tag == "list":
        return [_eval(item, facts) for item in node[1]]

    if tag == "ref":
        return _resolve_ref(node[1], facts)

    if tag == "not":
        return not _truthy(_eval(node[1], facts))

    if tag == "and":
        return _truthy(_eval(node[1], facts)) and _truthy(_eval(node[2], facts))

    if tag == "or":
        return _truthy(_eval(node[1], facts)) or _truthy(_eval(node[2], facts))

    if tag == "cmp":
        op, left_node, right_node = node[1], node[2], node[3]
        left = _eval(left_node, facts)
        right = _eval(right_node, facts)
        if op == "==":
            return _equals(left, right)
        if op == "!=":
            return not _equals(left, right)
        return _compare(op, left, right)

    if tag == "in":
        left = _eval(node[1], facts)
        right = _eval(node[2], facts)
        negated = bool(node[3])
        if isinstance(right, (list, tuple, set)):
            found = any(_equals(left, item) for item in right)
        elif isinstance(right, str):
            found = str(left) in right
        else:
            raise TriggerError(
                TRIGGER_TYPE,
                f"in 的右侧必须是列表或字符串，实际是 {type(right).__name__}",
            )
        return (not found) if negated else found

    raise TriggerError(TRIGGER_SYNTAX, f"内部错误：未知 AST 节点 {tag!r}")


def evaluate_trigger(expr: Optional[str], facts: Optional[Mapping[str, Any]]) -> bool:
    """求值触发条件。`None`/空串 = **总是适用**（返回 True）。

    未知键 / 语法错 / 类型错一律抛 `TriggerError` —— 调用方决定如何呈现
    （列表端点放 `trigger_error`；PUT 只做 `validate_trigger` 语法校验）。
    """
    if expr is None:
        return True
    if not isinstance(expr, str):
        raise TriggerError(TRIGGER_SYNTAX, "表达式必须是字符串")
    text = expr.strip()
    if not text:
        return True
    return bool(_truthy(_eval(parse_trigger(text), facts or {})))


def validate_trigger(expr: Optional[str]) -> bool:
    """**只校验语法/复杂度**（不查事实键、不求值）。

    为什么写入时允许未知键：事实集合随 payload 演进（新字段/新单证类型），
    写入时拿当前 facts 校验会把"以后才可能出现的事实键"误判成坏表达式。
    未知键在**读取**时由 `evaluate_trigger` 报 `TRIGGER_UNKNOWN_KEY` 并回填
    `trigger_error`，界面/ lint 可见，但不会把坏语法存进库。
    """
    if expr is None:
        return True
    if not isinstance(expr, str):
        raise TriggerError(TRIGGER_SYNTAX, "表达式必须是字符串")
    text = expr.strip()
    if not text:
        return True
    parse_trigger(text)
    return True


def resolve_doc_set(
    items: Iterable[Mapping[str, Any]],
    facts: Optional[Mapping[str, Any]],
) -> list[dict]:
    """给单证清单逐项标注触发条件结果（**不删除任何项**，跳过项可解释）。

    返回的每项在原有字段上追加：
    - `applicable: bool`：条件是否成立（无表达式 ⇒ 恒 True）；
    - `skipped_by_trigger: bool`：`role=required` 且条件为假 ⇒ True（"这次不用出"）；
    - `trigger_reason: str | None`：人话原因（假 / 无法求值）；
    - `trigger_error: {code, message}`：仅无法求值时出现（**未知键不隐藏单证**，
      按"适用"处理并回报错误，避免条件写错导致必出单证从清单里"消失"）。
    """
    facts = facts or {}
    resolved: list[dict] = []
    for raw in items:
        item = dict(raw)
        expr = item.get("trigger_expr")
        applicable = True
        trigger_error: Optional[dict] = None
        trigger_reason: Optional[str] = None

        if isinstance(expr, str) and expr.strip():
            try:
                applicable = evaluate_trigger(expr, facts)
            except TriggerError as exc:
                # 无法求值：按"适用"处理（不隐藏必出单证），但把结构化错误交出去
                applicable = True
                trigger_error = exc.as_dict()
                trigger_reason = f"触发条件无法求值：{exc.message}"
            else:
                if not applicable:
                    trigger_reason = f"触发条件不满足：{expr}"

        item["applicable"] = applicable
        item["skipped_by_trigger"] = bool(
            not applicable and item.get("role") == "required"
        )
        item["trigger_reason"] = trigger_reason
        if trigger_error is not None:
            item["trigger_error"] = trigger_error
        resolved.append(item)
    return resolved
