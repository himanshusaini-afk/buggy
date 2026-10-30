"""Evaluation of user-authored pre/postconditions, as Python expressions.

Conditions are written in terms of the function's own parameter names, plus
``result`` for postconditions::

    preconditions  = ["budget > 0", "all(math.isfinite(v) for v in amounts)"]
    postconditions = ["result >= 0", "not math.isnan(result)"]

Two properties matter more than anything else here.

**Conditions are judged, not guessed.** Evaluation returns a three-way verdict:
the condition held, it was broken, or it could not be evaluated at all. The
third case is reported to the user as a warning. The TypeScript implementation
compiled conditions with ``new Function`` and treated every failure as "skip",
so a Python-syntax condition against a Python target raised a JavaScript
SyntaxError, was swallowed, and the investigation reported "no bug found". A
specification that silently does nothing is worse than no specification.

**Evaluation is restricted.** The expression is parsed, every node is checked
against an allow-list, and it then runs with no builtins and a small namespace.
This blocks attribute probing, imports, lambdas, assignment expressions and
dunder access, so a condition cannot reach the filesystem or the interpreter
internals. ``new Function`` offered no such boundary.

@module buggy.specs
"""

from __future__ import annotations

import ast
import math
from dataclasses import dataclass
from typing import Any, Mapping

from .types import ConditionResult, Verdict

__all__ = ["Condition", "compile_condition", "evaluate_all", "SAFE_NAMES"]


# ─── The allow-list ──────────────────────────────────────────────────────────

# Expression forms a condition may use. Everything absent is rejected at
# compile time with a message naming the offending construct, so the user gets
# a specific complaint instead of silence.
_ALLOWED_NODES: frozenset[type[ast.AST]] = frozenset(
    {
        ast.Expression,
        ast.Constant,
        ast.Name,
        ast.Load,
        # operators
        ast.BoolOp, ast.And, ast.Or,
        ast.UnaryOp, ast.Not, ast.USub, ast.UAdd, ast.Invert,
        ast.BinOp, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv,
        ast.Mod, ast.Pow, ast.BitAnd, ast.BitOr, ast.BitXor,
        ast.LShift, ast.RShift,
        ast.Compare, ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE,
        ast.Is, ast.IsNot, ast.In, ast.NotIn,
        ast.IfExp,
        # calls and access
        ast.Call, ast.keyword, ast.Attribute, ast.Subscript, ast.Slice,
        ast.Starred,
        # containers
        ast.Tuple, ast.List, ast.Dict, ast.Set,
        # comprehensions, needed for all(...)/any(...) over a collection
        ast.GeneratorExp, ast.ListComp, ast.SetComp, ast.DictComp,
        ast.comprehension, ast.Store,
        # f-strings are harmless and occasionally useful in a message
        ast.JoinedStr, ast.FormattedValue,
    }
)

# Nodes worth naming explicitly, so the error says why rather than just "not allowed".
_REJECTED_WITH_REASON: dict[type[ast.AST], str] = {
    ast.Lambda: "lambda is not allowed; use a comprehension",
    ast.NamedExpr: "assignment expressions (:=) are not allowed",
    ast.Await: "await is not allowed",
    ast.Yield: "yield is not allowed",
    ast.YieldFrom: "yield from is not allowed",
}

# Builtins a condition may call. Chosen to cover the properties people actually
# write about results: sizes, bounds, totals, membership and type checks.
_SAFE_BUILTINS: dict[str, Any] = {
    "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict,
    "divmod": divmod, "enumerate": enumerate, "filter": filter, "float": float,
    "frozenset": frozenset, "int": int, "isinstance": isinstance,
    "issubclass": issubclass, "len": len, "list": list, "map": map, "max": max,
    "min": min, "pow": pow, "range": range, "reversed": reversed,
    "round": round, "set": set, "sorted": sorted, "str": str, "sum": sum,
    "tuple": tuple, "type": type, "zip": zip,
    # type objects, for isinstance checks
    "complex": complex, "bytes": bytes, "bytearray": bytearray,
}

