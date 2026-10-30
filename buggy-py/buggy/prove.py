"""Finds a failing input and verifies it three ways before reporting it.

The claim "proof-carrying" means something specific and limited here, and it is
worth stating plainly: there is no solver and no symbolic reasoning. A finding
is a *certificate of observed failure*. It says that this exact input was run,
that it satisfied the stated preconditions, that the failure was re-observed on
a fresh process, and that it recurred on repeat attempts. That is a strong
guarantee against false positives and no guarantee at all about inputs that
were never tried.

The three pillars:

**Admissibility** — the triggering input satisfies every precondition. Without
this a "bug" may just be a call the caller promised never to make. Unlike the
original implementation, a precondition that cannot be *evaluated* blocks
certification rather than being skipped, because an unevaluable precondition
means admissibility is unknown, and unknown is not the same as satisfied.

**Soundness** — the function is run again, in a fresh worker, and the failure is
observed a second time. This catches findings that were an artefact of earlier
state in the worker process.

**Reproducibility** — three further runs, of which at least two must reproduce
the same class of failure. The majority rule tolerates a genuinely flaky
environment without accepting a one-off.

@module buggy.prove
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import oracles
from .executor import Executor, ExecutorError
from .generate import MAX_COMBINATIONS, generate_arguments, ordinary_arguments
from .inspection import (
    SourceSyntaxError,
    describe_unsupported,
    find_classes,
    find_function,
    find_functions,
)
from .specs import (
    Condition,
    SpecSyntaxError,
    build_bindings,
    compile_condition,
    preconditions_hold,
)
from .types import (
    SEVERITY_NORMAL,
    Certificate,
    ClassInfo,
    ExecResult,
    FunctionInfo,
    FunctionSpec,
    OracleKind,
    Outcome,
    Receiver,
    ReceiverKind,
    Report,
    Signature,
    SpecWarning,
    Verdict,
    Violation,
)

__all__ = ["Config", "investigate", "investigate_file", "candidate_calls"]

REPRODUCTION_ATTEMPTS = 3
REPRODUCTIONS_REQUIRED = 2
"""Two of three. One reproduction could be luck; three in three would reject
findings in any environment with real jitter."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class Config:
    """Search and execution budget."""

    max_executions: int = MAX_COMBINATIONS
    """Inputs actually executed. Inputs rejected by a precondition do not count
    against this: a strict precondition would otherwise exhaust the budget
    before the function had been called more than a handful of times, quietly
    gutting coverage."""

    timeout: float = 2.0
    """Wall-clock budget per call, in seconds."""

    cpu_seconds: int = 10
    """Hard CPU ceiling for a worker, enforced by the OS."""

    determinism_checks: int = 0
    """Repeat executions per input to look for nondeterminism. Costs one extra
    execution per input per check, so it is off by default; the reproducibility
    pillar already re-runs anything that looks like a failure."""

    determinism_sample: int = 16
    """When determinism checking is on, check every Nth input rather than all."""

    stop_at_first: bool = True
    """Stop searching once a violation is certified. Finding the second bug in a
    function is rarely useful before the first one is fixed."""

    python: str | None = None
    address_mb: int | None = None
    seed: int = 0x8066

    receiver: str | None = None
    """An expression that builds the object an instance method is called on,
    e.g. ``Cart(items=[1, 2])``. Evaluated in the target module. When omitted,
    one is constructed from the class's own ``__init__`` signature."""

    max_receiver_attempts: int = 12
    """How many constructions to try before giving up on building a receiver."""


# ─── Specification handling ──────────────────────────────────────────────────


@dataclass
class _Spec:
    preconditions: list[Condition] = field(default_factory=list)
    postconditions: list[Condition] = field(default_factory=list)
    warnings: list[SpecWarning] = field(default_factory=list)


def _compile_spec(spec: FunctionSpec) -> _Spec:
    """Compile conditions, collecting a warning for each one that cannot be.

    This is the single most important behavioural difference from the original.
    There, conditions were compiled as JavaScript and every failure was
    swallowed, so a Python-syntax condition against a Python target did nothing
    and the investigation reported "no bug found" — indistinguishable from
    genuine safety. Here each failure is surfaced with the reason and, when the
    text looks like JavaScript, the Python equivalent.
    """
    out = _Spec()
    for role, texts, sink in (
        ("precondition", spec.preconditions, out.preconditions),
        ("postcondition", spec.postconditions, out.postconditions),
    ):
        for text in texts:
            try:
                sink.append(compile_condition(text))
            except SpecSyntaxError as exc:
                out.warnings.append(SpecWarning(condition=text, reason=str(exc), role=role))
    return out


