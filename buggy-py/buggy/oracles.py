"""Decides whether an execution counts as a failure.

Five oracles, checked in order: timeout, crash, postcondition, non-finite,
nondeterminism. The user's own postconditions come before the built-in numeric
checks, so a broken rule is reported in their words.

Two rankings keep the signal usable, because the easiest failures to trigger
are the least interesting. See `check_non_finite` and `is_type_confusion`.
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
    "ENVIRONMENT_EXCEPTIONS",
    "canonical",
    "check_crash",
    "check_determinism",
    "check_non_finite",
    "check_postconditions",
    "check_timeout",
    "comparison_key",
    "is_environment_error",
    "is_type_confusion",
    "outcomes_differ",
]


ENVIRONMENT_EXCEPTIONS: frozenset[str] = frozenset({
    # The module never loaded, so the function never ran.
    "SyntaxError", "IndentationError", "TabError",
    "ModuleNotFoundError", "ImportError",
    # Our harness failing to find or reach the target.
    "FunctionNotResolved", "ModuleNotLoaded", "LoadCrashed",
    # The receiver could not be built. A failure in __init__ says nothing
    # about the method under test.
    "ReceiverConstructionFailed",
    # The interpreter could not be started.
    "SpawnError", "InterpreterDied",
})
"""Exceptions indicating a problem with the setup, not the function.

Everything else is a real defect, including ZeroDivisionError, TypeError,
ValueError, IndexError, KeyError and RecursionError. A NameError raised at call
time is also real - a missing reference inside the function body - which is why
it is absent here despite looking environmental.
"""


def is_environment_error(result: ExecResult) -> bool:
    """Whether this failure tells us nothing about the function."""
    if result.exception_type in ENVIRONMENT_EXCEPTIONS:
        return True
    message = result.message or ""
    return "IndentationError" in message or "SyntaxError" in message


# Substrings of real CPython messages, not anchored to the type name so that
# "'int' object is not iterable" and "'NoneType' object is not iterable" both
# match.
_TYPE_CONFUSION_MARKERS = (
    "unsupported operand type", "not supported between instances",
    "can only concatenate", "is not iterable", "is not subscriptable",
    "is not callable", "cannot be interpreted as an integer", "has no len",
    "object of type", "has no attribute", "must be str",
    "must be real number", "must be an integer", "nonetype",
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

    Python is duck-typed, so `divide(None, None)` raising TypeError is the
    language working and the caller getting it wrong. Such a finding is kept -
    it may be the only one - but ranked below anything else so it cannot crowd
    out the ZeroDivisionError that matters.
    """
    if result.exception_type not in ("TypeError", "AttributeError"):
        return False
    message = (result.message or "").lower()
    return any(marker in message for marker in _TYPE_CONFUSION_MARKERS)


# --- Individual oracles ---


def check_crash(result: ExecResult, args: list[Any]) -> Violation | None:
    """A raised exception that belongs to the function."""
    if result.outcome is not Outcome.RAISED or is_environment_error(result):
        return None
    confused = is_type_confusion(result)
    return Violation(
        kind=OracleKind.CRASH,
        args=args,
        result=None,
        rule=f"must not raise {result.exception_type}",
        detail=f"{result.exception_type}: {result.message}",
        duration_ms=result.duration_ms,
        severity=SEVERITY_TYPE_CONFUSION if confused else SEVERITY_NORMAL,
        advice=TYPE_CONFUSION_ADVICE if confused else None,
    )


def check_timeout(
    result: ExecResult, args: list[Any], budget: float
) -> Violation | None:
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
    """Whether `value` holds a NaN or infinity, looking inside containers."""
    if depth > 4 or isinstance(value, bool):
        return False
    if isinstance(value, float):
        return math.isnan(value) or math.isinf(value)
    if isinstance(value, (list, tuple, set)):
        return any(_contains_non_finite(v, depth + 1) for v in value)
    if isinstance(value, dict):
        return any(_contains_non_finite(v, depth + 1) for v in value.values())
    return False