# Module namespaces a condition may reach through. `math` carries isnan/isfinite,
# which is how most numeric postconditions are written.
_SAFE_MODULES: dict[str, Any] = {"math": math}

SAFE_NAMES: dict[str, Any] = {**_SAFE_BUILTINS, **_SAFE_MODULES}

# Attribute access is restricted to these module members. Allowing arbitrary
# attributes would let a condition walk from any object to its class and on to
# the import machinery.
_ALLOWED_ATTRS: dict[str, frozenset[str]] = {
    "math": frozenset(
        n for n in dir(math) if not n.startswith("_")
    ),
}

# Methods permitted on ordinary values. Deliberately small and read-only; this
# is a specification language, not a scripting language.
_ALLOWED_VALUE_METHODS: frozenset[str] = frozenset(
    {
        "keys", "values", "items", "get",
        "lower", "upper", "strip", "lstrip", "rstrip", "startswith",
        "endswith", "split", "count", "index", "find", "isdigit", "isalpha",
        "is_integer", "bit_length",
    }
)


class SpecSyntaxError(ValueError):
    """A condition that cannot be compiled, with a reason fit to show a user."""


# ─── Compilation ─────────────────────────────────────────────────────────────


def _describe(node: ast.AST) -> str:
    return type(node).__name__


def _check_tree(expr: str, tree: ast.AST) -> None:
    """Reject anything outside the allow-list, naming what was found."""
    for node in ast.walk(tree):
        for bad, reason in _REJECTED_WITH_REASON.items():
            if isinstance(node, bad):
                raise SpecSyntaxError(reason)

        if type(node) not in _ALLOWED_NODES:
            raise SpecSyntaxError(
                f"{_describe(node)} is not allowed in a condition"
            )

        if isinstance(node, ast.Attribute):
            if node.attr.startswith("_"):
                raise SpecSyntaxError(
                    f"attribute {node.attr!r} is not allowed (underscore-prefixed)"
                )
            # `math.isnan(x)` is fine; `x.__class__` is not. A bare value method
            # is allowed only if it is on the small read-only list.
            if isinstance(node.value, ast.Name) and node.value.id in _ALLOWED_ATTRS:
                permitted = _ALLOWED_ATTRS[node.value.id]
                if node.attr not in permitted:
                    raise SpecSyntaxError(
                        f"{node.value.id}.{node.attr} is not available"
                    )
            elif node.attr not in _ALLOWED_VALUE_METHODS:
                raise SpecSyntaxError(
                    f"attribute {node.attr!r} is not allowed in a condition"
                )


@dataclass(frozen=True)
class Condition:
    """A compiled condition, ready to evaluate against bindings."""

    source: str
    code: Any  # types.CodeType
    names: frozenset[str]
    """Free identifiers the condition reads. Used to tell an unbound parameter
    name apart from a genuine evaluation failure."""

    def evaluate(self, bindings: Mapping[str, Any]) -> ConditionResult:
        """Evaluate against `bindings`.

        Returns UNEVALUABLE rather than raising, so one bad condition cannot
        abort an investigation. The reason is preserved for reporting.
        """
        missing = sorted(n for n in self.names if n not in bindings and n not in SAFE_NAMES)
        if missing:
            return ConditionResult(
                Verdict.UNEVALUABLE,
                f"unknown name(s): {', '.join(missing)}",
            )

        # Everything goes in *globals*, with no separate locals mapping.
        # A comprehension or generator expression compiles to its own function
        # scope, and that scope resolves free names against globals only. Passing
        # the bindings as locals would make `all(math.isfinite(v) for v in xs)`
        # fail with "name 'xs' is not defined" while the same test written
        # without a comprehension worked, which is a maddening inconsistency to
        # hand a user writing specifications.
        namespace: dict[str, Any] = {"__builtins__": {}}
        namespace.update(SAFE_NAMES)
        namespace.update(bindings)
        try:
            value = eval(self.code, namespace)  # noqa: S307
        except Exception as exc:  # noqa: BLE001 - any failure means "cannot judge"
            return ConditionResult(
                Verdict.UNEVALUABLE, f"{type(exc).__name__}: {exc}"
            )
        try:
            return ConditionResult(Verdict.TRUE if value else Verdict.FALSE)
        except Exception as exc:  # pragma: no cover - __bool__ raising is exotic
            return ConditionResult(
                Verdict.UNEVALUABLE, f"result is not truth-testable: {exc}"
            )