_preconditions_hold = preconditions_hold
"""Shared with :mod:`buggy.repair`, which needs the same judgement to decide
which inputs a patch is allowed to change."""


# ─── Verification ────────────────────────────────────────────────────────────


def _choose_receiver(
    executor: Executor,
    info: FunctionInfo,
    classes: dict[str, ClassInfo],
    config: Config,
) -> tuple[Receiver | None, str | None]:
    """Find a way to build the object an instance method is called on.

    Candidates are tried in order of how likely they are to produce a *valid*
    object, which is the reverse of how arguments are generated elsewhere: the
    goal here is something to call the method on, not a broken constructor.

    @returns (receiver, reason_if_impossible).
    """
    if config.receiver:
        receiver = Receiver(ReceiverKind.EXPRESSION, source=config.receiver)
        if not info.needs_receiver:
            # Supplying one for a plain function is a mistake worth naming
            # rather than quietly ignoring.
            return Receiver(), None
        ok, why = executor.can_construct(info.owner or "", receiver)
        return (receiver, None) if ok else (None, f"--receiver failed: {why}")

    if not info.needs_receiver:
        return Receiver(), None

    owner = classes.get(info.owner or "")
    if owner is None:
        return None, f"class {info.owner!r} not found"

    candidates: list[tuple[Any, ...]] = []
    init = owner.init
    if init is None or not init.callable_parameters:
        candidates.append(())
    else:
        required = [p for p in init.callable_parameters if not p.has_default]
        if not required:
            candidates.append(())
        candidates.append(tuple(ordinary_arguments(init)))
        for args in generate_arguments(init, limit=config.max_receiver_attempts):
            candidates.append(tuple(args))

    seen: set[str] = set()
    last: str | None = None
    attempts = 0
    for args in candidates:
        key = repr(args)
        if key in seen:
            continue
        seen.add(key)
        attempts += 1
        if attempts > config.max_receiver_attempts:
            break
        receiver = Receiver(ReceiverKind.CONSTRUCT, args=args)
        ok, why = executor.can_construct(owner.qualified_name, receiver)
        if ok:
            return receiver, None
        last = why

    return None, (
        f"could not build a {owner.name} to call the method on after "
        f"{attempts} attempt(s). Last failure: {last}. "
        f"Pass --receiver '{owner.name}(...)' to supply one."
    )


def candidate_calls(
    signature: Signature,
    init: Signature | None = None,
    receiver: Receiver | None = None,
    *,
    limit: int = MAX_COMBINATIONS,
    seed: int = 0x8066,
) -> list[tuple[Receiver | None, list[Any]]]:
    """The calls an investigation would try, for callers that need the same set.

    Used by :mod:`buggy.repair` to re-run exactly what the search ran, so a
    patch is judged against the inputs that actually exercised the function.
    """
    return _candidate_calls(signature, init, receiver, limit=limit, seed=seed)


def _candidate_calls(
    signature: Signature,
    init: Signature | None,
    base: Receiver | None,
    *,
    limit: int,
    seed: int,
) -> list[tuple[Receiver | None, list[Any]]]:
    """Every (receiver, arguments) pair to try, most attributable first.

    A method's real input space is the **product of its constructor arguments
    and its own**. Varying only the latter misses a whole class of defect:
    ``Cart.average_price()`` takes no arguments at all, and its
    ZeroDivisionError lives entirely in ``Cart([])``. Searching only method
    arguments would report it clean.

    The two phases keep blame legible:

    1. a known-good receiver against every generated argument list, so a finding
       is unambiguously about the method's own arguments;
    2. generated constructor arguments against ordinary method arguments, which
       finds defects that depend on the object's state.

    Constructor arguments that fail to build are not charged to the budget; see
    the ReceiverConstructionFailed branch in :func:`_search`.
    """
    method_args = generate_arguments(signature, limit=limit, seed=seed)

    if base is None or not base.needed:
        return [(base, args) for args in method_args]

    pairs: list[tuple[Receiver | None, list[Any]]] = [
        (base, args) for args in method_args
    ]

    if init is not None and init.callable_parameters:
        ordinary_method = ordinary_arguments(signature)
        seen = {repr(base.args)}
        for ctor_args in generate_arguments(init, limit=limit, seed=seed):
            key = repr(tuple(ctor_args))
            if key in seen:
                continue
            seen.add(key)
            pairs.append(
                (Receiver(ReceiverKind.CONSTRUCT, args=tuple(ctor_args)),
                 list(ordinary_method))
            )

    return pairs


