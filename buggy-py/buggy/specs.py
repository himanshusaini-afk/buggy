"""Evaluation of user-authored pre/postconditions, as Python expressions.

Conditions are written in terms of the function's own parameter names, plus
`result` for postconditions:

    preconditions  = ["budget > 0", "all(math.isfinite(v) for v in amounts)"]
    postconditions = ["result >= 0", "not math.isnan(result)"]

Two properties matter most:

- Conditions are judged, not guessed. Evaluation returns held, broken, or could
  not be evaluated, and the third is reported. The TypeScript implementation
  compiled conditions with `new Function` and treated every failure as "skip",
  so a Python condition raised a JavaScript SyntaxError, was swallowed, and the
  investigation reported "no bug found".
- Evaluation is restricted. The expression is parsed, every node checked against
  an allow-list, then run with no builtins and a small namespace, so a condition
  cannot reach the filesystem or the interpreter internals.
"""

from __future__ import annotations

import ast
import math
from dataclasses import dataclass
from typing import Any, Mapping

from .types import ConditionResult, Verdict

__all__ = [
    "SAFE_NAMES",
    "Condition",
    "SpecSyntaxError",
    "build_bindings",
    "compile_condition",
    "preconditions_hold",
]


# --- The allow-list ---

# Expression forms a condition may use. Anything absent is rejected at compile
# time with a message naming the construct, so the user gets a specific
# complaint instead of silence.
_ALLOWED_NODES: frozenset[type[ast.AST]] = frozenset({
    ast.Expression, ast.Constant, ast.Name, ast.Load,
    ast.BoolOp, ast.And, ast.Or,
    ast.UnaryOp, ast.Not, ast.USub, ast.UAdd, ast.Invert,
    ast.BinOp, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv,
    ast.Mod, ast.Pow, ast.BitAnd, ast.BitOr, ast.BitXor,
    ast.LShift, ast.RShift,
    ast.Compare, ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE,
    ast.Is, ast.IsNot, ast.In, ast.NotIn,
    ast.IfExp,
    ast.Call, ast.keyword, ast.Attribute, ast.Subscript, ast.Slice,
    ast.Starred,
    ast.Tuple, ast.List, ast.Dict, ast.Set,
    # Comprehensions, needed for all(...)/any(...) over a collection.
    ast.GeneratorExp, ast.ListComp, ast.SetComp, ast.DictComp,
    ast.comprehension, ast.Store,
    ast.JoinedStr, ast.FormattedValue,
})

# Named explicitly so the error says why, rather than just "not allowed".
_REJECTED_WITH_REASON: dict[type[ast.AST], str] = {
    ast.Lambda: "lambda is not allowed; use a comprehension",
    ast.NamedExpr: "assignment expressions (:=) are not allowed",
    ast.Await: "await is not allowed",
    ast.Yield: "yield is not allowed",
    ast.YieldFrom: "yield from is not allowed",
}

# Builtins a condition may call, chosen to cover the properties people write
# about results: sizes, bounds, totals, membership and type checks.
_SAFE_BUILTINS: dict[str, Any] = {
    "abs": abs, "all": all, "any": any, "bool": bool, "bytearray": bytearray,
    "bytes": bytes, "complex": complex, "dict": dict, "divmod": divmod,
    "enumerate": enumerate, "filter": filter, "float": float,
    "frozenset": frozenset, "int": int, "isinstance": isinstance,
    "issubclass": issubclass, "len": len, "list": list, "map": map,
    "max": max, "min": min, "pow": pow, "range": range, "reversed": reversed,
    "round": round, "set": set, "sorted": sorted, "str": str, "sum": sum,
    "tuple": tuple, "type": type, "zip": zip,
}

SAFE_NAMES: dict[str, Any] = {**_SAFE_BUILTINS, "math": math}

# Attribute access is restricted. Allowing arbitrary attributes would let a
# condition walk from any object to its class and on to the import machinery.
_ALLOWED_ATTRS: dict[str, frozenset[str]] = {
    "math": frozenset(n for n in dir(math) if not n.startswith("_")),
}

