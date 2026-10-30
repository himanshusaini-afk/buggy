"""Builds candidate inputs for a function.

The corpora are Python's hazards, not JavaScript's. The original tool generated
``undefined``, ``Number.MAX_SAFE_INTEGER`` and ``Number.EPSILON``; translating
those literally would waste most of the budget, because Python has no
``undefined`` and its integers are arbitrary-precision, so there is no integer
overflow to find. What breaks Python functions instead is ``None`` where a value
was expected, an empty collection, a zero divisor, a string that looks like a
number, and ``float('nan')``.

Generation is annotation-driven when annotations exist and falls back to a mixed
set when they do not. An unannotated parameter is the common case in real code,
and the fallback set still contains ``0``, ``[]``, ``''`` and ``None``, which is
enough to reach the usual arithmetic and collection faults.

@module buggy.generate
"""

from __future__ import annotations

import random
import sys
from typing import Any

from .types import ParamKind, Signature

__all__ = [
    "values_for_annotation",
    "generate_arguments",
    "ordinary_arguments",
    "MAX_COMBINATIONS",
]

MAX_COMBINATIONS = 300
"""Ceiling on generated argument lists for one function."""

_MAX_PER_PARAM = 30
_MAX_PER_PARAM_WIDE = 15
"""Tighter per-parameter cap once there are 3+ parameters, to keep the product
of the per-parameter sets within MAX_COMBINATIONS."""

_EDGE_PREFIX = 8
"""How many leading values of each corpus count as "edge cases". The corpora are
ordered worst-first, so a prefix is a good proxy for severity."""


# ─── Corpora, ordered worst-first ────────────────────────────────────────────


def _ints() -> list[Any]:
    base: list[Any] = [
        0,  # the divisor that breaks everything
        1, -1, 2, -2,
        True, False,  # bool is an int subclass; passing one is a real caller mistake
        10, 100, -100, 1000,
        sys.maxsize, -sys.maxsize - 1,
        2**64, -(2**64),
        2**200,  # arbitrary precision: finds quadratic blowups, not overflow
    ]
    rng = random.Random(0xB06)
    base += [rng.randint(-10_000, 10_000) for _ in range(20)]
    return base


def _floats() -> list[Any]:
    base: list[Any] = [
        0.0, -0.0,
        float("nan"), float("inf"), float("-inf"),
        1.0, -1.0, 0.1, -0.1, 0.5,
        sys.float_info.max, sys.float_info.min, sys.float_info.epsilon,
        -sys.float_info.max,
        1e308, -1e308, 1e-308,
        2.0, 3.0, 100.0, -100.0,
    ]
    rng = random.Random(0xF10A7)
    base += [rng.uniform(-1000, 1000) for _ in range(20)]
    return base


def _strings() -> list[Any]:
    return [
        "",            # the empty string, which len-based guards miss
        "0",           # looks numeric; int()/float() succeed, arithmetic does not
        " ",
        "a",
        "hello",
        "NaN",
        "-1",
        "   padded   ",
        "\n",
        "\t",
        "\x00",        # embedded NUL, rejected by many C-backed libraries
        "a" * 10_000,
        "ünïcødé",
        "🎉",
        "line1\nline2",
        "%s %d {}",    # format specifiers, for accidental interpolation
        "../../etc/passwd",
        "'; DROP TABLE t; --",
    ]


def _int_lists() -> list[Any]:
    base: list[Any] = [
        [],            # empty: the len() == 0 divisor
        [0],
        [0, 0, 0],
        [1],
        [-1],
        [1, 2, 3],
        [3, 2, 1],
        [1, 1, 1],
        [-1, -2, -3],
        [sys.maxsize],
        [0, 1, -1],
        list(range(1000)),
    ]
    rng = random.Random(0x1157)
    base += [[rng.randint(-100, 100) for _ in range(rng.randint(2, 12))] for _ in range(10)]
    return base


def _float_lists() -> list[Any]:
    base: list[Any] = [
        [],
        [0.0],
        [float("nan")],
        [float("inf")],
        [float("-inf")],
        [0.0, 0.0],
        [1.0, 2.0, 3.0],
        [-1.0, -2.0],
        [0.1, 0.2, 0.3],
        [1e308, -1e308],
        [0.0, float("nan"), float("inf")],
    ]
    rng = random.Random(0x5EED)
    base += [[rng.uniform(-100, 100) for _ in range(rng.randint(2, 12))] for _ in range(10)]
    return base