def _same_failure(violation: Violation, result: ExecResult, spec: _Spec,
                  names: tuple[str, ...]) -> bool:
    """Whether `result` exhibits the same failure class as `violation`."""
    if violation.kind is OracleKind.CRASH:
        return result.outcome is Outcome.RAISED and not oracles.is_environment_error(result)
    if violation.kind is OracleKind.TIMEOUT:
        return result.outcome is Outcome.TIMEOUT
    if violation.kind is OracleKind.NON_FINITE:
        return oracles.check_non_finite(result, violation.args) is not None
    if violation.kind is OracleKind.POSTCONDITION:
        found, _ = oracles.check_postconditions(
            spec.postconditions, result, violation.args, names
        )
        return found is not None
    if violation.kind is OracleKind.NONDETERMINISM:
        # Verified by its own path; see _certify.
        return True
    return False


def _certify(
    executor: Executor,
    target: str,
    file: str,
    violation: Violation,
    spec: _Spec,
    names: tuple[str, ...],
    config: Config,
    receiver: Receiver | None = None,
    init_names: tuple[str, ...] = (),
) -> tuple[Certificate | None, str | None]:
    """Run the three pillars. Returns the certificate, or None and a reason."""
    # Pillar 1: admissibility.
    admissible, why = _preconditions_hold(
        spec.preconditions, violation.args, names, init_names,
        tuple(receiver.args) if receiver is not None else (),
    )
    if not admissible:
        return None, f"not certified — {why}"
    admissible_at = _now()

    # Nondeterminism is verified by its own definition rather than by re-running
    # a single expected outcome: the finding *is* that outcomes disagree.
    if violation.kind is OracleKind.NONDETERMINISM:
        results = executor.call_many(
            target, violation.args, 5, timeout=config.timeout, receiver=receiver
        )
        if not oracles.outcomes_differ(results):
            return None, "not certified — the outcome was consistent on re-execution"
        stamp = _now()
        return (
            Certificate(
                function=target, file=file, args=violation.args,
                observed=[r.value for r in results], rule=violation.rule,
                kind=violation.kind, admissible_at=admissible_at,
                sound_at=stamp, reproducible_at=stamp,
                reproductions=len(results), attempts=len(results),
                detail=violation.detail, receiver=receiver,
            ),
            None,
        )

    # Pillar 2: soundness — observe it again on a fresh execution.
    rerun = executor.call(
        target, violation.args, timeout=config.timeout, receiver=receiver
    )
    if not _same_failure(violation, rerun, spec, names):
        return None, "not certified — the failure did not recur on re-execution"
    sound_at = _now()

    # Pillar 3: reproducibility — majority of further attempts.
    repeats = executor.call_many(
        target, violation.args, REPRODUCTION_ATTEMPTS,
        timeout=config.timeout, receiver=receiver,
    )
    reproduced = sum(1 for r in repeats if _same_failure(violation, r, spec, names))
    if reproduced < REPRODUCTIONS_REQUIRED:
        return None, (
            f"not certified — reproduced only {reproduced} of "
            f"{REPRODUCTION_ATTEMPTS} times"
        )

    return (
        Certificate(
            function=target, file=file, args=violation.args,
            observed=violation.result, rule=violation.rule, kind=violation.kind,
            admissible_at=admissible_at, sound_at=sound_at,
            reproducible_at=_now(), reproductions=reproduced,
            attempts=REPRODUCTION_ATTEMPTS, detail=violation.detail,
            receiver=receiver,
        ),
        None,
    )


# ─── Entry points ────────────────────────────────────────────────────────────


