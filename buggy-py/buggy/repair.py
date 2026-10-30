"""Generates candidate fixes, and verifies them by execution.

The original implementation generated patches and then scored them with a
hand-written logistic model to guess whether each was "overfit". In its own
recorded runs that model rejected **all 21** patches it was given, across both
languages, scoring the correct ``if people == 0: return 0.0`` guard at 93%
likely-overfit; every score landed in [0.86, 0.99] against a 0.5 threshold, so
no patch could ever be approved.

This module does not score patches. It **tests** them, which is affordable
because a call costs ~0.015 ms. Every candidate is applied in memory and must
earn its verdict against four questions:

1. **Does it parse?** A patch that breaks the file is discarded immediately.
2. **Does it fix the proven trigger?** The exact input from the certificate is
   re-run and must no longer fail.
3. **Does it break anything that worked?** Every input the original handled is
   re-run against the patch, and any changed result is a regression.
4. **Does it generalise?** Sibling inputs of the same shape as the trigger (the
   same zero denominator with different numerators, other empty collections) are
   generated and must be handled too.

Question 4 is the honest version of the overfitting check. A patch that special-
cases the one input that caught it will pass 1–3 and fail here, and it fails on
evidence rather than on a coefficient.

Nothing is ever written to your source. Patches are returned as data.

@module buggy.repair
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import oracles
from .executor import Executor, ExecutorError
from .generate import values_for_annotation
from .inspection import (
    body_insertion_point,
    find_classes,
    find_function,
    parse,
    SourceSyntaxError,
)
from .specs import (
    Condition,
    SpecSyntaxError,
    compile_condition,
    preconditions_hold,
)
from .types import (
    Certificate,
    OracleKind,
    Outcome,
    Receiver,
    Signature,
)

__all__ = ["Patch", "Evidence", "RepairResult", "propose", "TriggerShape"]


# ─── What broke, in a language-independent form ──────────────────────────────


@dataclass(frozen=True)
class TriggerShape:
    """The property of the input that caused the failure.

    Derived from the certificate rather than guessed. This is the difference
    between a real fix and a decorative one: the proof says ``per_item(0)``
    raised ZeroDivisionError, so the guard should test ``count == 0``, not a
    generic ``count is not None``.
    """

    parameter: str
    index: int
    kind: str
    """``zero`` | ``empty`` | ``none`` | ``too_large`` | ``unknown``"""
    value: Any = None
    in_receiver: bool = False
    """True when the offending value was a constructor argument."""


_ARITHMETIC_MARKERS = (
    "zerodivision", "division", "divide", "isnan", "nan", "isfinite", "infinity",
)


def _looks_arithmetic(rule: str, detail: str | None) -> bool:
    text = (rule + " " + (detail or "")).lower()
    return any(marker in text for marker in _ARITHMETIC_MARKERS)


def _looks_like_lower_bound(rule: str) -> bool:
    """Whether the broken rule says the result must not go below a bound."""
    compact = " ".join(rule.split())
    return "result >= 0" in compact or "result > 0" in compact or "result >=0" in compact


def analyse_trigger(
    certificate: Certificate,
    signature: Signature,
    init: Signature | None = None,
) -> list[TriggerShape]:
    """Work out which argument was at fault, and how.

    Returns one shape per implicated argument, most likely culprit last: for
    ``a / b`` the denominator is the operand that faults and is conventionally
    the later parameter, so guarding only it keeps the patch minimal.
    """
    shapes: list[TriggerShape] = []
    names = signature.names
    arithmetic = _looks_arithmetic(certificate.rule, certificate.detail)
    lower_bound = _looks_like_lower_bound(certificate.rule)

    def classify(value: Any, name: str, index: int, in_receiver: bool) -> None:
        if value is None:
            shapes.append(TriggerShape(name, index, "none", value, in_receiver))
        elif isinstance(value, (list, tuple, str, dict, set)) and len(value) == 0:
            shapes.append(TriggerShape(name, index, "empty", value, in_receiver))
        elif isinstance(value, bool):
            return
        elif isinstance(value, (int, float)) and value == 0 and arithmetic:
            shapes.append(TriggerShape(name, index, "zero", value, in_receiver))
        elif isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
            shapes.append(TriggerShape(name, index, "non_finite", value, in_receiver))
        elif isinstance(value, (int, float)) and value > 100 and lower_bound:
            # A magnitude problem, such as a 150% discount, wants clamping
            # rather than an early return.
            shapes.append(TriggerShape(name, index, "too_large", value, in_receiver))

    receiver = certificate.receiver
    if receiver is not None and receiver.needed and init is not None:
        for index, (name, value) in enumerate(zip(init.names, receiver.args)):
            classify(value, name, index, True)

    for index, value in enumerate(certificate.args):
        name = names[index] if index < len(names) else f"arg{index}"
        classify(value, name, index, False)

    # For an arithmetic fault with several zero arguments, keep only the last.
    zeros = [s for s in shapes if s.kind == "zero" and not s.in_receiver]
    if len(zeros) > 1:
        shapes = [s for s in shapes if s.kind != "zero" or s.in_receiver] + [zeros[-1]]

    return shapes


# ─── Patches ─────────────────────────────────────────────────────────────────


@dataclass
class Patch:
    """A candidate fix, as source lines to insert."""

    strategy: str
    summary: str
    rationale: str
    insert_before_line: int
    lines: list[str]
    targets: tuple[str, ...] = ()
    """Parameter names the patch guards."""

    def apply_to(self, source: str) -> str:
        out = source.splitlines()
        index = max(0, self.insert_before_line - 1)
        return "\n".join(out[:index] + self.lines + out[index:]) + "\n"

    def diff(self, source: str) -> str:
        """A unified-style fragment, for display."""
        existing = source.splitlines()
        index = max(0, self.insert_before_line - 1)
        before = existing[max(0, index - 2):index]
        after = existing[index:index + 2]
        body = [f"  {line}" for line in before]
        body += [f"+ {line}" for line in self.lines]
        body += [f"  {line}" for line in after]
        return "\n".join(body)


def _default_return(signature: Signature, observed: list[Any]) -> str:
    """What a guard should return instead of failing.

    Prefers the declared return annotation, then the shape of values the
    function was actually seen returning, which is better evidence than a
    hardcoded default.
    """
    annotation = (signature.return_annotation or "").lower().strip()
    if annotation in ("int",):
        return "0"
    if annotation in ("float", "complex"):
        return "0.0"
    if annotation in ("str",):
        return "''"
    if annotation in ("bool",):
        return "False"
    if annotation.startswith(("list", "sequence", "tuple")):
        return "[]"
    if annotation.startswith(("dict", "mapping")):
        return "{}"
    if annotation in ("none", "nonetype"):
        return "None"

    kinds = {type(v) for v in observed if v is not None}
    if kinds == {float} or (float in kinds and int in kinds):
        return "0.0"
    if kinds == {int}:
        return "0"
    if kinds == {str}:
        return "''"
    if kinds == {list}:
        return "[]"
    if kinds == {dict}:
        return "{}"
    if kinds == {bool}:
        return "False"
    return "None"


def _condition_for(shape: TriggerShape) -> str | None:
    """A Python test for this trigger shape."""
    name = shape.parameter
    if shape.kind == "zero":
        return f"{name} == 0"
    if shape.kind == "empty":
        return f"len({name}) == 0"
    if shape.kind == "none":
        return f"{name} is None"
    if shape.kind == "non_finite":
        return f"not math.isfinite({name})"
    return None


def _subject(shape: TriggerShape) -> str:
    """How to refer to the offending value inside the function body."""
    return f"self.{shape.parameter}" if shape.in_receiver else shape.parameter


def build_patches(
    certificate: Certificate,
    signature: Signature,
    source: str,
    insert_line: int,
    indent: str,
    observed: list[Any],
    init: Signature | None = None,
) -> list[Patch]:
    """Candidate fixes for a proven failure, most conservative first."""
    shapes = analyse_trigger(certificate, signature, init)
    if not shapes:
        return []

    default = _default_return(signature, observed)
    patches: list[Patch] = []

    guardable = [s for s in shapes if _condition_for(s) is not None]
    clamps = [s for s in shapes if s.kind == "too_large"]

    if guardable:
        tests = []
        for shape in guardable:
            condition = _condition_for(shape)
            # A receiver-sourced value is reached through self.
            if shape.in_receiver:
                condition = condition.replace(
                    shape.parameter, f"self.{shape.parameter}", 1
                )
            tests.append(condition)
        test = " or ".join(tests)
        described = ", ".join(f"{_subject(s)} {s.kind}" for s in guardable)
        names = tuple(s.parameter for s in guardable)

        patches.append(Patch(
            strategy="early_return",
            summary=f"return {default} when {test}",
            rationale=f"guards the proven trigger ({described})",
            insert_before_line=insert_line,
            lines=[f"{indent}if {test}:", f"{indent}    return {default}"],
            targets=names,
        ))

        patches.append(Patch(
            strategy="raise",
            summary=f"raise ValueError when {test}",
            rationale=(
                f"rejects the proven trigger ({described}) instead of returning "
                "a value the caller may not expect"
            ),
            insert_before_line=insert_line,
            lines=[
                f"{indent}if {test}:",
                f"{indent}    raise ValueError("
                f"{_message_for(guardable)!r})",
            ],
            targets=names,
        ))

    for shape in clamps:
        subject = _subject(shape)
        patches.append(Patch(
            strategy="clamp",
            summary=f"clamp {subject} to [0, 100]",
            rationale=(
                f"{subject} was {shape.value!r}, which drove the result out of "
                "range; a magnitude problem wants clamping, not an early return"
            ),
            insert_before_line=insert_line,
            lines=[f"{indent}{subject} = max(0, min(100, {subject}))"],
            targets=(shape.parameter,),
        ))

    for shape in (s for s in shapes if s.kind == "none"):
        subject = _subject(shape)
        patches.append(Patch(
            strategy="coalesce",
            summary=f"substitute a default when {subject} is None",
            rationale="treats a missing value as the empty case",
            insert_before_line=insert_line,
            lines=[
                f"{indent}if {subject} is None:",
                f"{indent}    {subject} = {default if default != 'None' else '[]'}",
            ],
            targets=(shape.parameter,),
        ))

    return patches


def _message_for(shapes: list[TriggerShape]) -> str:
    parts = []
    for shape in shapes:
        if shape.kind == "zero":
            parts.append(f"{shape.parameter} must not be zero")
        elif shape.kind == "empty":
            parts.append(f"{shape.parameter} must not be empty")
        elif shape.kind == "none":
            parts.append(f"{shape.parameter} is required")
        elif shape.kind == "non_finite":
            parts.append(f"{shape.parameter} must be finite")
    return "; ".join(parts) or "invalid argument"


# ─── Verification ────────────────────────────────────────────────────────────


@dataclass
class Evidence:
    """What was observed about a patch. No scores, only outcomes."""

    parses: bool = False
    fixes_trigger: bool = False
    regressions: list[tuple[list[Any], str, str]] = field(default_factory=list)
    """(arguments, original outcome, patched outcome) for inputs that changed."""
    checked: int = 0
    """How many previously-working inputs were re-run."""
    siblings_fixed: int = 0
    siblings_total: int = 0
    """Inputs of the same shape as the trigger, used as the overfitting test."""
    note: str | None = None

    @property
    def generalises(self) -> bool:
        """Whether the fix covers the defect class, not just the one input.

        With nothing comparable to try, this is not evidence *for* the patch and
        is not treated as a failure either; :attr:`reason` says so plainly
        rather than letting a vacuous check read as a passed one.
        """
        if self.siblings_total == 0:
            return True
        return self.siblings_fixed == self.siblings_total

    @property
    def verdict(self) -> str:
        if not self.parses:
            return "rejected"
        if not self.fixes_trigger:
            return "rejected"
        if self.regressions:
            return "rejected"
        if not self.generalises:
            return "overfit"
        return "verified"

    @property
    def reason(self) -> str:
        if not self.parses:
            return "the patched file does not parse"
        if not self.fixes_trigger:
            return "the proven trigger still fails"
        if self.regressions:
            args, was, now = self.regressions[0]
            return (
                f"changes behaviour on {args!r}: was {was}, now {now} "
                f"({len(self.regressions)} of {self.checked} inputs affected)"
            )
        if not self.generalises:
            return (
                f"only handles the exact input that caught it "
                f"({self.siblings_fixed} of {self.siblings_total} similar inputs fixed)"
            )
        generality = (
            f"{self.siblings_fixed}/{self.siblings_total} similar inputs also fixed"
            if self.siblings_total
            else "no comparable inputs available, so generality is untested"
        )
        return (
            f"fixes the trigger, {self.checked} working inputs unchanged, "
            f"{generality}"
        )


@dataclass
class RepairResult:
    function: str
    file: str
    certificate: Certificate
    candidates: list[tuple[Patch, Evidence]] = field(default_factory=list)

    @property
    def verified(self) -> list[tuple[Patch, Evidence]]:
        return [(p, e) for p, e in self.candidates if e.verdict == "verified"]


_EQUIVALENT_EMPTIES: dict[str, tuple[Any, ...]] = {
    "list": ([],),
    "str": ("",),
    "dict": ({},),
    "tuple": ((),),
}


def _same_class_values(shape: TriggerShape) -> tuple[Any, ...]:
    """Other values that break a function the same way this one did."""
    if shape.kind == "zero":
        return (0, 0.0, -0.0)
    if shape.kind == "empty":
        return ([], "", {}, ())
    if shape.kind == "none":
        return (None,)
    if shape.kind == "non_finite":
        return (float("nan"), float("inf"), float("-inf"))
    if shape.kind == "too_large":
        base = shape.value if isinstance(shape.value, (int, float)) else 101
        return (base, base + 1, base * 2, 1000)
    return ()


def _siblings(
    shape: TriggerShape,
    certificate: Certificate,
    signature: Signature,
    init: Signature | None,
) -> list[tuple[Receiver | None, list[Any]]]:
    """Inputs that share the trigger's defining property but differ elsewhere.

    This is the overfitting test, and it is the honest version of what the
    original implementation tried to do with a scoring model. If the trigger was
    ``(0, 0)`` with a zero denominator, the siblings are ``(1, 0)``, ``(-3, 0)``
    and so on: the same fault, different surrounding values. A patch that
    special-cases the exact input that caught it fixes the trigger and fails
    here, on evidence rather than on a coefficient.

    Variation happens on the side the fault did *not* come from, plus other
    values of the same class in the faulting slot.
    """
    base_receiver = certificate.receiver
    out: list[tuple[Receiver | None, list[Any]]] = []

    def pool_for(sig: Signature | None, index: int) -> list[Any]:
        annotation = None
        if sig is not None and index < len(sig.parameters):
            annotation = sig.parameters[index].annotation
        return [v for v in values_for_annotation(annotation) if _plausible(v)][:5]

    same_class = _same_class_values(shape)

    if shape.in_receiver and base_receiver is not None and init is not None:
        receiver_args = list(base_receiver.args)
        # Other constructor arguments, holding the fault fixed.
        for i in range(len(receiver_args)):
            if i == shape.index:
                continue
            for value in pool_for(init, i):
                variant = list(receiver_args)
                variant[i] = value
                out.append((
                    Receiver(base_receiver.kind, args=tuple(variant)),
                    list(certificate.args),
                ))
        # Other values of the same class in the faulting slot.
        for value in same_class:
            variant = list(receiver_args)
            variant[shape.index] = value
            if variant != receiver_args:
                out.append((
                    Receiver(base_receiver.kind, args=tuple(variant)),
                    list(certificate.args),
                ))
        # Vary the method's own arguments too.
        for i in range(len(certificate.args)):
            for value in pool_for(signature, i):
                variant = list(certificate.args)
                variant[i] = value
                out.append((base_receiver, variant))
        return out[:10]

    if shape.index >= len(certificate.args):
        return []

    for i in range(len(certificate.args)):
        if i == shape.index:
            continue
        for value in pool_for(signature, i):
            variant = list(certificate.args)
            variant[i] = value
            if variant != list(certificate.args):
                out.append((base_receiver, variant))

    for value in same_class:
        variant = list(certificate.args)
        variant[shape.index] = value
        if variant != list(certificate.args):
            out.append((base_receiver, variant))

    return out[:10]


def _plausible(value: Any) -> bool:
    """Exclude values that would fail for their own reasons, not the trigger's."""
    if value is None or isinstance(value, bool):
        return False
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return False
    if isinstance(value, (str, list, dict, set, tuple)) and len(value) == 0:
        return False
    if isinstance(value, (int, float)) and value == 0:
        return False
    return True