def _str_lists() -> list[Any]:
    return [
        [], [""], ["a"], ["a", "b"], ["", ""], ["a", ""], ["ünïcødé"],
        ["x"] * 100, ["0"], ["a", "a"],
    ]


def _dicts() -> list[Any]:
    return [
        {}, {"a": 1}, {"a": 0}, {"": 1}, {"a": None},
        {"a": 1, "b": 2}, {"0": 0},
    ]


def _mixed() -> list[Any]:
    """For unannotated parameters, which are the common case in real Python.

    This set does the most work of anything in the module, so it is not merely
    "one of each shape". It must carry a spread of numeric *magnitudes* as well
    as the type edge cases, because a great many defects need an ordinary-looking
    number rather than a special value.

    The concrete lesson that shaped it: ``apply_discount(price, percent_off)``
    returns a negative price when ``percent_off > 100``, and with a corpus of
    only special values plus 0/1/-1 that bug is *unreachable* — every candidate
    above 100 was either infinite or outside the declared precondition range.
    Values immediately above common thresholds (101, 150) are included for
    exactly that reason: percentages, probabilities and percentiles are where
    unclamped arithmetic actually lives.

    **Order matters as much as content.** Values of a plausible type come first
    and deliberately-wrong types come last. Passing ``None`` to ``a / b`` raises
    ``TypeError``, which is easy to trigger and almost always the caller's
    mistake rather than a defect in the function; if it were tried first it
    would mask the ``ZeroDivisionError`` that is the finding worth having. The
    ranking in :func:`buggy.oracles.severity_of` is the other half of this.

    Every value here survives JSON transport. ``set()`` is absent for that
    reason, and note that a tuple arrives in the worker as a list.
    """
    return [
        # Divisors and identities: the most productive values in real code.
        0, 0.0, -0.0,
        # Empty containers: the len() == 0 divisor and its relatives. The list
        # comes first because it is the collection a Python signature most often
        # means, and whichever empty value is tried first becomes the reported
        # trigger — `mean([])` is a clearer bug report than `mean('')`.
        [], "", {}, (),
        # Populated collections, ranked above the numeric magnitude spread. An
        # unannotated parameter holding a collection is extremely common, and
        # ranking these low made a precondition as ordinary as "a non-empty list
        # of finite numbers" admit almost nothing.
        [1, 2, 3], [0, 0], [1.5, -2.5],
        # Ordinary numbers.
        1, -1, 2, 0.5, -0.5, 1.5,
        # A magnitude spread, including just past the usual percentage bound.
        100, 101, 150, 1000, -100, 1_000_000,
        # Non-finite floats.
        float("nan"), float("inf"), float("-inf"),
        # Arbitrary precision: finds quadratic blowups, not overflow.
        2**200,
        # bool is an int subclass, so these are a real caller mistake.
        False, True,
        # Type confusion last: easy to trigger, rarely the function's fault.
        None, "0", "abc", [0], [None],
    ]


# ─── Annotation dispatch ─────────────────────────────────────────────────────

_SCALARS: dict[str, Any] = {
    "int": _ints,
    "float": _floats,
    "complex": _floats,
    "str": _strings,
    "bytes": _strings,
    "bool": lambda: [False, True],
    "none": lambda: [None],
    "nonetype": lambda: [None],
}

_SEQUENCES: dict[str, Any] = {
    "list[int]": _int_lists,
    "list[bool]": _int_lists,
    "sequence[int]": _int_lists,
    "list[float]": _float_lists,
    "sequence[float]": _float_lists,
    "list[str]": _str_lists,
    "sequence[str]": _str_lists,
    "list": _float_lists,
    "tuple": _float_lists,
    "set": _int_lists,
    "iterable": _float_lists,
    "sequence": _float_lists,
}