def investigate(
    path: str | Path,
    function: str,
    *,
    preconditions: list[str] | None = None,
    postconditions: list[str] | None = None,
    config: Config | None = None,
    executor: Executor | None = None,
) -> Report:
    """Investigate one function.

    @param path: file containing the function.
    @param function: bare or qualified name (``usage`` or ``Budget.usage``).
    @param preconditions: Python expressions over the parameter names.
    @param postconditions: Python expressions, which may also use ``result``.
    @param executor: reuse an existing worker, for investigating several
        functions in one file without reloading the module each time.
    """
    config = config or Config()
    file_path = Path(path)
    started = time.perf_counter()

    def finish(report: Report) -> Report:
        report.duration_ms = (time.perf_counter() - started) * 1000
        return report

    try:
        source = file_path.read_text(encoding="utf-8")
    except OSError as exc:
        return finish(Report(function=function, file=str(file_path),
                             status="skipped", note=f"could not read file: {exc}"))

    try:
        info = find_function(source, function, str(file_path))
    except SourceSyntaxError as exc:
        return finish(Report(function=function, file=str(file_path),
                             status="skipped", note=str(exc)))

    if info is None:
        available = ", ".join(
            f.qualified_name for f in find_functions(source, str(file_path))
        ) or "none"
        return finish(Report(
            function=function, file=str(file_path), status="skipped",
            note=f"function not found. Available: {available}",
        ))

    classes = find_classes(source, str(file_path))
    unsupported = describe_unsupported(
        info, classes, receiver_supplied=bool(config.receiver)
    )
    if unsupported:
        return finish(Report(function=function, file=str(file_path),
                             status="skipped", note=unsupported))

    spec = _compile_spec(FunctionSpec(
        name=info.qualified_name,
        preconditions=list(preconditions or []),
        postconditions=list(postconditions or []),
        signature=info.signature,
    ))
    names = info.signature.names

    owned = executor is None
    if owned:
        try:
            executor = Executor(
                source, filename=str(file_path), python=config.python,
                timeout=config.timeout, cpu_seconds=config.cpu_seconds,
                address_mb=config.address_mb,
            )
        except ExecutorError as exc:
            return finish(Report(function=function, file=str(file_path),
                                 status="skipped", warnings=spec.warnings,
                                 note=str(exc)))

    assert executor is not None
    try:
        if executor.load_error is not None:
            err = executor.load_error
            return finish(Report(
                function=function, file=str(file_path), status="skipped",
                warnings=spec.warnings,
                note=(f"the module failed to load, so nothing can be proven: "
                      f"{err.exception_type}: {err.message}"),
            ))

        receiver, why = _choose_receiver(executor, info, classes, config)
        if receiver is None:
            # Nothing can be called, so say that rather than investigating a
            # method that never runs and calling the silence "unconfirmed".
            return finish(Report(
                function=function, file=str(file_path), status="skipped",
                warnings=spec.warnings, note=why,
            ))

        owner = classes.get(info.owner or "")
        return finish(_search(
            executor, info.qualified_name, str(file_path), info.signature,
            spec, names, config, receiver,
            init=owner.init if owner is not None else None,
        ))
    finally:
        if owned:
            executor.close()