# Methods permitted on ordinary values: small and read-only, because this is a
# specification language and not a scripting language.
_ALLOWED_VALUE_METHODS: frozenset[str] = frozenset({
    "keys", "values", "items", "get",
    "lower", "upper", "strip", "lstrip", "rstrip", "startswith", "endswith",
    "split", "count", "index", "find", "isdigit", "isalpha",
    "is_integer", "bit_length",
})


class SpecSyntaxError(ValueError):
    """A condition that cannot be compiled, with a reason fit to show a user."""


# --- Compilation ---


def _check_tree(tree: ast.AST) -> None:
    """Reject anything outside the allow-list, naming what was found."""
    for node in ast.walk(tree):
        for bad, reason in _REJECTED_WITH_REASON.items():
            if isinstance(node, bad):
                raise SpecSyntaxError(reason)

        if type(node) not in _ALLOWED_NODES:
            raise SpecSyntaxError(
                f"{type(node).__name__} is not allowed in a condition")

        if not isinstance(node, ast.Attribute):
            continue
        if node.attr.startswith("_"):
            raise SpecSyntaxError(
                f"attribute {node.attr!r} is not allowed (underscore-prefixed)")
        # `math.isnan(x)` is fine; `x.__class__` is not. A bare value method is
        # allowed only if it is on the small read-only list.
        if isinstance(node.value, ast.Name) and node.value.id in _ALLOWED_ATTRS:
            if node.attr not in _ALLOWED_ATTRS[node.value.id]:
                raise SpecSyntaxError(
                    f"{node.value.id}.{node.attr} is not available")
        elif node.attr not in _ALLOWED_VALUE_METHODS:
            raise SpecSyntaxError(
                f"attribute {node.attr!r} is not allowed in a condition")


