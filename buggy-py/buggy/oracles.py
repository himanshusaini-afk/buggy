"""Decides whether an execution counts as a failure.

Five oracles, checked in this order, because the earlier ones are unambiguous
and the later ones depend on having a usable return value:

1. **timeout** — the call did not finish
2. **crash** — it raised, and the exception is the function's fault
3. **non-finite** — it returned NaN or an infinity
4. **postcondition** — it returned a value the user said was impossible
5. **nondeterminism** — the same input produced different results

The distinction that does the most work is in :func:`is_environment_error`:
telling a defect in the function apart from a failure of the harness around it.
A ``SyntaxError`` means the module never loaded, so nothing has been learned
about the function; reporting it as a bug is a false positive that destroys
trust. A ``ZeroDivisionError``, by contrast, is exactly what we are looking for.

@module buggy.oracles
"""

from __future__ import annotations

import json
import math
from typing import Any

from .specs import Condition, build_bindings
from .types import (
    SEVERITY_NORMAL,
    SEVERITY_PROPAGATED,
    SEVERITY_STATED,
    SEVERITY_TYPE_CONFUSION,
    ConditionResult,
    ExecResult,
    OracleKind,
    Outcome,
    Verdict,
    Violation,
)

__all__ = [
    "is_environment_error",
    "is_type_confusion",
    "check_crash",
    "check_timeout",
    "check_non_finite",
    "check_postconditions",
    "check_determinism",
    "canonical",
    "outcomes_differ",
    "ENVIRONMENT_EXCEPTIONS",
]


ENVIRONMENT_EXCEPTIONS: frozenset[str] = frozenset(
    {
        # The module never loaded, so the function never ran.
        "SyntaxError",
        "IndentationError",
        "TabError",
        "ModuleNotFoundError",
        "ImportError",
        # Our own harness failing to find or reach the target.
        "FunctionNotResolved",
        "ModuleNotLoaded",
        "LoadCrashed",
        # The interpreter could not be started.
        "SpawnError",
        "InterpreterDied",
    }
)
"""Exceptions that indicate a problem with the setup, not the function.

Everything else is treated as a real defect, including ``ZeroDivisionError``,
``TypeError``, ``ValueError``, ``IndexError``, ``KeyError``, ``AttributeError``
and ``RecursionError``. A ``NameError`` raised at call time is also a real
defect — a genuine missing reference inside the function body — which is why it
is absent from this set even though it looks environmental.
"""

_RECURSION_IS_REAL = True
"""``RecursionError`` counts as a defect: unbounded recursion on a plausible
input is precisely the kind of fault worth proving."""


def is_environment_error(result: ExecResult) -> bool:
    """Whether this failure tells us nothing about the function."""
    if result.exception_type in ENVIRONMENT_EXCEPTIONS:
        return True
    message = result.message or ""
    # A load-time syntax problem can surface with a wrapped type.
    return "IndentationError" in message or "SyntaxError" in message


_TYPE_CONFUSION_MARKERS: tuple[str, ...] = (
    # Substrings of real CPython messages, deliberately not anchored to the
    # type name: "'int' object is not iterable" and "'NoneType' object is not
    # iterable" must both match.
    "unsupported operand type",
    "not supported between instances",
    "can only concatenate",
    "is not iterable",
    "is not subscriptable",
    "is not callable",
    "cannot be interpreted as an integer",
    "has no len",
    "object of type",
    "has no attribute",
    "must be str",
    "must be real number",
    "must be an integer",
    "nonetype",
)

TYPE_CONFUSION_ADVICE = (
    "the only failing input found is an argument of an unexpected type; "
    "constrain the parameter types in a precondition "
    "(e.g. --pre 'isinstance(x, (int, float))') to look for defects reachable "
    "from valid input"
)

PROPAGATION_ADVICE = (
    "the failing input was already non-finite, so the function propagated a "
    "NaN or infinity rather than creating one; add a precondition such as "
    "--pre 'math.isfinite(x)' to search for defects reachable from finite input"
)


def is_type_confusion(result: ExecResult) -> bool:
    """Whether the failure is just an argument of the wrong type.

    Python is duck-typed, so ``divide(None, None)`` raising ``TypeError`` is the
    language working as designed and the caller getting it wrong. Such a finding
    is kept — it may be the only one — but ranked below anything else, so it
    cannot crowd out the ``ZeroDivisionError`` that matters.
    """
    if result.exception_type not in ("TypeError", "AttributeError"):
        return False
    message = (result.message or "").lower()
    return any(marker in message for marker in _TYPE_CONFUSION_MARKERS)


# ─── Individual oracles ──────────────────────────────────────────────────────


def check_crash(result: ExecResult, args: list[Any]) -> Violation | None:
    """A raised exception that belongs to the function."""
    if result.outcome is not Outcome.RAISED:
        return None
    if is_environment_error(result):
        return None
    return Violation(
        kind=OracleKind.CRASH,
        args=args,
        result=None,
        rule=f"must not raise {result.exception_type}",
        detail=f"{result.exception_type}: {result.message}",
        duration_ms=result.duration_ms,
        severity=(
            SEVERITY_TYPE_CONFUSION if is_type_confusion(result) else SEVERITY_NORMAL
        ),
        advice=TYPE_CONFUSION_ADVICE if is_type_confusion(result) else None,
    )


def check_timeout(result: ExecResult, args: list[Any], budget: float) -> Violation | None:
    """The call did not finish inside its budget."""
    if result.outcome is not Outcome.TIMEOUT:
        return None
    return Violation(
        kind=OracleKind.TIMEOUT,
        args=args,
        result=None,
        rule=f"must finish within {budget:g}s",
        detail=result.message,
        duration_ms=result.duration_ms,
        severity=SEVERITY_STATED,
    )


