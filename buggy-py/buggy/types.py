"""Domain types.

Stdlib dataclasses rather than pydantic, so the package has no dependencies and
installs on any supported Python.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

# --- Signatures ---


class ParamKind(str, Enum):
    POSITIONAL_ONLY = "positional_only"
    POSITIONAL_OR_KEYWORD = "positional_or_keyword"
    KEYWORD_ONLY = "keyword_only"
    VAR_POSITIONAL = "var_positional"
    VAR_KEYWORD = "var_keyword"


@dataclass(frozen=True)
class Parameter:
    """One declared parameter. `annotation` is source text, or None."""

    name: str
    annotation: str | None = None
    has_default: bool = False
    kind: ParamKind = ParamKind.POSITIONAL_OR_KEYWORD

    @property
    def is_variadic(self) -> bool:
        return self.kind in (ParamKind.VAR_POSITIONAL, ParamKind.VAR_KEYWORD)


@dataclass(frozen=True)
class Signature:
    """A function's call shape."""

    parameters: tuple[Parameter, ...] = ()
    return_annotation: str | None = None

    @property
    def callable_parameters(self) -> tuple[Parameter, ...]:
        """Parameters taking one positional argument each.

        Getting this right matters: calling a two-parameter function with one
        argument raises TypeError, which looks exactly like a defect.
        """
        return tuple(
            p for p in self.parameters
            if not p.is_variadic and p.kind is not ParamKind.KEYWORD_ONLY
        )

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(p.name for p in self.callable_parameters)


@dataclass(frozen=True)
class FunctionInfo:
    """A function found in a source file."""

    name: str
    qualified_name: str
    """Dotted path including enclosing classes, e.g. `Budget.usage`."""
    kind: str
    """`function`, `method`, `async_function` or `async_method`."""
    line: int
    end_line: int
    signature: Signature
    is_nested: bool = False
    """Defined inside another function, so unreachable by name."""
    needs_receiver: bool = False
    """An instance method, whose first argument is `self`."""
    decorators: tuple[str, ...] = ()
    is_property: bool = False
    owner: str | None = None
    """Qualified name of the enclosing class, if any."""
    is_dunder: bool = False


@dataclass(frozen=True)
class ClassInfo:
    """A class, and what it takes to build one."""

    name: str
    qualified_name: str
    line: int
    init: Signature | None = None
    """`__init__` with `self` removed, or None when the class declares none."""
    init_is_variadic: bool = False
    """`__init__` takes only *args/**kwargs, so its arity is unknowable."""


# --- Receivers ---


class ReceiverKind(str, Enum):
    NONE = "none"
    """A plain function, staticmethod or classmethod."""
    CONSTRUCT = "construct"
    EXPRESSION = "expression"


@dataclass(frozen=True)
class Receiver:
    """How to obtain the object an instance method is called on.

    Built fresh for every call. Reusing one would let state from an earlier call
    change a later one, breaking reproducibility and making any stateful method
    look non-deterministic. The trade is that defects needing several calls on
    one object are out of reach.
    """

    kind: ReceiverKind = ReceiverKind.NONE
    args: tuple[Any, ...] = ()
    source: str | None = None
    """The expression, when `kind` is EXPRESSION."""

    @property
    def needed(self) -> bool:
        return self.kind is not ReceiverKind.NONE

    def render(self, class_name: str) -> str:
        """How a user would write this construction themselves."""
        if self.kind is ReceiverKind.EXPRESSION:
            return self.source or class_name
        if self.kind is ReceiverKind.CONSTRUCT:
            return f"{class_name}({', '.join(repr(a) for a in self.args)})"
        return class_name

    def to_payload(self) -> dict[str, Any]:
        return {"kind": self.kind.value, "args": list(self.args),
                "source": self.source}


# --- Specifications ---


class Verdict(str, Enum):
    TRUE = "true"
    FALSE = "false"
    UNEVALUABLE = "unevaluable"
    """Could not be judged: failed to compile, referenced an unbound name, or
    raised. Reported, never treated as a pass. Conflating this with TRUE is what
    made specifications silently do nothing in the TypeScript implementation."""


@dataclass(frozen=True)
class ConditionResult:
    verdict: Verdict
    reason: str | None = None

    @property
    def holds(self) -> bool:
        return self.verdict is Verdict.TRUE