def _original_exception(certificate: Certificate) -> str | None:
    prefix = "must not raise "
    if certificate.rule.startswith(prefix):
        return certificate.rule[len(prefix):].strip()
    if certificate.detail and ":" in certificate.detail:
        return certificate.detail.split(":", 1)[0].strip()
    return None


def _still_failing(
    result: Any,
    certificate: Certificate,
    postconditions: list[Condition],
    names: tuple[str, ...],
    args: list[Any],
    init_names: tuple[str, ...],
    receiver_args: tuple[Any, ...],
) -> bool:
    """Whether the *original* failure is still present after patching.

    The test is specifically that the proven failure is gone, not that nothing
    at all is raised. Turning a ZeroDivisionError into a documented ValueError
    is a legitimate fix, and a patch that does so must not be rejected for it.
    """
    kind = certificate.kind

    if kind is OracleKind.CRASH:
        original = _original_exception(certificate)
        return (
            result.outcome is Outcome.RAISED
            and result.exception_type == original
        )

    if kind is OracleKind.TIMEOUT:
        return result.outcome is Outcome.TIMEOUT

    if kind is OracleKind.NON_FINITE:
        return oracles.check_non_finite(result, args) is not None

    if kind is OracleKind.POSTCONDITION:
        if result.outcome is not Outcome.OK:
            # It raises instead of returning a bad value. The stated property is
            # no longer violated; whether raising is desirable is the reader's
            # call, and the patch says so in its summary.
            return False
        found, _ = oracles.check_postconditions(
            postconditions, result, args, names
        )
        return found is not None

    return False