def _free_names(tree: ast.AST) -> frozenset[str]:
    """Identifiers the expression reads, excluding comprehension variables."""
    bound: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.comprehension):
            bound.update(n.id for n in ast.walk(node.target)
                         if isinstance(n, ast.Name))
    read = {n.id for n in ast.walk(tree)
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
    return frozenset(read - bound)


@dataclass(frozen=True)
class Condition:
    """A compiled condition, ready to evaluate against bindings."""

    source: str
    code: Any
    names: frozenset[str]
    """Free identifiers read, used to tell an unbound parameter name apart from
    a genuine evaluation failure."""

    def evaluate(self, bindings: Mapping[str, Any]) -> ConditionResult:
        """Evaluate against `bindings`.

        Returns UNEVALUABLE rather than raising, so one bad condition cannot
        abort an investigation.
        """
        missing = sorted(n for n in self.names
                         if n not in bindings and n not in SAFE_NAMES)
        if missing:
            return ConditionResult(
                Verdict.UNEVALUABLE,
                f"unknown name(s): {', '.join(missing)}")

        # Everything goes in globals, with no separate locals mapping. A
        # comprehension compiles to its own function scope and resolves free
        # names against globals only, so passing bindings as locals would make
        # `all(math.isfinite(v) for v in xs)` fail with "name 'xs' is not
        # defined" while the same test without a comprehension worked.
        namespace: dict[str, Any] = {"__builtins__": {}}
        namespace.update(SAFE_NAMES)
        namespace.update(bindings)
        try:
            value = eval(self.code, namespace)  # noqa: S307
        except Exception as exc:  # noqa: BLE001 - any failure means "cannot judge"
            return ConditionResult(Verdict.UNEVALUABLE,
                                   f"{type(exc).__name__}: {exc}")
        try:
            return ConditionResult(Verdict.TRUE if value else Verdict.FALSE)
        except Exception as exc:  # pragma: no cover
            return ConditionResult(Verdict.UNEVALUABLE,
                                   f"result is not truth-testable: {exc}")


# Conditions carried over from a JavaScript project are the likeliest source of
# syntax errors, so name the Python equivalent instead of leaving the user to
# guess.
_JS_HINTS: tuple[tuple[str, str], ...] = (
    ("===", "use == instead of ==="),
    ("!==", "use != instead of !=="),
    ("&&", "use 'and' instead of &&"),
    ("||", "use 'or' instead of ||"),
    ("??", "use 'or' instead of ??"),
    (".length", "use len(x) instead of x.length"),
    ("!", "use 'not x' instead of !x"),
    ("Number.isFinite", "use math.isfinite(x)"),
    ("isNaN", "use math.isnan(x)"),
    ("isFinite", "use math.isfinite(x)"),
    ("Array.isArray", "use isinstance(x, list)"),
    ("Math.", "use the math module, e.g. math.sqrt"),
    ("null", "use None instead of null"),
    ("undefined", "use None instead of undefined"),
    ("true", "use True instead of true"),
    ("false", "use False instead of false"),
    ("=>", "arrow functions are not Python; use a comprehension"),
)


def _syntax_hint(text: str) -> str:
    """Suggest a fix when the text looks like a JavaScript condition."""
    for marker, advice in _JS_HINTS:
        if marker in text:
            return f" - looks like JavaScript: {advice}"
    return ""


def compile_condition(expr: str) -> Condition:
    """Compile one condition.

    @raises SpecSyntaxError: not a Python expression, or uses a construct
        outside the allow-list. The message is intended for the user.
    """
    text = expr.strip()
    if not text:
        raise SpecSyntaxError("condition is empty")
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError as exc:
        raise SpecSyntaxError(
            f"not a Python expression ({exc.msg}){_syntax_hint(text)}") from exc

    _check_tree(tree)
    return Condition(source=text,
                     code=compile(tree, filename="<condition>", mode="eval"),
                     names=_free_names(tree))


# --- Bindings and bulk evaluation ---


def build_bindings(
    parameter_names: tuple[str, ...] | list[str],
    args: list[Any],
    result: Any = None,
    include_result: bool = False,
    receiver_names: tuple[str, ...] | list[str] = (),
    receiver_args: tuple[Any, ...] | list[Any] = (),
) -> dict[str, Any]:
    """Bind parameter names to arguments positionally.

    Mirrors how the executor calls the target (`fn(*args)`), so a condition
    sees exactly the values the function received. `args` is bound as a whole,
    which is the only way to write about a variadic call.

    For an instance method the constructor's parameters are bound too: a
    method's input is the pair (how the object was built, what it was called
    with), and `Basket.average` fails for `Basket([])`, so the user needs some
    way to say `len(items) > 0`. Method parameters win a name clash, being the
    more immediate subject.
    """
    bindings: dict[str, Any] = {}
    for name, value in zip(receiver_names, receiver_args):
        if name.isidentifier():
            bindings[name] = value
    for name, value in zip(parameter_names, args):
        if name.isidentifier():
            bindings[name] = value
    bindings["args"] = list(args)
    if include_result:
        # `result` is reserved. A parameter genuinely named `result` keeps its
        # own value, and the caller reports that rather than resolving it here.
        bindings.setdefault("result", result)
    return bindings


def preconditions_hold(
    conditions: list[Condition],
    args: list[Any],
    names: tuple[str, ...],
    receiver_names: tuple[str, ...] = (),
    receiver_args: tuple[Any, ...] = (),
) -> tuple[bool, str | None]:
    """Whether an input is admissible under `conditions`.

    Shared by the search, which skips inadmissible inputs, and by repair, which
    uses it to decide which inputs a patch may change. A patch must not be
    blamed for altering behaviour on an input the specification excluded.

    An unevaluable precondition yields (False, reason): an input that cannot be
    shown legal is not used as the basis of a proof, nor as evidence against a
    fix.
    """
    if not conditions:
        return True, None
    bindings = build_bindings(names, args, include_result=False,
                              receiver_names=receiver_names,
                              receiver_args=receiver_args)
    for condition in conditions:
        outcome = condition.evaluate(bindings)
        if outcome.verdict is Verdict.FALSE:
            return False, f"precondition not satisfied: {condition.source}"
        if outcome.verdict is Verdict.UNEVALUABLE:
            return False, (f"precondition could not be evaluated: "
                           f"{condition.source} ({outcome.reason})")
    return True, None