# --- Execution ---


class Outcome(str, Enum):
    OK = "ok"
    RAISED = "raised"
    TIMEOUT = "timeout"
    HARD_CRASH = "hard_crash"
    """The worker died without reporting: segfault, OOM kill, SystemExit."""


@dataclass
class ExecResult:
    outcome: Outcome
    value: Any = None
    exception_type: str | None = None
    message: str | None = None
    traceback_text: str | None = None
    duration_ms: float = 0.0
    stderr: str | None = None
    """Captured only for HARD_CRASH, which has no structured report."""
    fidelity: str = "exact"
    """`coerced` when the value could not cross the process boundary and
    `value` holds its repr. Postconditions are not judged against a stand-in."""
    value_type: str | None = None
    """The real return type, which survives even when the value does not."""

    @property
    def ok(self) -> bool:
        return self.outcome is Outcome.OK

    @property
    def failed(self) -> bool:
        return self.outcome is not Outcome.OK

    @property
    def value_is_usable(self) -> bool:
        return self.outcome is Outcome.OK and self.fidelity == "exact"


# --- Findings ---


class OracleKind(str, Enum):
    CRASH = "crash"
    TIMEOUT = "timeout"
    NON_FINITE = "non_finite"
    POSTCONDITION = "postcondition"
    NONDETERMINISM = "nondeterminism"


SEVERITY_TYPE_CONFUSION = 1
"""An argument of an obviously wrong type. Reported only if nothing better is
found: passing None where a number belongs is the caller's error."""

SEVERITY_PROPAGATED = 2
"""A non-finite result from an already non-finite argument. The function obeyed
IEEE 754 rather than failing."""

SEVERITY_NORMAL = 3

SEVERITY_STATED = 4
"""A property the user wrote down, or a hang. Preferred over any built-in
check, being in the user's own terms."""


@dataclass
class Violation:
    """A candidate defect: an input the function did not handle."""

    kind: OracleKind
    args: list[Any]
    result: Any
    rule: str
    """The property broken, in the user's words where possible."""
    detail: str | None = None
    duration_ms: float = 0.0
    severity: int = SEVERITY_NORMAL
    """The search prefers a higher-severity finding over the first one it trips
    over, so a trivially-produced TypeError cannot mask a division by zero."""
    advice: str | None = None
    """What to do if this is the only finding, set by the oracle that knows
    why it is weak."""


@dataclass
class Certificate:
    """A violation that survived all three pillars.

    Each pillar records when it passed, so the certificate carries its own
    audit trail rather than a bare boolean.
    """

    function: str
    file: str
    args: list[Any]
    observed: Any
    rule: str
    kind: OracleKind
    admissible_at: str
    """Preconditions were re-checked against this input and held."""
    sound_at: str
    """The failure was re-observed on a fresh execution."""
    reproducible_at: str
    """It recurred in at least 2 of 3 further executions."""
    reproductions: int = 0
    attempts: int = 0
    detail: str | None = None
    receiver: Receiver | None = None
    """How the object was built, for an instance method. The reproduction is
    `Cart([1, 2]).total(0)`, not `total(0)`; a certificate the reader cannot
    re-run is not evidence."""


@dataclass
class SpecWarning:
    """A condition that could not be evaluated.

    Always surfaced. A specification that silently does nothing is worse than
    none, because it reads as evidence of safety.
    """

    condition: str
    reason: str
    role: str
    """`precondition` or `postcondition`."""


@dataclass
class Report:
    """The result of investigating one function."""

    function: str
    file: str
    status: str
    """`proven`, `unconfirmed`, `no_valid_input` or `skipped`.

    `no_valid_input` is kept separate because calling it `unconfirmed` would
    present "we learned nothing" as "we found nothing wrong".
    """
    certificate: Certificate | None = None
    violations: list[Violation] = field(default_factory=list)
    warnings: list[SpecWarning] = field(default_factory=list)
    executions: int = 0
    candidates: int = 0
    """Inputs generated, including those a precondition filtered out."""
    filtered: int = 0
    environment_errors: int = 0
    """Crashes attributed to the harness rather than the function."""
    duration_ms: float = 0.0
    note: str | None = None
    receiver: Receiver | None = None