def _screen_siblings(
    source: str,
    filename: str,
    target: str,
    candidates: list[tuple[Receiver | None, list[Any]]],
    certificate: Certificate,
    postconditions: list[Condition],
    names: tuple[str, ...],
    init_names: tuple[str, ...],
    timeout: float,
    python: str | None,
) -> list[tuple[Receiver | None, list[Any]]]:
    """Narrow candidate siblings to those that really fail the same way.

    Run against the unpatched source. A candidate that already worked tells us
    nothing about a patch's generality, because every patch "fixes" it.
    """
    if not candidates:
        return []
    worker = _run_worker(source, filename, timeout, python)
    if worker is None:
        return []
    kept: list[tuple[Receiver | None, list[Any]]] = []
    try:
        for sib_receiver, args in candidates:
            try:
                result = worker.call(
                    target, args, timeout=timeout, receiver=sib_receiver
                )
            except ExecutorError:
                continue
            if result.exception_type == "ReceiverConstructionFailed":
                continue
            if _still_failing(
                result, certificate, postconditions, names, args, init_names,
                tuple(sib_receiver.args) if sib_receiver else (),
            ):
                kept.append((sib_receiver, args))
    finally:
        worker.close()
    return kept


def _run_worker(
    source: str,
    filename: str,
    timeout: float,
    python: str | None,
) -> Executor | None:
    try:
        executor = Executor(
            source, filename=filename, timeout=timeout, python=python
        )
    except ExecutorError:
        return None
    if executor.load_error is not None:
        executor.close()
        return None
    return executor


