"""Builds candidate inputs for a function.

The corpora are Python's hazards, not JavaScript's. There is no `undefined` and
no integer overflow to find; what breaks Python functions is None where a value
was expected, an empty collection, a zero divisor, a string that looks like a
number, and float('nan').

Generation is annotation-driven when annotations exist and falls back to a mixed
set when they do not, which is the common case in real code.
"""

from __future__ import annotations

import random
import sys
from typing import Any

from .types import Signature

__all__ = [
    "MAX_COMBINATIONS",
    "generate_arguments",
    "ordinary_arguments",
    "values_for_annotation",
]

MAX_COMBINATIONS = 300
"""Ceiling on generated argument lists for one function."""

_MAX_PER_PARAM = 30
_MAX_PER_PARAM_WIDE = 15
"""Tighter cap once there are 3+ parameters, to bound the product."""

_EDGE_PREFIX = 8
"""How many leading values of a corpus count as edge cases. The corpora are
ordered worst-first, so a prefix is a good proxy for severity."""


# --- Corpora, ordered worst-first ---


def _ints() -> list[Any]:
    base: list[Any] = [
        0,                              # the divisor that breaks everything
        1, -1, 2, -2,
        True, False,                    # bool is an int; passing one is a real
                                        # caller mistake
        10, 100, -100, 1000,
        sys.maxsize, -sys.maxsize - 1,
        2**64, -(2**64),
        2**200,                         # arbitrary precision finds quadratic
                                        # blowups, not overflow
    ]
    rng = random.Random(0xB06)
    return base + [rng.randint(-10_000, 10_000) for _ in range(20)]


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
    return base + [rng.uniform(-1000, 1000) for _ in range(20)]


def _strings() -> list[Any]:
    return [
        "",                 # the empty string, which len-based guards miss
        "0",                # looks numeric: int() succeeds, arithmetic does not
        " ", "a", "hello", "NaN", "-1", "   padded   ",
        "\n", "\t",
        "\x00",             # embedded NUL, rejected by C-backed libraries
        "a" * 10_000,
        "\u00fcn\u00ef\u00e7\u00f8d\u00e9",  # non-ASCII text
        "\U0001f389",       # astral-plane codepoint, for surrogate-pair bugs
        "line1\nline2",
        "%s %d {}",         # format specifiers, for accidental interpolation
        "../../etc/passwd",
        "'; DROP TABLE t; --",
    ]


def _int_lists() -> list[Any]:
    base: list[Any] = [
        [],                 # empty: the len() == 0 divisor
        [0], [0, 0, 0], [1], [-1],
        [1, 2, 3], [3, 2, 1], [1, 1, 1], [-1, -2, -3],
        [sys.maxsize], [0, 1, -1],
        list(range(1000)),
    ]
    rng = random.Random(0x1157)
    return base + [
        [rng.randint(-100, 100) for _ in range(rng.randint(2, 12))]
        for _ in range(10)
    ]


def _float_lists() -> list[Any]:
    base: list[Any] = [
        [], [0.0],
        [float("nan")], [float("inf")], [float("-inf")],
        [0.0, 0.0], [1.0, 2.0, 3.0], [-1.0, -2.0], [0.1, 0.2, 0.3],
        [1e308, -1e308],
        [0.0, float("nan"), float("inf")],
    ]
    rng = random.Random(0x5EED)
    return base + [
        [rng.uniform(-100, 100) for _ in range(rng.randint(2, 12))]
        for _ in range(10)
    ]


def _str_lists() -> list[Any]:
    return [
        [], [""], ["a"], ["a", "b"], ["", ""], ["a", ""],
        ["\u00fcn\u00ef\u00f8d\u00e9"], ["x"] * 100, ["0"], ["a", "a"],
    ]


def _dicts() -> list[Any]:
    return [{}, {"a": 1}, {"a": 0}, {"": 1}, {"a": None},
            {"a": 1, "b": 2}, {"0": 0}]


def _mixed() -> list[Any]:
    """For unannotated parameters, which are the common case in real Python.

    Order matters as much as content. Plausible types come first and wrong
    types last: passing None to `a / b` raises TypeError, which is trivially
    easy to trigger and is the caller's mistake, so tried first it would bury
    the ZeroDivisionError worth knowing about.

    Numeric magnitudes belong here too, not just special values. With only
    special values plus 0/1/-1, `apply_discount` returning a negative price for
    `percent_off > 100` is unreachable, because every candidate above 100 was
    infinite or outside the stated precondition. Hence 101 and 150.

    Every value survives JSON transport, which is why `set()` is absent. A
    tuple arrives in the worker as a list.
    """
    return [
        0, 0.0, -0.0,
        # Empty containers. The list comes first because it is the collection a
        # Python signature most often means, and whichever empty value is tried
        # first becomes the reported trigger: `mean([])` beats `mean('')`.
        [], "", {}, (),
        # Populated collections, above the magnitude spread. Ranking these low
        # made a precondition as ordinary as "a non-empty list of finite
        # numbers" admit almost nothing.
        [1, 2, 3], [0, 0], [1.5, -2.5],
        1, -1, 2, 0.5, -0.5, 1.5,
        100, 101, 150, 1000, -100, 1_000_000,
        float("nan"), float("inf"), float("-inf"),
        2**200,
        False, True,
        None, "0", "abc", [0], [None],
    ]


# --- Annotation dispatch ---

_SCALARS: dict[str, Any] = {
    "int": _ints, "float": _floats, "complex": _floats,
    "str": _strings, "bytes": _strings,
    "bool": lambda: [False, True],
    "none": lambda: [None], "nonetype": lambda: [None],
}