def check_non_finite(result: ExecResult, args: list[Any]) -> Violation | None:
    """A NaN or infinite result, from finite inputs.

    Checked without being asked, because a NaN result is almost never intended
    and propagates silently through a whole system.

    Propagation is not a defect: if an argument was already non-finite, a
    non-finite result is IEEE 754 working, not the function failing. Blaming it
    would flag every unguarded arithmetic function in a codebase the moment the
    fuzzer tries NaN, which is the dominant source of noise in this kind of
    tool.
    """
    if not result.value_is_usable:
        return None
    value = result.value
    if isinstance(value, bool) or not isinstance(value, float):
        return None
    if _contains_non_finite(args):
        return None
    if math.isnan(value):
        return Violation(OracleKind.NON_FINITE, args, value,
                         "not math.isnan(result)",
                         duration_ms=result.duration_ms)
    if math.isinf(value):
        return Violation(OracleKind.NON_FINITE, args, value,
                         "math.isfinite(result)",
                         duration_ms=result.duration_ms)
    return None


def check_postconditions(
    conditions: list[Condition],
    result: ExecResult,
    args: list[Any],
    parameter_names: tuple[str, ...],
) -> tuple[Violation | None, list[tuple[Condition, ConditionResult]]]:
    """Evaluate every postcondition against the return value.

    Returns the first violation plus every condition's outcome, so the caller
    can report the ones that could not be evaluated. Those are warnings, never
    silent passes.
    """
    if not conditions:
        return None, []

    if not result.value_is_usable:
        # Judging `result >= 0` against the repr of an object would fail for
        # reasons unrelated to the function.
        reason = (f"return value of type {result.value_type} could not be "
                  "transferred for inspection")
        return None, [
            (c, ConditionResult(Verdict.UNEVALUABLE, reason)) for c in conditions
        ]

    bindings = build_bindings(parameter_names, args, result.value,
                              include_result=True)
    outcomes = [(c, c.evaluate(bindings)) for c in conditions]

    for condition, outcome in outcomes:
        if outcome.verdict is not Verdict.FALSE:
            continue
        # A stated property is honoured literally, including for a non-finite
        # result. But if an argument was also non-finite the function only
        # propagated it, so rank it below a trigger the function made itself:
        # otherwise `apply_discount(inf, 100)` returning NaN masks the negative
        # price at (1, 101), which is the finding the user can act on.
        propagated = (_contains_non_finite(args)
                      and _contains_non_finite(result.value))
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


# --- Comparing outcomes ---


def canonical(result: ExecResult) -> str:
    """A stable string identifying an outcome, for equality comparison.

    NaN folds to one token on purpose: `float('nan') != float('nan')`, so
    comparing raw values would report a function that reliably returns NaN as
    non-deterministic.
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
    except (TypeError, ValueError):
        return "ok:" + repr(value)


def _normalise_zeros(value: Any) -> Any:
    """Fold -0.0 to 0.0, recursively."""
    if isinstance(value, bool):
        return value
    if isinstance(value, float) and value == 0.0:
        return 0.0
    if isinstance(value, list):
        return [_normalise_zeros(v) for v in value]
    if isinstance(value, tuple):
        return tuple(_normalise_zeros(v) for v in value)
    if isinstance(value, dict):
        return {k: _normalise_zeros(v) for k, v in value.items()}
    return value


def comparison_key(result: ExecResult) -> str:
    """A key for "did this behave the same?", tolerant of signed zero.

    Distinct from `canonical`, which stays strict for determinism checking.
    -0.0 and 0.0 are the same answer to any caller, and treating them as
    different rejected a correct clamp fix: `max(0, -0.0)` returns integer 0,
    which flipped the sign of a zero result and looked like a change.
    """
    if result.outcome is not Outcome.OK:
        return canonical(result)
    return canonical(ExecResult(Outcome.OK,
                                value=_normalise_zeros(result.value),
                                fidelity=result.fidelity))


def outcomes_differ(results: list[ExecResult]) -> bool:
    """Whether repeated executions disagreed."""
    return len({canonical(r) for r in results}) > 1


def check_determinism(
    results: list[ExecResult], args: list[Any]
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