def _contains_non_finite(value: Any, depth: int = 0) -> bool:
    """Whether `value` holds a NaN or an infinity, looking inside containers."""
    if depth > 4:
        return False
    if isinstance(value, bool):
        return False
    if isinstance(value, float):
        return math.isnan(value) or math.isinf(value)
    if isinstance(value, (list, tuple, set)):
        return any(_contains_non_finite(v, depth + 1) for v in value)
    if isinstance(value, dict):
        return any(_contains_non_finite(v, depth + 1) for v in value.values())
    return False


def check_non_finite(result: ExecResult, args: list[Any]) -> Violation | None:
    """A numeric result that is NaN or infinite, from finite inputs.

    Checked without the user asking, because a NaN result is almost never
    intended and propagates silently: a NaN price flows through a whole system
    before anything notices.

    **Propagation is not a defect.** If an argument was already NaN or infinite,
    a non-finite result is the function obeying IEEE 754, not failing. Blaming
    it would flag every unguarded arithmetic function in the codebase on an
    input the caller should never have produced — which is the dominant source
    of noise in this kind of tool, and the reason the original's own
    documentation calls preconditions "the single most important knob for signal
    quality". Suppressing it here means that knob is no longer needed to get a
    usable answer.

    ``bool`` is excluded despite being an ``int`` subclass, and integers are
    excluded because Python integers cannot be infinite.
    """
    if not result.value_is_usable:
        return None
    value = result.value
    if isinstance(value, bool) or not isinstance(value, float):
        return None
    if _contains_non_finite(args):
        return None
    if math.isnan(value):
        return Violation(
            kind=OracleKind.NON_FINITE,
            args=args,
            result=value,
            rule="not math.isnan(result)",
            duration_ms=result.duration_ms,
        )
    if math.isinf(value):
        return Violation(
            kind=OracleKind.NON_FINITE,
            args=args,
            result=value,
            rule="math.isfinite(result)",
            duration_ms=result.duration_ms,
        )
    return None


def check_postconditions(
    conditions: list[Condition],
    result: ExecResult,
    args: list[Any],
    parameter_names: tuple[str, ...],
) -> tuple[Violation | None, list[tuple[Condition, ConditionResult]]]:
    """Evaluate every postcondition against the return value.

    Returns the first violation found, plus every condition's outcome so the
    caller can report the ones that could not be evaluated. Those are warnings,
    never silent passes.
    """
    if not conditions:
        return None, []
    if not result.value_is_usable:
        # Judging `result >= 0` against the repr of an object would fail for
        # reasons unrelated to the function. Report, do not guess.
        return None, [
            (
                c,
                ConditionResult(
                    Verdict.UNEVALUABLE,
                    f"return value of type {result.value_type} could not be "
                    "transferred for inspection",
                ),
            )
            for c in conditions
        ]

    bindings = build_bindings(
        parameter_names, args, result.value, include_result=True
    )
    outcomes = [(c, c.evaluate(bindings)) for c in conditions]

    for condition, outcome in outcomes:
        if outcome.verdict is Verdict.FALSE:
            # A stated property is honoured literally, including when the result
            # is non-finite. But if an argument was *also* non-finite, the
            # function only propagated it, so this is ranked below a trigger the
            # function manufactured itself — otherwise `apply_discount(inf, 100)`
            # returning NaN would mask the negative price at `(1, 101)`, which
            # is the finding the user can act on.
            propagated = (
                _contains_non_finite(args) and _contains_non_finite(result.value)
            )
            return (
                Violation(
                    kind=OracleKind.POSTCONDITION,
                    args=args,
                    result=result.value,
                    rule=condition.source,
                    duration_ms=result.duration_ms,
                    severity=SEVERITY_PROPAGATED if propagated else SEVERITY_STATED,
                    advice=PROPAGATION_ADVICE if propagated else None,
                ),
                outcomes,
            )
    return None, outcomes


# ─── Determinism ─────────────────────────────────────────────────────────────


def canonical(result: ExecResult) -> str:
    """A stable string identifying an outcome, for equality comparison.

    NaN is folded to a single token on purpose. ``float('nan') != float('nan')``,
    so comparing raw values would report a function that reliably returns NaN as
    non-deterministic — a false positive on top of the NaN finding it already has.
    """
    if result.outcome is Outcome.TIMEOUT:
        return "timeout"
    if result.outcome is Outcome.HARD_CRASH:
        return f"hard_crash:{result.exception_type}"
    if result.outcome is Outcome.RAISED:
        return f"raised:{result.exception_type}"
    value = result.value
    if isinstance(value, float) and math.isnan(value):
        return "ok:nan"
    try:
        return "ok:" + json.dumps(value, sort_keys=True, default=repr)
    except (TypeError, ValueError):  # pragma: no cover - default= makes this rare
        return "ok:" + repr(value)


def outcomes_differ(results: list[ExecResult]) -> bool:
    """Whether repeated executions disagreed."""
    return len({canonical(r) for r in results}) > 1


def check_determinism(
    results: list[ExecResult],
    args: list[Any],
) -> Violation | None:
    """Repeated executions of one input that did not agree."""
    if not outcomes_differ(results):
        return None
    seen = sorted({canonical(r) for r in results})
    return Violation(
        kind=OracleKind.NONDETERMINISM,
        args=args,
        result=[r.value for r in results],
        rule="same input must produce the same result",
        detail="observed: " + ", ".join(seen[:4]),
        duration_ms=sum(r.duration_ms for r in results),
    )
