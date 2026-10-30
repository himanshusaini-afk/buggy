"""Repair: candidate fixes, and the evidence each one earns.

The point of these tests is that a patch's verdict comes from running it. The
original implementation scored patches with a hand-written logistic and rejected
all 21 it was ever given, including the correct guard, at 93% likely-overfit.
Nothing here produces a score.
"""

from __future__ import annotations

import unittest
from pathlib import Path

from buggy.inspection import body_insertion_point, find_function
from buggy.prove import Config, investigate
from buggy.repair import Patch, analyse_trigger, propose
from buggy.types import OracleKind

FIXTURE = Path(__file__).parent / "fixtures" / "sample.py"
FAST = Config(max_executions=300, timeout=1.0)


def _prove(function, **kwargs):
    report = investigate(FIXTURE, function, config=FAST, **kwargs)
    assert report.certificate is not None, f"{function} was not proven"
    return report


def _repair(function, **kwargs):
    report = _prove(function, **kwargs)
    return propose(
        FIXTURE, function, certificate=report.certificate,
        preconditions=kwargs.get("preconditions"),
        postconditions=kwargs.get("postconditions"),
        timeout=1.0,
    )


class TestTriggerAnalysis(unittest.TestCase):
    """What broke, read off the certificate rather than guessed."""

    def test_zero_divisor_is_identified(self):
        report = _prove("divide")
        shapes = analyse_trigger(report.certificate, report_signature("divide"))
        self.assertTrue(any(s.kind == "zero" for s in shapes))

    def test_empty_collection_is_identified(self):
        report = _prove("mean")
        shapes = analyse_trigger(report.certificate, report_signature("mean"))
        self.assertTrue(any(s.kind == "empty" for s in shapes))

    def test_oversized_value_is_identified_for_a_lower_bound_rule(self):
        report = _prove(
            "apply_discount",
            preconditions=["price >= 0", "percent_off >= 0"],
            postconditions=["result >= 0"],
        )
        shapes = analyse_trigger(
            report.certificate, report_signature("apply_discount")
        )
        self.assertTrue(
            any(s.kind == "too_large" for s in shapes),
            "a magnitude problem wants clamping, not an early return",
        )


def report_signature(name):
    source = FIXTURE.read_text(encoding="utf-8")
    return find_function(source, name, str(FIXTURE)).signature


class TestVerifiedFixes(unittest.TestCase):
    def test_zero_division_gets_a_verified_guard(self):
        result = _repair("divide")
        verified = result.verified
        self.assertTrue(verified, "expected at least one verified fix")
        patch, evidence = verified[0]
        self.assertTrue(evidence.fixes_trigger)
        self.assertEqual(evidence.regressions, [])
        self.assertIn("== 0", patch.summary)

    def test_empty_collection_gets_a_verified_guard(self):
        result = _repair("mean")
        self.assertTrue(result.verified)
        patch, _ = result.verified[0]
        self.assertIn("len(", patch.summary)

    def test_clamp_is_verified_for_a_magnitude_problem(self):
        result = _repair(
            "apply_discount",
            preconditions=["math.isfinite(price) and price >= 0",
                           "math.isfinite(percent_off) and percent_off >= 0"],
            postconditions=["result >= 0"],
        )
        summaries = [p.summary for p, e in result.verified]
        self.assertTrue(any("clamp" in s for s in summaries), summaries)

    def test_patched_source_parses(self):
        result = _repair("divide")
        for patch, evidence in result.candidates:
            with self.subTest(strategy=patch.strategy):
                self.assertTrue(evidence.parses)

    def test_guard_lands_after_the_docstring(self):
        """Taken from the tree, not guessed: a docstring line reading
        ``BUG: denominator == 0 raises`` looks like code to any heuristic."""
        result = _repair("divide")
        patch, _ = result.verified[0]
        patched = patch.apply_to(FIXTURE.read_text(encoding="utf-8"))
        lines = patched.splitlines()
        guard = next(i for i, text in enumerate(lines) if "if denominator == 0" in text)
        self.assertIn('"""', lines[guard - 1] + lines[guard - 2])

    def test_a_raise_is_offered_as_well_as_a_return(self):
        """Returning a default and rejecting the input are both legitimate; the
        choice belongs to the reader."""
        result = _repair("divide")
        strategies = {p.strategy for p, _ in result.candidates}
        self.assertIn("early_return", strategies)
        self.assertIn("raise", strategies)

    def test_converting_the_exception_type_counts_as_a_fix(self):
        """The test is that the *proven* failure is gone, not that nothing is
        raised. Turning ZeroDivisionError into a documented ValueError is a
        real fix and must not be rejected for raising."""
        result = _repair("divide")
        raising = [
            (p, e) for p, e in result.candidates if p.strategy == "raise"
        ]
        self.assertTrue(raising)
        self.assertTrue(raising[0][1].fixes_trigger)