_SEQUENCES: dict[str, Any] = {
    "list[int]": _int_lists, "list[bool]": _int_lists,
    "sequence[int]": _int_lists, "set": _int_lists,
    "list[float]": _float_lists, "sequence[float]": _float_lists,
    "list": _float_lists, "tuple": _float_lists,
    "iterable": _float_lists, "sequence": _float_lists,
    "list[str]": _str_lists, "sequence[str]": _str_lists,
}


def _normalise(annotation: str) -> tuple[str, bool]:
    """Fold an annotation to a lookup key, and report whether None is allowed.

    Optional[int], int | None and Union[int, None] all mean the caller may pass
    None, which must therefore be generated.
    """
    text = annotation.strip()
    for prefix in ("typing.", "t.", "collections.abc."):
        text = text.replace(prefix, "")
    lowered = text.lower().replace(" ", "")

    optional = False
    if lowered.startswith("optional[") and lowered.endswith("]"):
        optional = True
        lowered = lowered[len("optional["):-1]
    if lowered.startswith("union[") and lowered.endswith("]"):
        parts = lowered[len("union["):-1].split(",")
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

    Unknown and absent annotations both fall through to the mixed set: a wrong
    guess from a half-understood annotation is worse than admitting ignorance.
    """
    if annotation is None:
        return _mixed()

    key, optional = _normalise(annotation)

    if key in _SCALARS:
        values = list(_SCALARS[key]())
    elif key in _SEQUENCES:
        values = list(_SEQUENCES[key]())
    elif key.startswith(("dict", "mapping")):
        values = list(_dicts())
    elif key.startswith(("list", "sequence", "iterable", "tuple", "set",
                         "frozenset")):
        values = list(_float_lists())
    elif key in ("any", "object", ""):
        values = list(_mixed())
    else:
        # A user-defined class. Nothing sensible can be synthesised, so probe
        # the boundary conditions a caller might get wrong.
        return [None, 0, "", [], {}]

    if optional and None not in values:
        values.insert(0, None)
    return values


# --- Choosing unremarkable values ---


def _is_unremarkable(value: Any) -> bool:
    """Whether `value` is free of the properties that break functions."""
    if value is None or value is True or value is False:
        return False
    if isinstance(value, float):
        return not (value != value or value in (float("inf"), float("-inf"))
                    or value == 0)
    if isinstance(value, int):
        return value != 0
    if isinstance(value, (str, list, dict, set, tuple)):
        return len(value) > 0
    return True


def _first_ordinary(pool: list[Any]) -> Any:
    """The least remarkable value in `pool`.

    Used as the one-hot background, so a fault can be attributed to the single
    parameter holding an edge value, and to build receivers, where the goal is
    a working object.

    A scalar is preferred over a collection, because most parameters are
    scalars and a wrongly-typed background poisons every result that uses it.
    Returning `[1, 2, 3]` here built `NeedsConfig(host, port, retries)` with a
    list in every field, so `retries / attempt` reported a TypeError instead of
    the ZeroDivisionError that was the real defect.
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


def ordinary_arguments(signature: Signature) -> list[Any]:
    """One argument list of unremarkable values.

    The opposite of what the rest of this module is for. Used to build the
    receiver for an instance method, where a valid object is wanted: creating a
    Cart with 0 for its items is a good way to find a constructor bug and a bad
    way to get something to call `total` on.
    """
    return [
        _first_ordinary(values_for_annotation(p.annotation))
        for p in signature.callable_parameters
    ]


# --- Scheduling argument lists ---


class _Collector:
    """Accumulates argument lists, dropping duplicates, up to a limit.

    Compares by repr rather than value, since the corpora contain NaN and
    `float('nan') != float('nan')` would let identical inputs through.
    """

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.combos: list[list[Any]] = []
        self._seen: set[str] = set()

    def add(self, combo: list[Any]) -> bool:
        """Record `combo`. Returns True once the limit is reached."""
        if len(self.combos) >= self.limit:
            return True
        key = repr(combo)
        if key not in self._seen:
            self._seen.add(key)
            self.combos.append(combo)
        return len(self.combos) >= self.limit


def _product(pools: list[list[Any]], *, cap: int) -> list[list[Any]]:
    """Cartesian product, bounded. Depth-first, so early values come first."""
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


def generate_arguments(
    signature: Signature,
    *,
    limit: int = MAX_COMBINATIONS,
    seed: int = 0x8066,
) -> list[list[Any]]:
    """Argument lists to try, most promising first.

    An input is always a positional argument list, matching how the executor
    calls the target (`fn(*args)`), so a single list-valued argument stays one
    argument instead of being spread.

    Three phases. One-hot comes first and is the coverage guarantee: every value
    of every parameter is tried at least once against ordinary values
    elsewhere. A naive nested loop destroys that - investigating the stdlib's
    `fmean(data, weights)` under a "non-empty list of finite numbers"
    precondition executed zero inputs, because row-major order spent the whole
    budget with a scalar in the `data` slot.
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
    # most productive pair there is.
    collector.add([pool[0] for pool in pools])

    # Phase 1: one-hot.
    for index, pool in enumerate(pools):
        for value in pool:
            if collector.add([value if i == index else ordinary[i]
                              for i in range(len(pools))]):
                return collector.combos

    # Phase 2: combinations, for faults needing more than one bad argument. Two
    # parameters can afford a diagonal walk of the whole product, pairing low
    # indices of both first; wider signatures get a bounded product over each
    # parameter's leading edge values.
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
