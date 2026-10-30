"""Fixture module exercising the shapes the analyser has to handle.

Mirrors the defects in the recorded example runs (division by a caller-supplied
value, averaging a possibly-empty collection, an unclamped percentage) plus the
signature forms that tripped the original implementation.
"""

import random


# ─── Proven-defect shapes ────────────────────────────────────────────────────

def divide(numerator, denominator):
    """BUG: denominator == 0 raises ZeroDivisionError."""
    return numerator / denominator


def mean(values):
    """BUG: an empty list raises ZeroDivisionError."""
    return sum(values) / len(values)


def apply_discount(price: float, percent_off: float) -> float:
    """BUG: percent_off > 100 yields a negative price."""
    return price - price * (percent_off / 100)


def ratio(a: float, b: float) -> float:
    """BUG: 0/0 returns NaN rather than raising."""
    if b == 0 and a == 0:
        return float("nan")
    return a / b


def flaky(x: int) -> int:
    """BUG: not deterministic."""
    return x + random.randint(0, 1)


def hangs(n: int) -> int:
    """BUG: never returns."""
    while True:
        n += 1


# ─── Clean ───────────────────────────────────────────────────────────────────

def clamp_percent(value: float) -> float:
    """Bounded by construction, so it cannot leave [0, 100]."""
    return max(0.0, min(100.0, value))


def monthly(yearly: float) -> float:
    """The divisor is a non-zero constant."""
    return yearly / 12


def length(items):
    """Clean for anything sized; raises TypeError for a number.

    Used to exercise the case where the only reachable failure is an argument of
    the wrong type. The result is always an int, so no numeric oracle can fire.
    """
    return len(items)


# ─── Signature forms ─────────────────────────────────────────────────────────

def annotated(count: int, label: str, *, scale: float = 1.0) -> str:
    return f"{label}:{count * scale}"


def positional_only(a, b, /, c=3):
    return a + b + c


def variadic(first, *rest, **options):
    return first


async def async_fn(x: int) -> int:
    return x


class Calculator:
    """Class-scoped functions, which need different handling from each other."""

    factor = 2

    def instance_method(self, value):
        """Needs a receiver, so it cannot be called with generated arguments."""
        return value * self.factor

    @staticmethod
    def static_divide(a, b):
        """BUG: b == 0 raises. Callable without a receiver."""
        return a / b

    @classmethod
    def describe(cls, prefix):
        return f"{prefix}{cls.__name__}"

    @property
    def value(self):
        return 42

    class Nested:
        @staticmethod
        def deep(x):
            return x


def outer(x):
    """Contains a function that is unreachable by name once this returns."""

    def inner(y):
        return y * 2

    return inner(x)