class TestEvidenceRejectsBadPatches(unittest.TestCase):
    """The four questions have to actually reject things."""

    def _certificate(self, function):
        return _prove(function).certificate

    def _insertion(self, function):
        source = FIXTURE.read_text(encoding="utf-8")
        info = find_function(source, function, str(FIXTURE))
        return body_insertion_point(source, info, str(FIXTURE))

    def test_a_patch_that_breaks_working_inputs_is_rejected(self):
        line, indent = self._insertion("divide")
        sabotage = Patch(
            strategy="test_always_zero",
            summary="always return 0.0",
            rationale="deliberately wrong, to prove regressions are detected",
            insert_before_line=line,
            lines=[f"{indent}return 0.0"],
        )
        result = propose(
            FIXTURE, "divide", certificate=self._certificate("divide"),
            patches=[sabotage], timeout=1.0,
        )
        patch, evidence = result.candidates[0]
        self.assertEqual(evidence.verdict, "rejected")
        self.assertTrue(evidence.regressions)
        self.assertIn("changes behaviour", evidence.reason)

    def test_a_patch_that_only_handles_the_exact_trigger_is_overfit(self):
        """The honest overfitting test: a fix that special-cases the one input
        that caught it passes every other check and fails this one."""
        line, indent = self._insertion("divide")
        certificate = self._certificate("divide")
        a, b = certificate.args
        overfit = Patch(
            strategy="test_special_case",
            summary="special-case exactly the triggering input",
            rationale="deliberately overfit, to prove generality is tested",
            insert_before_line=line,
            lines=[
                f"{indent}if numerator == {a!r} and denominator == {b!r}:",
                f"{indent}    return 0.0",
            ],
        )
        result = propose(
            FIXTURE, "divide", certificate=certificate,
            patches=[overfit], timeout=1.0,
        )
        patch, evidence = result.candidates[0]
        self.assertTrue(evidence.fixes_trigger, "it does fix the one input")
        self.assertEqual(evidence.regressions, [], "and breaks nothing")
        self.assertFalse(evidence.generalises)
        self.assertEqual(evidence.verdict, "overfit")
        self.assertIn("only handles the exact input", evidence.reason)

    def test_a_patch_that_does_not_parse_is_rejected(self):
        line, indent = self._insertion("divide")
        broken = Patch(
            strategy="test_broken",
            summary="syntactically invalid",
            rationale="deliberately broken",
            insert_before_line=line,
            lines=[f"{indent}if denominator == 0:"],  # no body
        )
        result = propose(
            FIXTURE, "divide", certificate=self._certificate("divide"),
            patches=[broken], timeout=1.0,
        )
        _, evidence = result.candidates[0]
        self.assertFalse(evidence.parses)
        self.assertEqual(evidence.verdict, "rejected")

    def test_siblings_are_screened_against_the_original(self):
        """A sibling that already worked would be "fixed" by any patch at all,
        so counting it would make the generality result meaningless."""
        result = _repair("divide")
        _, evidence = result.verified[0]
        self.assertGreater(evidence.siblings_total, 0)
        self.assertEqual(evidence.siblings_fixed, evidence.siblings_total)

    def test_precondition_excluded_inputs_do_not_count_as_regressions(self):
        """A patch must not be blamed for changing behaviour on an input the
        specification already excluded. Clamping percent_off to [0, 100] was
        rejected over percent_off = -1 until preconditions were honoured."""
        result = _repair(
            "apply_discount",
            preconditions=["math.isfinite(price) and price >= 0",
                           "math.isfinite(percent_off) and percent_off >= 0"],
            postconditions=["result >= 0"],
        )
        clamps = [(p, e) for p, e in result.candidates if p.strategy == "clamp"]
        self.assertTrue(clamps)
        self.assertEqual(clamps[0][1].verdict, "verified", clamps[0][1].reason)


class TestInstanceMethodRepair(unittest.TestCase):
    def test_guard_reaches_through_self(self):
        result = _repair("Basket.average")
        self.assertTrue(result.verified)
        patch, _ = result.verified[0]
        self.assertIn("self.items", patch.summary)
        self.assertTrue(any("self.items" in line for line in patch.lines))

    def test_constructor_triggered_defect_has_real_siblings(self):
        """Receiver-sourced faults need receiver variation, or the generality
        check is vacuous."""
        result = _repair("Basket.average")
        _, evidence = result.verified[0]
        self.assertGreater(evidence.siblings_total, 0)


class TestNothingIsWritten(unittest.TestCase):
    def test_the_source_file_is_untouched(self):
        before = FIXTURE.read_bytes()
        _repair("divide")
        self.assertEqual(FIXTURE.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