def _search(
    executor: Executor,
    target: str,
    file: str,
    signature: Signature,
    spec: _Spec,
    names: tuple[str, ...],
    config: Config,
    receiver: Receiver | None = None,
    init: Signature | None = None,
) -> Report:
    """Generate, filter, execute, check, verify."""
    report = Report(function=target, file=file, status="unconfirmed",
                    warnings=list(spec.warnings), receiver=receiver)
    init_names = init.names if init is not None else ()

    candidates = _candidate_calls(
        signature, init, receiver,
        limit=max(config.max_executions * 2, 32), seed=config.seed,
    )
    report.candidates = len(candidates)

    unevaluable_posts: dict[str, str] = {}
    best: Violation | None = None
    best_receiver: Receiver | None = None
    """The most informative low-severity finding seen so far, used only if
    nothing better is found before the budget runs out."""

    for index, (call_receiver, args) in enumerate(candidates):
        if report.executions >= config.max_executions:
            break

        admissible, _ = _preconditions_hold(
            spec.preconditions, args, names,
            init_names,
            tuple(call_receiver.args) if call_receiver is not None else (),
        )
        if not admissible:
            report.filtered += 1
            continue

        report.executions += 1
        try:
            result = executor.call(
                target, args, timeout=config.timeout, receiver=call_receiver
            )
        except ExecutorError:
            # The input could not be handed to the worker. A harness limit, not
            # a defect: skip it rather than report it.
            report.executions -= 1
            report.environment_errors += 1
            continue

        if result.exception_type == "ReceiverConstructionFailed":
            # The object could not be built with these constructor arguments, so
            # the method never ran. Nothing was learned, and it must not be
            # charged to the budget or blamed on the method.
            report.executions -= 1
            report.environment_errors += 1
            continue

        violation = oracles.check_timeout(result, args, config.timeout)

        if violation is None:
            violation = oracles.check_crash(result, args)
            if violation is None and result.outcome in (
                Outcome.RAISED, Outcome.HARD_CRASH
            ):
                report.environment_errors += 1
                continue

        if violation is None:
            # The user's own postconditions are checked before the built-in
            # non-finite oracle. When a function returns NaN *and* the user
            # said `result >= 0`, both are true, and reporting the broken rule
            # in their words is more useful than reporting the NaN.
            violation, outcomes = oracles.check_postconditions(
                spec.postconditions, result, args, names
            )
            for condition, outcome in outcomes:
                if outcome.verdict is Verdict.UNEVALUABLE and outcome.reason:
                    unevaluable_posts.setdefault(condition.source, outcome.reason)

        if violation is None:
            violation = oracles.check_non_finite(result, args)

        if violation is None and config.determinism_checks > 0 \
                and index % config.determinism_sample == 0:
            repeats = executor.call_many(
                target, args, config.determinism_checks,
                timeout=config.timeout, receiver=receiver,
            )
            report.executions += len(repeats)
            violation = oracles.check_determinism([result, *repeats], args)

        if violation is None:
            continue

        report.violations.append(violation)

        if violation.severity < SEVERITY_NORMAL:
            # Informative enough to report if it is all we find, not informative
            # enough to stop looking. Keep searching for something better.
            if best is None or violation.severity > best.severity:
                best, best_receiver = violation, call_receiver
            continue

        certificate, why = _certify(
            executor, target, file, violation, spec, names, config,
            call_receiver, init_names,
        )
        if certificate is not None:
            report.certificate = certificate
            report.receiver = call_receiver
            report.status = "proven"
            if config.stop_at_first:
                break
        elif why:
            report.note = why

    # The function was never actually called, so nothing was learned about it.
    # Saying "unconfirmed" here would present an absence of evidence as
    # evidence of absence, which is the failure mode this tool is built against.
    if report.executions == 0 and report.filtered > 0:
        report.status = "no_valid_input"
        report.note = (
            f"the preconditions rejected all {report.filtered} candidate "
            "inputs, so the function was never called. Relax them, or widen the "
            "parameter annotations so inputs of the right shape are generated."
        )
        return report

    # Nothing better turned up, so certify the weaker finding rather than
    # discard it. Reporting "unconfirmed" when a genuine failing input is in
    # hand would be the worst of both worlds.
    if report.certificate is None and best is not None:
        certificate, why = _certify(
            executor, target, file, best, spec, names, config,
            best_receiver, init_names,
        )
        if certificate is not None:
            report.certificate = certificate
            report.receiver = best_receiver
            report.status = "proven"
            report.note = best.advice
        elif why:
            report.note = why

    # A postcondition that never evaluated is reported, because the user is
    # entitled to know their stated property was not actually checked.
    for source, reason in unevaluable_posts.items():
        report.warnings.append(
            SpecWarning(condition=source, reason=reason, role="postcondition")
        )

    return report


def investigate_file(
    path: str | Path,
    *,
    config: Config | None = None,
    specs: dict[str, dict[str, list[str]]] | None = None,
) -> list[Report]:
    """Investigate every supported function in a file, reusing one worker.

    @param specs: optional per-function conditions, keyed by qualified name::

            {"budget_usage": {"postconditions": ["result >= 0"]}}
    """
    config = config or Config()
    file_path = Path(path)
    source = file_path.read_text(encoding="utf-8")
    functions = find_functions(source, str(file_path))
    classes = find_classes(source, str(file_path))
    specs = specs or {}

    reports: list[Report] = []
    executor: Executor | None = None
    try:
        for info in functions:
            entry = specs.get(info.qualified_name) or specs.get(info.name) or {}
            if describe_unsupported(info, classes) is None and executor is None:
                try:
                    executor = Executor(
                        source, filename=str(file_path), python=config.python,
                        timeout=config.timeout, cpu_seconds=config.cpu_seconds,
                        address_mb=config.address_mb,
                    )
                except ExecutorError:
                    executor = None
            reports.append(investigate(
                file_path, info.qualified_name,
                preconditions=entry.get("preconditions"),
                postconditions=entry.get("postconditions"),
                config=config, executor=executor,
            ))
    finally:
        if executor is not None:
            executor.close()
    return reports
