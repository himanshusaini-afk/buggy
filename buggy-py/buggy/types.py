"""Core domain types.

Deliberately stdlib-only dataclasses rather than pydantic. The whole package
avoids third-party dependencies so it installs and runs anywhere a supported
Python does, including on 3.15 where several popular wheels do not exist yet.

@module buggy.types
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

# ─── Signatures ──────────────────────────────────────────────────────────────


class ParamKind(str, Enum):
    """How a parameter may be supplied at the call site."""

    POSITIONAL_ONLY = "positional_only"
    POSITIONAL_OR_KEYWORD = "positional_or_keyword"
    KEYWORD_ONLY = "keyword_only"
    VAR_POSITIONAL = "var_positional"  # *args
    VAR_KEYWORD = "var_keyword"  # **kwargs


@dataclass(frozen=True)
class Parameter:
    """One declared parameter.

    `annotation` is the source text of the annotation (e.g. ``int``,
    ``list[str]``), or None when the parameter is unannotated. Unannotated is
    normal and fine: the generator answers it with a mixed value set that still
    reaches the usual division-by-zero and empty-collection faults.
    """

    name: str
    annotation: str | None = None
    has_default: bool = False
    kind: ParamKind = ParamKind.POSITIONAL_OR_KEYWORD

    @property
    def is_variadic(self) -> bool:
        return self.kind in (ParamKind.VAR_POSITIONAL, ParamKind.VAR_KEYWORD)


@dataclass(frozen=True)
class Signature:
    """A function's call shape, recovered from source.

    Getting the arity right is the point. Calling a two-parameter function with
    one argument raises ``TypeError: f() missing 1 required positional
    argument``, which is a harness artifact that looks exactly like a defect.
    """

    parameters: tuple[Parameter, ...] = ()
    return_annotation: str | None = None

    @property
    def callable_parameters(self) -> tuple[Parameter, ...]:
        """Parameters that take one positional argument each.

        Excludes ``*args``/``**kwargs``, whose arity cannot be known from the
        signature, and keyword-only parameters, which are not positional.
        """
        return tuple(
            p
            for p in self.parameters
            if not p.is_variadic and p.kind is not ParamKind.KEYWORD_ONLY
        )

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(p.name for p in self.callable_parameters)


@dataclass(frozen=True)
class FunctionInfo:
    """A function found in a source file."""

    name: str
    """Bare name, e.g. ``budget_usage``."""
    qualified_name: str
    """Dotted path including any enclosing classes, e.g. ``Budget.usage``."""
    kind: str
    """One of ``function``, ``method``, ``async_function``, ``async_method``."""
    line: int
    """1-based line of the ``def``."""
    end_line: int
    signature: Signature
    is_nested: bool = False
    """True when defined inside another function, so not importable by name."""
    needs_receiver: bool = False
    """True for instance methods, whose first argument is ``self``."""
    decorators: tuple[str, ...] = ()
    is_property: bool = False
    owner: str | None = None
    """Qualified name of the enclosing class, when there is one. Needed to
    construct a receiver for an instance method."""
    is_dunder: bool = False
    """``__init__`` and friends. Their call protocols vary, so they are out of
    scope rather than guessed at."""


@dataclass(frozen=True)
class ClassInfo:
    """A class, and what it takes to build one."""

    name: str
    qualified_name: str
    line: int
    init: Signature | None = None
    """``__init__``'s signature with ``self`` removed, or None when the class
    declares no ``__init__`` (in which case it constructs with no arguments)."""
    init_is_variadic: bool = False
    """True when ``__init__`` accepts only ``*args``/``**kwargs``, so its real
    arity cannot be read from the signature."""
    bases: tuple[str, ...] = ()


# ─── Receivers ───────────────────────────────────────────────────────────────


class ReceiverKind(str, Enum):
    NONE = "none"
    """A plain function, staticmethod or classmethod. Nothing to construct."""
    CONSTRUCT = "construct"
    """Build the owning class with generated arguments."""
    EXPRESSION = "expression"
    """Build it from a user-supplied expression, evaluated in the module."""


@dataclass(frozen=True)
class Receiver:
    """How to obtain the object an instance method is called on.

    A fresh receiver is built for **every** call. Reusing one would let state
    mutated by an earlier call leak into a later one, which breaks the
    reproducibility pillar and makes any stateful method look non-deterministic.
    The cost is that defects which only appear after repeated calls on the same
    object are out of reach; that is a deliberate trade for sound results.
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
            inner = ", ".join(repr(a) for a in self.args)
            return f"{class_name}({inner})"
        return class_name

    def to_payload(self) -> dict[str, Any]:
        return {"kind": self.kind.value, "args": list(self.args), "source": self.source}


# ─── Specifications ──────────────────────────────────────────────────────────


class Verdict(str, Enum):
    """Outcome of evaluating one condition."""

    TRUE = "true"
    FALSE = "false"
    UNEVALUABLE = "unevaluable"
    """The condition could not be judged: it failed to compile, referenced an
    unbound name, or raised. This is reported, never silently treated as a pass.
    Conflating it with TRUE is what made specifications in the TypeScript
    implementation quietly do nothing."""


@dataclass(frozen=True)
class ConditionResult:
    verdict: Verdict
    reason: str | None = None
    """Why it was unevaluable. None when the verdict is TRUE or FALSE."""

    @property
    def holds(self) -> bool:
        return self.verdict is Verdict.TRUE


@dataclass
class FunctionSpec:
    """What the caller asserts about a function.

    Conditions are **Python** expressions. Parameter names are bound to their
    arguments, and postconditions additionally see ``result``.
    """

    name: str
    preconditions: list[str] = field(default_factory=list)
    postconditions: list[str] = field(default_factory=list)
    signature: Signature = field(default_factory=Signature)

    @property
    def parameter_names(self) -> tuple[str, ...]:
        return self.signature.names