def _free_names(tree: ast.AST) -> frozenset[str]:
    """Identifiers the expression reads, excluding comprehension variables."""
    bound: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.comprehension):
            for sub in ast.walk(node.target):
                if isinstance(sub, ast.Name):
                    bound.add(sub.id)
    read = {
        n.id
        for n in ast.walk(tree)
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)
    }
    return frozenset(read - bound)


def compile_condition(expr: str) -> Condition:
    """Compile one condition.

    @raises SpecSyntaxError: the text is not a Python expression, or uses a
        construct outside the allow-list. The message is intended for the user.
    """
    text = expr.strip()
    if not text:
        raise SpecSyntaxError("condition is empty")
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError as exc:
        hint = _syntax_hint(text)
        detail = f"not a Python expression ({exc.msg})"
        raise SpecSyntaxError(f"{detail}{hint}") from exc

    _check_tree(text, tree)
    code = compile(tree, filename="<condition>", mode="eval")
    return Condition(source=text, code=code, names=_free_names(tree))


# Conditions carried over from a JavaScript project are the most likely source
# of syntax errors, so say so specifically instead of leaving the user guessing.
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
            return f" — looks like JavaScript: {advice}"
    return ""


# ─── Bulk evaluation ─────────────────────────────────────────────────────────


def evaluate_all(
    conditions: list[Condition],
    bindings: Mapping[str, Any],
) -> list[tuple[Condition, ConditionResult]]:
    """Evaluate every condition, keeping each paired with its outcome."""
    return [(c, c.evaluate(bindings)) for c in conditions]


def preconditions_hold(
    conditions: list[Condition],
    args: list[Any],
    names: tuple[str, ...],
    receiver_names: tuple[str, ...] = (),
    receiver_args: tuple[Any, ...] = (),
) -> tuple[bool, str | None]:
    """Whether an input is admissible under `conditions`.

    Shared by the search, which uses it to skip inputs, and by repair, which
    uses it to decide which inputs a patch is allowed to change. A patch must
    not be blamed for altering behaviour on an input the specification already
    excluded.

    @returns (admissible, reason_if_not). An unevaluable precondition yields
        ``(False, reason)``: an input that cannot be shown legal is not used as
        the basis of a proof, nor as evidence against a fix.
    """
    if not conditions:
        return True, None
    bindings = build_bindings(
        names, args, include_result=False,
        receiver_names=receiver_names, receiver_args=receiver_args,
    )
    for condition in conditions:
        outcome = condition.evaluate(bindings)
        if outcome.verdict is Verdict.FALSE:
            return False, f"precondition not satisfied: {condition.source}"
        if outcome.verdict is Verdict.UNEVALUABLE:
            return False, (
                f"precondition could not be evaluated: {condition.source} "
                f"({outcome.reason})"
            )
    return True, None


def build_bindings(
    parameter_names: tuple[str, ...] | list[str],
    args: list[Any],
    result: Any = None,
    include_result: bool = False,
    receiver_names: tuple[str, ...] | list[str] = (),
    receiver_args: tuple[Any, ...] | list[Any] = (),
) -> dict[str, Any]:
    """Bind parameter names to arguments positionally.

    Mirrors how the executor calls the target (``fn(*args)``), so a condition
    always sees exactly the values the function received. ``args`` is also bound
    as a whole, which is the only way to write about a variadic call.

    For an instance method, the **constructor's** parameters are bound too. A
    method's input is the pair (how the object was built, what it was called
    with), so a condition must be able to speak about both: ``Basket.average``
    fails for ``Basket([])`` and the user needs some way to say
    ``len(items) > 0``. Method parameters take precedence on a name clash, since
    they are the more immediate subject.
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
        # own value and the return value becomes unreachable, which is reported
        # by the caller rather than silently resolved.
        bindings.setdefault("result", result)
    return bindings
