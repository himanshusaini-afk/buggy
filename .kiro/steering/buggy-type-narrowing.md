---
inclusion: manual
---

# Buggy - Preventing a Proven Defect by Construction

When Buggy proves a defect, the runtime guard is the quick fix. The better
question is whether the bad input could have been impossible to pass in.

Python's annotations are not enforced at runtime, so a type hint alone prevents
nothing. What works is validating once at the boundary and carrying a value
whose existence proves it was checked.

## Triggering Phrases

- "how do I prevent this properly?"
- "stop this class of bug"
- "make this type-safe"
- "strengthen the types"

## Workflow

After `buggy_investigate` returns a certificate, look at the trigger input and
ask where it entered the system. The guard belongs at that boundary, not in
every function downstream.

## Pattern: Unbounded numeric input

**Proven:** `apply_discount(100, 150)` returns `-50`, breaking `result >= 0`.

A guard inside `apply_discount` fixes this function. Every other function
taking a percentage still has the bug.

```python
from typing import NewType

Percent = NewType("Percent", float)

def as_percent(value: float) -> Percent:
    """Validate once, at the edge where the number arrives."""
    if not 0 <= value <= 100:
        raise ValueError(f"{value} is not a percentage")
    return Percent(value)

def apply_discount(price: float, percent_off: Percent) -> float:
    return price - price * percent_off / 100
```

A `Percent` can only come from `as_percent`, so every caller has been checked.
A type checker flags a raw `float` passed in; at runtime the validation already
happened.

## Pattern: Division by an empty collection

**Proven:** `average([])` raises `ZeroDivisionError`.

```python
from typing import Sequence, TypeVar

T = TypeVar("T")

def average(values: Sequence[float]) -> float | None:
    """None is an honest answer. The average of nothing is not a number."""
    if not values:
        return None
    return sum(values) / len(values)
```

Returning `None` forces the caller to decide what an empty input means. If the
caller genuinely cannot handle it, make non-emptiness the precondition and
raise instead - but then say so in the docstring, so Buggy reads it as the
contract rather than a defect.

## Pattern: Money as a float

**Proven:** repeated addition of `0.1` drifts, breaking an exact-total
postcondition.

```python
from decimal import Decimal

def total(prices: list[Decimal]) -> Decimal:
    return sum(prices, Decimal("0"))
```

`Decimal` makes the drift impossible rather than tolerated. If floats must
stay, state the tolerance in the postcondition instead of pretending to
exactness.

## Pattern: A value that may be absent

**Proven:** the caller assumed a value and got `None`, raising `AttributeError`.

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class Found:
    user: User

@dataclass(frozen=True)
class NotFound:
    reason: str

def find_user(user_id: str) -> Found | NotFound:
    ...
```

A union the caller must narrow beats a bare `Optional` that is easy to forget.
`match` or an `isinstance` check makes the missing case visible.

## Pattern: A constrained set of values

**Proven:** an unexpected status string fell through every branch and returned
`None`.

```python
from enum import Enum

class Status(Enum):
    ACTIVE = "active"
    CLOSED = "closed"
```

An `Enum` makes an invalid status unconstructable. With `Literal["active",
"closed"]` a type checker can also prove the match is exhaustive.

## Pattern: Non-determinism

**Proven:** the same input gave different answers across runs (found with
`--determinism`).

```python
from typing import Protocol

class RandomSource(Protocol):
    def random(self) -> float: ...

def loyalty_points(total: float, rng: RandomSource) -> int:
    bonus = 10 if rng.random() > 0.5 else 0
    return int(total // 10) + bonus
```

Injecting the randomness makes the function deterministic for a fixed source,
which is what makes it testable at all.

## Pattern: Validated construction

**Proven:** an object was built in an invalid state and failed later, far from
the cause.

```python
@dataclass(frozen=True)
class CartItem:
    price: Decimal
    quantity: int

    def __post_init__(self) -> None:
        if self.price < 0:
            raise ValueError("price must not be negative")
        if self.quantity < 1:
            raise ValueError("quantity must be at least 1")
```

`frozen=True` means it cannot drift into invalidity afterwards. This also helps
Buggy: an invalid receiver now fails loudly at construction instead of
producing a confusing defect in an unrelated method.

## Presentation Format

```
Preventing this by construction

Proven:  apply_discount(100, 150) returns -50, breaking result >= 0

Runtime fix:    clamp percent_off inside apply_discount
Structural fix: accept Percent instead of float, validated by as_percent
                at the point the number enters the system

The runtime fix repairs this function. The structural one also covers the
three other functions taking a percentage, and moves the check to the
boundary where the value arrives.

Want the runtime guard now, the structural change, or both?
```

Offer both and let the user choose. A verified patch from `buggy_repair` is
ready to apply today; the structural change touches callers and is a larger
decision.