def _normalise(annotation: str) -> tuple[str, bool]:
    """Fold an annotation to a lookup key, reporting whether None is admitted.

    ``Optional[int]``, ``int | None`` and ``Union[int, None]`` all mean the
    caller may pass None, which must therefore be generated — it is the most
    productive single input in Python.
    """
    text = annotation.strip()
    # Strip a leading module path: typing.List[int] -> List[int]
    for prefix in ("typing.", "t.", "collections.abc."):
        text = text.replace(prefix, "")
    lowered = text.lower().replace(" ", "")

    optional = False
    if lowered.startswith("optional[") and lowered.endswith("]"):
        optional = True
        lowered = lowered[len("optional["):-1]
    if lowered.startswith("union[") and lowered.endswith("]"):
        parts = [p for p in lowered[len("union["):-1].split(",")]
        if "none" in parts:
            optional = True
            parts = [p for p in parts if p != "none"]
        lowered = parts[0] if parts else "any"
    if "|" in lowered:
        parts = lowered.split("|")
        if "none" in parts:
            optional = True
            parts = [p for p in parts if p != "none"]
        lowered = parts[0] if parts else "any"

    return lowered, optional


def values_for_annotation(annotation: str | None) -> list[Any]:
    """Candidate values for one parameter.

    Unknown and absent annotations both fall through to the mixed set, which is
    deliberate: a wrong guess from a half-understood annotation is worse than
    admitting ignorance and trying the values that break most functions.

    Every value returned here can cross a process boundary as JSON. Type
    confusion is still covered — ``None``, ``""``, ``[]``, ``{}`` and ``"abc"``
    against a numeric parameter all raise ``TypeError`` in the target, which is
    the finding — without needing to transfer an opaque object.
    """
    if annotation is None:
        return _mixed()

    key, optional = _normalise(annotation)

    values: list[Any]
    if key in _SCALARS:
        values = list(_SCALARS[key]())
    elif key in _SEQUENCES:
        values = list(_SEQUENCES[key]())
    elif key.startswith(("dict", "mapping")):
        values = list(_dicts())
    elif key.startswith(("list", "sequence", "iterable", "tuple", "set", "frozenset")):
        # A parameterised collection whose element type we do not recognise.
        values = list(_float_lists())
    elif key in ("any", "object", ""):
        values = list(_mixed())
    else:
        # A user-defined class. Nothing sensible can be synthesised, so probe
        # the boundary conditions a caller might actually get wrong.
        values = [None, 0, "", [], {}]
        optional = False

    if optional and None not in values:
        values.insert(0, None)
    return values


# ─── Argument-list scheduling ────────────────────────────────────────────────


def generate_arguments(
    signature: Signature,
    *,
    limit: int = MAX_COMBINATIONS,
    seed: int = 0x8066,
) -> list[list[Any]]:
    """Argument lists to try, most promising first.

    An input is always a positional argument list, matching how the executor
    calls the target (``fn(*args)``) and how conditions bind parameter names.
    A single list-valued argument therefore stays one argument instead of being
    spread into several.

    For 3+ parameters an exhaustive product is unaffordable, so the schedule is
    the one from the original implementation, which is a good design worth
    keeping:

    1. **one-hot** — one parameter takes an edge value, the rest take an
       ordinary one. This isolates which parameter is responsible.
    2. **all-edge** — the product of the first few edge values of every
       parameter, for faults that need a combination.
    3. **random fill** — biased toward edge values, to use the remaining budget.
    """
    params = signature.callable_parameters
    if not params:
        return [[]]

    per_param = [values_for_annotation(p.annotation) for p in params]

    if len(params) == 1:
        return [[v] for v in per_param[0][:limit]]

    cap = _MAX_PER_PARAM if len(params) == 2 else _MAX_PER_PARAM_WIDE
    pools = [values[:cap] for values in per_param]

    ordinary = [_first_ordinary(pool) for pool in pools]
    collector = _Collector(limit)

    # The worst value of every parameter at once. For arithmetic, (0, 0) is the
    # single most productive pair there is.
    collector.add([pool[0] for pool in pools])

    # Phase 1: one-hot. Every value of every parameter is tried at least once,
    # against ordinary values elsewhere. This is the coverage guarantee, and for
    # two parameters it is what a naive nested loop destroys: investigating the
    # stdlib's `fmean(data, weights)` under a "non-empty list of finite numbers"
    # precondition executed *zero* inputs, because row-major order spent the
    # whole budget with a scalar in the `data` slot. Varying one parameter at a
    # time also isolates which one is responsible.
    for index, pool in enumerate(pools):
        for value in pool:
            if collector.add(
                [value if i == index else ordinary[i] for i in range(len(pools))]
            ):
                return collector.combos

    # Phase 2: combinations, for faults that need more than one bad argument.
    # Two parameters can afford a diagonal walk of the whole product, which
    # pairs low indices of both first; wider signatures get a bounded product
    # over each parameter's leading edge values.
    if len(pools) == 2:
        a_pool, b_pool = pools
        for total in range(len(a_pool) + len(b_pool) - 1):
            for i in range(min(total, len(a_pool) - 1), -1, -1):
                j = total - i
                if j < len(b_pool) and collector.add([a_pool[i], b_pool[j]]):
                    return collector.combos
    else:
        edges = [pool[:_EDGE_PREFIX] for pool in pools]
        for combo in _product([e[:4] for e in edges], cap=200):
            if collector.add(combo):
                return collector.combos

    # Phase 3: random fill, biased toward edge values.
    rng = random.Random(seed)
    edges = [pool[:_EDGE_PREFIX] for pool in pools]
    guard = 0
    while len(collector.combos) < limit and guard < limit * 20:
        guard += 1
        collector.add([
            rng.choice(edges[i]) if (edges[i] and rng.random() < 0.5)
            else rng.choice(pools[i])
            for i in range(len(pools))
        ])

    return collector.combos