def propose(
    path: str | Path,
    function: str,
    *,
    certificate: Certificate,
    preconditions: list[str] | None = None,
    postconditions: list[str] | None = None,
    timeout: float = 2.0,
    baseline_inputs: list[tuple[Receiver | None, list[Any]]] | None = None,
    patches: list[Patch] | None = None,
    python: str | None = None,
) -> RepairResult:
    """Build candidate fixes for a proven failure and verify each by execution.

    @param certificate: the proof the fix must address.
    @param preconditions: the caller's own constraints. Essential, not optional:
        a patch must not be blamed for changing behaviour on an input the
        specification already excluded. Clamping ``percent_off`` to [0, 100] was
        rejected as a regression on ``percent_off = -1`` until these were
        honoured, even though the stated precondition was ``percent_off >= 0``.
    @param baseline_inputs: (receiver, arguments) pairs to re-run. Defaults to
        the set the search itself would try.
    @param patches: candidates to verify instead of the generated ones. Lets a
        caller put a specific fix through the same four questions.
    """
    file_path = Path(path)
    source = file_path.read_text(encoding="utf-8")
    info = find_function(source, function, str(file_path))
    if info is None:
        raise ValueError(f"function not found: {function}")

    classes = find_classes(source, str(file_path))
    owner = classes.get(info.owner or "")
    init = owner.init if owner is not None else None
    init_names = init.names if init is not None else ()
    names = info.signature.names

    spot = body_insertion_point(source, info, str(file_path))
    if spot is None:
        return RepairResult(function=function, file=str(file_path),
                            certificate=certificate)
    insert_line, indent = spot

    compiled: list[Condition] = []
    for text in postconditions or []:
        try:
            compiled.append(compile_condition(text))
        except SpecSyntaxError:
            continue

    compiled_pre: list[Condition] = []
    for text in preconditions or []:
        try:
            compiled_pre.append(compile_condition(text))
        except SpecSyntaxError:
            continue

    receiver = certificate.receiver
    if baseline_inputs is None:
        from .prove import candidate_calls

        baseline_inputs = candidate_calls(
            info.signature, init, receiver, limit=120
        )
    pairs = list(baseline_inputs)

    # Establish what the ORIGINAL does, so a change can be recognised. Only
    # inputs the original handled are used: an input it already failed on is
    # allowed, indeed expected, to behave differently afterwards.
    baseline: list[tuple[Receiver | None, list[Any], str]] = []
    observed: list[Any] = []
    original = _run_worker(source, str(file_path), timeout, python)
    if original is None:
        return RepairResult(function=function, file=str(file_path),
                            certificate=certificate)
    try:
        for call_receiver, args in pairs[:160]:
            admissible, _ = preconditions_hold(
                compiled_pre, args, names, init_names,
                tuple(call_receiver.args) if call_receiver else (),
            )
            if not admissible:
                continue
            try:
                result = original.call(
                    info.qualified_name, args, timeout=timeout,
                    receiver=call_receiver,
                )
            except ExecutorError:
                continue
            if result.outcome is not Outcome.OK:
                continue
            # "Handled correctly" means more than "did not raise". An input that
            # returned a value violating a stated postcondition, or a NaN, is
            # already broken, and a patch is *expected* to change it. Counting
            # it as working rejected the clamp fix for altering its own trigger:
            # apply_discount(1, 101) returned -0.01 without raising.
            if oracles.check_non_finite(result, args) is not None:
                continue
            violated, _ = oracles.check_postconditions(
                compiled, result, args, names
            )
            if violated is not None:
                continue
            baseline.append((call_receiver, args, oracles.comparison_key(result)))
            if result.value_is_usable:
                observed.append(result.value)
    finally:
        original.close()

    if patches is None:
        patches = build_patches(
            certificate, info.signature, source, insert_line, indent,
            observed, init,
        )

    result_out = RepairResult(function=function, file=str(file_path),
                              certificate=certificate)

    shapes = analyse_trigger(certificate, info.signature, init)
    sibling_candidates: list[tuple[Receiver | None, list[Any]]] = []
    for shape in shapes:
        sibling_candidates = _siblings(shape, certificate, info.signature, init)
        if sibling_candidates:
            break

    # Keep only the siblings that genuinely fail the same way in the ORIGINAL.
    # One that already worked would count as "fixed" by any patch at all and
    # inflate the generality result into meaninglessness.
    sibling_calls = _screen_siblings(
        source, str(file_path), info.qualified_name, sibling_candidates,
        certificate, compiled, names, init_names, timeout, python,
    )

    for patch in patches:
        evidence = Evidence()
        patched_source = patch.apply_to(source)

        try:
            parse(patched_source, str(file_path))
            evidence.parses = True
        except SourceSyntaxError as exc:
            evidence.note = str(exc)
            result_out.candidates.append((patch, evidence))
            continue

        worker = _run_worker(patched_source, str(file_path), timeout, python)
        if worker is None:
            evidence.parses = False
            evidence.note = "the patched module did not load"
            result_out.candidates.append((patch, evidence))
            continue

        try:
            # 1. Is the proven failure gone?
            trigger_result = worker.call(
                info.qualified_name, certificate.args, timeout=timeout,
                receiver=receiver,
            )
            evidence.fixes_trigger = not _still_failing(
                trigger_result, certificate, compiled, names,
                certificate.args, init_names,
                tuple(receiver.args) if receiver else (),
            )

            # 2. Does anything that worked now behave differently?
            for call_receiver, args, expected in baseline:
                try:
                    after = worker.call(
                        info.qualified_name, args, timeout=timeout,
                        receiver=call_receiver,
                    )
                except ExecutorError:
                    continue
                evidence.checked += 1
                actual = oracles.comparison_key(after)
                if actual != expected:
                    evidence.regressions.append((args, expected, actual))

            # 3. Does it cover the defect class, or only the one input?
            for sib_receiver, args in sibling_calls:
                try:
                    sibling = worker.call(
                        info.qualified_name, args, timeout=timeout,
                        receiver=sib_receiver,
                    )
                except ExecutorError:
                    continue
                evidence.siblings_total += 1
                if not _still_failing(
                    sibling, certificate, compiled, names, args, init_names,
                    tuple(sib_receiver.args) if sib_receiver else (),
                ):
                    evidence.siblings_fixed += 1
        finally:
            worker.close()

        result_out.candidates.append((patch, evidence))

    # Most trustworthy first: verified, then overfit, then rejected.
    order = {"verified": 0, "overfit": 1, "rejected": 2}
    result_out.candidates.sort(key=lambda pair: order.get(pair[1].verdict, 3))
    return result_out