# ─── Execution ───────────────────────────────────────────────────────────────


class Outcome(str, Enum):
    OK = "ok"
    """The call returned a value."""
    RAISED = "raised"
    """The call raised an exception that was caught and described."""
    TIMEOUT = "timeout"
    """Wall-clock or CPU budget exhausted; the worker was killed."""
    HARD_CRASH = "hard_crash"
    """The worker died without reporting (segfault, OOM kill, SystemExit)."""


@dataclass
class ExecResult:
    outcome: Outcome
    value: Any = None
    exception_type: str | None = None
    message: str | None = None
    traceback_text: str | None = None
    duration_ms: float = 0.0
    stderr: str | None = None
    """Captured only for HARD_CRASH, where there is no structured report."""
    fidelity: str = "exact"
    """``exact`` when `value` is the real return value, or ``coerced`` when the
    value could not cross the process boundary and `value` holds its ``repr``.
    Postconditions are not judged against a coerced value: a string stand-in
    would make ``result >= 0`` fail for reasons that have nothing to do with the
    function. The caller warns instead."""
    value_type: str | None = None
    """Name of the real return type, which survives even when the value does not."""

    @property
    def ok(self) -> bool:
        return self.outcome is Outcome.OK

    @property
    def failed(self) -> bool:
        return self.outcome is not Outcome.OK

    @property
    def value_is_usable(self) -> bool:
        """Whether `value` may be reasoned about."""
        return self.outcome is Outcome.OK and self.fidelity == "exact"


# ─── Findings ────────────────────────────────────────────────────────────────


class OracleKind(str, Enum):
    CRASH = "crash"
    TIMEOUT = "timeout"
    NON_FINITE = "non_finite"
    POSTCONDITION = "postcondition"
    NONDETERMINISM = "nondeterminism"


SEVERITY_TYPE_CONFUSION = 1
"""A failure caused by an argument of an obviously wrong type. Reported, but
only when nothing better was found: in a dynamically typed language, passing
``None`` where a number belongs is the caller's error, not the function's."""

SEVERITY_PROPAGATED = 2
"""A non-finite result that came from an already non-finite argument. The
function obeyed IEEE 754 rather than failing, so this is ranked below a result
the function manufactured itself."""

SEVERITY_NORMAL = 3
SEVERITY_STATED = 4
"""A property the user wrote down themselves, or a hang. Preferred over any
built-in check, because it is expressed in the user's own terms."""


@dataclass
class Violation:
    """A candidate defect: an input the function did not handle."""

    kind: OracleKind
    args: list[Any]
    result: Any
    rule: str
    """The property that was broken, in the user's own words where possible."""
    detail: str | None = None
    duration_ms: float = 0.0
    severity: int = SEVERITY_NORMAL
    """How informative this finding is. The search prefers a higher-severity
    finding over a lower one rather than simply taking the first it trips over,
    because a ``TypeError`` from passing ``None`` to an arithmetic function is
    trivially easy to produce and would otherwise mask the division-by-zero
    that the user actually needs to know about."""
    advice: str | None = None
    """What the user should do if this is the only finding, set by the oracle
    that knows why it is weak. Shown instead of leaving them to wonder why the
    reported trigger looks uninteresting."""


@dataclass
class Certificate:
    """A violation that survived all three verification pillars.

    Each pillar records when it passed, so a certificate carries its own audit
    trail rather than a bare boolean.
    """

    function: str
    file: str
    args: list[Any]
    observed: Any
    rule: str
    kind: OracleKind
    admissible_at: str
    """Preconditions were re-checked against this exact input and held."""
    sound_at: str
    """The failure was re-observed on a fresh execution."""
    reproducible_at: str
    """The failure recurred in at least 2 of 3 further executions."""
    reproductions: int = 0
    attempts: int = 0
    detail: str | None = None
    receiver: Receiver | None = None
    """How the object was built, for an instance method. Recorded because the
    reproduction is ``Cart([1, 2]).total(0)``, not ``total(0)`` — a certificate
    the reader cannot re-run is not evidence."""


@dataclass
class SpecWarning:
    """A condition that could not be evaluated.

    Surfaced to the user. A specification that silently does nothing is worse
    than no specification, because it reads as evidence of safety.
    """

    condition: str
    reason: str
    role: str
    """``precondition`` or ``postcondition``."""


@dataclass
class Report:
    """The result of investigating one function."""

    function: str
    file: str
    status: str
    """One of:

    ``proven``
        A failing input was found and survived all three pillars.
    ``unconfirmed``
        The function was executed and no failing input was found. Not a proof
        of safety.
    ``no_valid_input``
        The preconditions rejected every candidate, so the function was never
        called. Reported distinctly because calling this ``unconfirmed`` would
        present "we learned nothing" as "we found nothing wrong" — the exact
        silent failure this tool exists to avoid.
    ``skipped``
        The function could not be analysed or called at all; see ``note``.
    """
    certificate: Certificate | None = None
    violations: list[Violation] = field(default_factory=list)
    warnings: list[SpecWarning] = field(default_factory=list)
    executions: int = 0
    candidates: int = 0
    """Inputs generated, including those filtered out by preconditions."""
    filtered: int = 0
    """Inputs rejected because a precondition did not hold."""
    environment_errors: int = 0
    """Crashes attributed to the harness rather than the function."""
    duration_ms: float = 0.0
    note: str | None = None
    receiver: Receiver | None = None
    """How the object was built, for an instance method."""