class _Collector:
    """Accumulates argument lists, dropping duplicates, up to a limit.

    De-duplication matters because the phases overlap by design: one-hot and the
    product both produce the all-worst combination. Comparison is by ``repr``
    rather than by value, since the corpora contain NaN and
    ``float('nan') != float('nan')`` would let identical inputs through
    repeatedly.
    """

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.combos: list[list[Any]] = []
        self._seen: set[str] = set()

    def add(self, combo: list[Any]) -> bool:
        """Record `combo`. Returns True when the limit has been reached."""
        if len(self.combos) >= self.limit:
            return True
        key = repr(combo)
        if key not in self._seen:
            self._seen.add(key)
            self.combos.append(combo)
        return len(self.combos) >= self.limit


def ordinary_arguments(signature: Signature) -> list[Any]:
    """One argument list of unremarkable values.

    The opposite of what the rest of this module is for. Used to build the
    *receiver* for an instance method, where the goal is a valid object rather
    than a broken one: constructing ``Cart`` with ``0`` for its items is a good
    way to find a constructor bug and a bad way to get something to call
    ``total`` on.
    """
    return [
        _first_ordinary(values_for_annotation(p.annotation))
        for p in signature.callable_parameters
    ]


def _is_unremarkable(value: Any) -> bool:
    """Whether `value` is free of the properties that break functions."""
    if value is None or value is True or value is False:
        return False
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")) or value == 0:
            return False
        return True
    if isinstance(value, int):
        return value != 0
    if isinstance(value, (str, list, dict, set, tuple)):
        return len(value) > 0
    return True


def _first_ordinary(pool: list[Any]) -> Any:
    """The least remarkable value in `pool`.

    Used as the one-hot background, so a fault can be attributed to the single
    parameter holding an edge value, and to build receivers, where the goal is a
    working object.

    **A scalar is preferred over a collection**, because most parameters are
    scalars and a wrongly-typed background value poisons every result that uses
    it. Ranking populated collections above plain numbers in the mixed corpus
    made this return ``[1, 2, 3]``, so ``NeedsConfig(host, port, retries)`` was
    built with a list for every field and ``retries / attempt`` reported
    ``TypeError: unsupported operand type(s) for /: 'list' and 'int'`` instead of
    the ZeroDivisionError that is the actual defect.

    The preference only applies when the pool offers a scalar at all, so a
    parameter whose corpus is entirely collections still gets a collection.
    """
    unremarkable = [v for v in pool if _is_unremarkable(v)]
    if not unremarkable:
        return pool[0] if pool else None

    for value in unremarkable:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return value
    for value in unremarkable:
        if isinstance(value, str):
            return value
    return unremarkable[0]


def _product(pools: list[list[Any]], *, cap: int) -> list[list[Any]]:
    """Cartesian product, bounded. Depth-first so early values appear first."""
    result: list[list[Any]] = []

    def walk(prefix: list[Any], depth: int) -> None:
        if len(result) >= cap:
            return
        if depth == len(pools):
            result.append(list(prefix))
            return
        for value in pools[depth]:
            if len(result) >= cap:
                return
            prefix.append(value)
            walk(prefix, depth + 1)
            prefix.pop()

    walk([], 0)
    return result
