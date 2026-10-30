"""End-to-end proving, and the behavioural baseline from the recorded runs."""

from __future__ import annotations

import math
import unittest
from pathlib import Path

from buggy.prove import Config, investigate
from buggy.types import OracleKind, ReceiverKind

FIXTURE = Path(__file__).parent / "fixtures" / "sample.py"
EXAMPLES = Path(__file__).resolve().parents[2] / "examples" / "expense-api" / "src"

FAST = Config(max_executions=400, timeout=1.0)


class TestProving(unittest.TestCase):
    def test_division_by_zero_is_proven_with_the_exact_trigger(self):
        report = investigate(FIXTURE, "divide", config=FAST)
        self.assertEqual(report.status, "proven")
        self.assertIs(report.certificate.kind, OracleKind.CRASH)
        self.assertEqual(report.certificate.args[1], 0,
                         "the denominator is the argument at fault")
        self.assertIn("ZeroDivisionError", report.certificate.rule)

    def test_empty_collection_is_proven(self):
        report = investigate(FIXTURE, "mean", config=FAST)
        self.assertEqual(report.status, "proven")
        self.assertEqual(report.certificate.args, [[]])

    def test_nan_result_is_proven_without_a_stated_postcondition(self):
        """NaN and infinity are checked unasked: they are almost never intended
        and they propagate silently through a whole system."""
        report = investigate(FIXTURE, "ratio", config=FAST)
        self.assertEqual(report.status, "proven")
        self.assertIs(report.certificate.kind, OracleKind.NON_FINITE)

    def test_postcondition_violation_is_proven(self):
        report = investigate(
            FIXTURE, "apply_discount",
            preconditions=["price >= 0", "percent_off >= 0"],
            postconditions=["result >= 0"],
            config=FAST,
        )
        self.assertEqual(report.status, "proven")
        self.assertIs(report.certificate.kind, OracleKind.POSTCONDITION)
        self.assertEqual(report.certificate.rule, "result >= 0")
        self.assertLess(report.certificate.observed, 0)
        self.assertGreater(report.certificate.args[1], 100,
                           "the trigger is a discount above 100%")

    def test_timeout_is_proven(self):
        report = investigate(FIXTURE, "hangs",
                             config=Config(max_executions=3, timeout=0.3))
        self.assertEqual(report.status, "proven")
        self.assertIs(report.certificate.kind, OracleKind.TIMEOUT)

    def test_nondeterminism_is_proven_when_asked_for(self):
        report = investigate(
            FIXTURE, "flaky",
            config=Config(max_executions=40, timeout=1.0,
                          determinism_checks=4, determinism_sample=1),
        )
        self.assertEqual(report.status, "proven")
        self.assertIs(report.certificate.kind, OracleKind.NONDETERMINISM)

    def test_clean_functions_are_not_accused(self):
        for name in ("clamp_percent", "monthly"):
            with self.subTest(function=name):
                report = investigate(
                    FIXTURE, name,
                    preconditions=["math.isfinite(value)"] if name == "clamp_percent"
                    else ["math.isfinite(yearly)"],
                    postconditions=["result >= 0", "result <= 100"]
                    if name == "clamp_percent" else ["math.isfinite(result)"],
                    config=FAST,
                )
                self.assertEqual(report.status, "unconfirmed")
                self.assertIsNone(report.certificate)

    def test_staticmethod_is_investigable(self):
        report = investigate(FIXTURE, "Calculator.static_divide", config=FAST)
        self.assertEqual(report.status, "proven")


class TestPillars(unittest.TestCase):
    def test_certificate_records_all_three_pillars(self):
        report = investigate(FIXTURE, "divide", config=FAST)
        cert = report.certificate
        for stamp in (cert.admissible_at, cert.sound_at, cert.reproducible_at):
            self.assertRegex(stamp, r"^\d{4}-\d{2}-\d{2}T")
        self.assertGreaterEqual(cert.reproductions, 2,
                                "two of three reproductions are required")

    def test_precondition_excludes_the_trigger_and_blocks_the_proof(self):
        """Admissibility is load-bearing: if the caller promises never to pass
        zero, a failure on zero is not a defect in this function.

        Note that the precondition has to constrain the *type* as well as the
        value. ``denominator != 0`` is true of ``None``, and ``x / None`` raises
        TypeError, so a value-only precondition still admits a failing input.
        That is a real lesson about specifying Python rather than a quirk of
        this tool.
        """
        numeric = "isinstance({0}, (int, float)) and not isinstance({0}, bool)"
        report = investigate(
            FIXTURE, "divide",
            preconditions=[
                numeric.format("numerator"),
                numeric.format("denominator"),
                "denominator != 0",
                "math.isfinite(numerator) and math.isfinite(denominator)",
            ],
            config=FAST,
        )
        self.assertEqual(report.status, "unconfirmed")
        self.assertGreater(report.filtered, 0)

    def test_filtered_inputs_do_not_consume_the_budget(self):
        """Otherwise a strict precondition exhausts the budget before the
        function has been called more than a handful of times."""
        report = investigate(
            FIXTURE, "monthly",
            preconditions=["isinstance(yearly, float) and yearly > 1000"],
            config=Config(max_executions=5, timeout=1.0),
        )
        self.assertGreater(report.filtered, report.executions)
        self.assertLessEqual(report.executions, 5)


class TestFindingPreference(unittest.TestCase):
    """The search prefers the most informative finding, not the first one.

    ``divide(None, None)`` raises TypeError and sits early in the corpus for an
    unannotated function. Taking the first failure would report that and stop,
    burying the ZeroDivisionError the user needs. So a type-confusion failure is
    remembered and the search continues.
    """

    def test_zero_division_wins_over_type_confusion(self):
        report = investigate(FIXTURE, "divide", config=FAST)
        self.assertEqual(report.status, "proven")
        self.assertIn("ZeroDivisionError", report.certificate.rule)
        self.assertIsNone(report.note, "no need to apologise for the finding")

    def test_stated_postcondition_wins_over_the_builtin_nan_check(self):
        """A NaN result that also breaks `result >= 0` is reported in the
        user's own words, because that is the property they care about."""
        report = investigate(
            FIXTURE, "ratio",
            preconditions=["math.isfinite(a)", "math.isfinite(b)"],
            postconditions=["result >= 0"],
            config=FAST,
        )
        self.assertEqual(report.status, "proven")
        self.assertIs(report.certificate.kind, OracleKind.POSTCONDITION)

    def test_type_confusion_reported_when_it_is_the_only_finding(self):
        """Better than claiming 'unconfirmed' while holding a failing input.

        ``length(items)`` returns an int for anything sized and raises TypeError
        for a number, so no other oracle can fire.
        """
        report = investigate(FIXTURE, "length", config=FAST)
        self.assertEqual(report.status, "proven")
        self.assertIs(report.certificate.kind, OracleKind.CRASH)
        self.assertIn("unexpected type", report.note)


class TestNeverCalledIsNotClean(unittest.TestCase):
    """Reporting 'unconfirmed' for a function that was never executed presents
    an absence of evidence as evidence of absence."""

    def test_impossible_precondition_reports_no_valid_input(self):
        report = investigate(
            FIXTURE, "divide",
            preconditions=["numerator > 10 and numerator < 5"],  # unsatisfiable
            config=FAST,
        )
        self.assertEqual(report.status, "no_valid_input")
        self.assertEqual(report.executions, 0)
        self.assertGreater(report.filtered, 0)
        self.assertIn("never called", report.note)

    def test_satisfiable_precondition_still_executes(self):
        report = investigate(
            FIXTURE, "divide",
            preconditions=["isinstance(denominator, int)"],
            config=FAST,
        )
        self.assertNotEqual(report.status, "no_valid_input")
        self.assertGreater(report.executions, 0)

    def test_collection_precondition_admits_enough_inputs(self):
        """A precondition as ordinary as "a non-empty list of finite numbers"
        must admit real inputs, or the search is vacuous."""
        report = investigate(
            FIXTURE, "mean",
            preconditions=[
                "isinstance(values, list) and len(values) > 0",
                "all(isinstance(v, (int, float)) and math.isfinite(v) "
                "for v in values)",
            ],
            config=FAST,
        )
        self.assertNotEqual(report.status, "no_valid_input")
        self.assertGreater(report.executions, 0)


class TestNonFinitePropagation(unittest.TestCase):
    """A non-finite result from a non-finite argument is IEEE 754, not a defect.

    Without this distinction every unguarded arithmetic function in a codebase
    gets flagged the moment the fuzzer tries NaN, which is the dominant source
    of false positives in this kind of tool.
    """

    def test_propagated_nan_is_not_a_finding(self):
        report = investigate(FIXTURE, "monthly", config=FAST)
        # It may still be proven via type confusion, but never via the NaN that
        # it merely passed through.
        if report.certificate is not None:
            self.assertIsNot(report.certificate.kind, OracleKind.NON_FINITE)

    def test_nan_from_finite_input_is_a_finding(self):
        """``ratio(0, 0)`` manufactures a NaN from two finite arguments."""
        report = investigate(FIXTURE, "ratio", config=FAST)
        self.assertEqual(report.status, "proven")
        self.assertIs(report.certificate.kind, OracleKind.NON_FINITE)
        for arg in report.certificate.args:
            self.assertTrue(math.isfinite(arg))


class TestUnevaluableSpecsAreReported(unittest.TestCase):
    """The core defect of the original: a specification that does nothing, in
    silence, reads to the user as evidence of safety."""

    def test_javascript_postcondition_produces_a_warning(self):
        report = investigate(
            FIXTURE, "clamp_percent",
            postconditions=["!isNaN(result)"],
            config=Config(max_executions=10, timeout=1.0),
        )
        self.assertTrue(report.warnings, "must not accept it silently")
        warning = report.warnings[0]
        self.assertEqual(warning.role, "postcondition")
        self.assertIn("JavaScript", warning.reason)

    def test_javascript_precondition_produces_a_warning(self):
        report = investigate(
            FIXTURE, "divide",
            preconditions=["denominator !== 0"],
            config=Config(max_executions=10, timeout=1.0),
        )
        self.assertTrue(any(w.role == "precondition" for w in report.warnings))

    def test_typo_in_a_postcondition_is_reported(self):
        report = investigate(
            FIXTURE, "monthly",
            postconditions=["reslt >= 0"],  # misspelled
            config=Config(max_executions=10, timeout=1.0),
        )
        self.assertTrue(any("reslt" in w.reason for w in report.warnings))


class TestInstanceMethods(unittest.TestCase):
    """Instance methods were the largest coverage gap: 25 of the 81 functions in
    the stdlib's `statistics` module are instance methods, and in ordinary
    application code the share is higher still."""

    def test_instance_method_is_investigated(self):
        report = investigate(FIXTURE, "Picky.per_item", config=FAST)
        self.assertEqual(report.status, "proven")
        self.assertEqual(report.certificate.args, [0])
        self.assertIn("ZeroDivisionError", report.certificate.rule)

    def test_certificate_records_how_the_object_was_built(self):
        """A certificate the reader cannot re-run is not evidence."""
        report = investigate(FIXTURE, "Picky.per_item", config=FAST)
        receiver = report.certificate.receiver
        self.assertIsNotNone(receiver)
        self.assertIs(receiver.kind, ReceiverKind.CONSTRUCT)
        self.assertTrue(receiver.render("Picky").startswith("Picky("))

    def test_probe_finds_arguments_the_constructor_accepts(self):
        """``Picky`` rejects an empty name and a non-positive size, so the
        default construction attempt fails and the probe has to keep trying."""
        report = investigate(FIXTURE, "Picky.per_item", config=FAST)
        self.assertNotEqual(report.status, "skipped")

    def test_constructor_argument_defects_are_reachable(self):
        """``Basket.average`` takes no arguments of its own. Its defect is
        entirely in ``Basket([])``, so searching only method arguments would
        report it clean."""
        report = investigate(FIXTURE, "Basket.average", config=FAST)
        self.assertEqual(report.status, "proven")
        self.assertIn("ZeroDivisionError", report.certificate.rule)
        self.assertEqual(report.certificate.receiver.args, ([],))

    def test_preconditions_can_constrain_constructor_arguments(self):
        """A method's input is the pair (how the object was built, what it was
        called with), so a condition must be able to speak about both.

        Without this there is no way to say "items is a list", and
        ``Basket(0).scaled(1)`` is reported as a defect in ``scaled`` when the
        real problem is a constructor that accepts nonsense.
        """
        numeric = ("isinstance({0}, (int, float)) and "
                   "not isinstance({0}, bool) and math.isfinite({0})")
        report = investigate(
            FIXTURE, "Basket.scaled",
            preconditions=[
                # `items` is a constructor parameter. Note that
                # `isinstance(items, list)` alone is not enough: it admits
                # `[None]`, and `None * 1` raises. Specifying collections in a
                # dynamically typed language means specifying their elements.
                "isinstance(items, list) and all("
                + numeric.format("v") + " for v in items)",
                numeric.format("factor"),    # a method parameter
            ],
            config=FAST,
        )
        self.assertNotEqual(report.status, "proven")
        self.assertGreater(report.executions, 0, "must still execute something")

    def test_unconstrained_constructor_argument_is_still_found(self):
        """Left unconstrained, the invalid-state failure is reported rather than
        hidden - it is a real missing-validation defect, just ranked low."""
        report = investigate(FIXTURE, "Basket.scaled", config=FAST)
        self.assertEqual(report.status, "proven")

    def test_each_call_gets_a_fresh_object(self):
        """Sharing one receiver would let state written by an earlier call change
        a later one, breaking reproducibility and making any stateful method
        look non-deterministic."""
        report = investigate(
            FIXTURE, "Counter.tick",
            preconditions=["isinstance(step, int) and not isinstance(step, bool)"],
            config=Config(max_executions=30, timeout=1.0,
                          determinism_checks=4, determinism_sample=1),
        )
        if report.certificate is not None:
            self.assertIsNot(report.certificate.kind, OracleKind.NONDETERMINISM)

    def test_unconstructible_class_is_skipped_not_blamed(self):
        """A failure inside ``__init__`` says nothing about the method."""
        report = investigate(FIXTURE, "AlwaysFails.method", config=FAST)
        self.assertEqual(report.status, "skipped")
        self.assertIn("could not build", report.note)
        self.assertIn("--receiver", report.note)

    def test_variadic_init_is_refused_with_a_reason(self):
        report = investigate(FIXTURE, "OpaqueInit.first", config=FAST)
        self.assertEqual(report.status, "skipped")
        self.assertIn("*args", report.note)

    def test_user_supplied_receiver_expression(self):
        report = investigate(
            FIXTURE, "OpaqueInit.first",
            config=Config(max_executions=20, timeout=1.0,
                          receiver="OpaqueInit()"),
        )
        self.assertNotEqual(report.status, "skipped")
        self.assertEqual(report.status, "proven")
        self.assertIn("IndexError", report.certificate.rule)

    def test_bad_receiver_expression_is_reported(self):
        report = investigate(
            FIXTURE, "Picky.per_item",
            config=Config(max_executions=20, timeout=1.0,
                          receiver="Picky('', 0)"),  # __init__ rejects this
        )
        self.assertEqual(report.status, "skipped")
        self.assertIn("--receiver failed", report.note)

    def test_staticmethod_needs_no_receiver(self):
        report = investigate(FIXTURE, "Calculator.static_divide", config=FAST)
        self.assertEqual(report.status, "proven")
        self.assertFalse(
            report.certificate.receiver is not None
            and report.certificate.receiver.needed
        )

    def test_dunder_methods_are_out_of_scope(self):
        report = investigate(FIXTURE, "Picky.__init__", config=FAST)
        self.assertEqual(report.status, "skipped")
        self.assertIn("special method", report.note)


class TestSkipReasons(unittest.TestCase):

    def test_unknown_function_lists_what_is_available(self):
        report = investigate(FIXTURE, "no_such_function", config=FAST)
        self.assertEqual(report.status, "skipped")
        self.assertIn("divide", report.note)

    def test_unparseable_file_is_skipped_not_reported_as_clean(self):
        broken = Path(__file__).parent / "fixtures" / "_broken_tmp.py"
        broken.write_text("def broken(:\n  pass\n", encoding="utf-8")
        self.addCleanup(broken.unlink)
        report = investigate(broken, "broken", config=FAST)
        self.assertEqual(report.status, "skipped")


@unittest.skipUnless(EXAMPLES.is_dir(), "TypeScript example sources not present")
class TestRecordedBaseline(unittest.TestCase):
    """Parity against the committed TypeScript run on the same files.

    ``examples/expense-api/logs/investigations.jsonl`` records 3 proven defects
    across 7 functions, taking 494 seconds. Those statuses are the acceptance
    criteria for this port. ``apply_discount`` is included as a defect even
    though the recorded run reported it ``unconfirmed``: its bug is real and
    documented in the example's own WORKFLOW.md, and the recorded run missed it
    for want of an input above 100.
    """

    FINITE = "math.isfinite({0}) and {0} >= 0 and {0} <= 100000"

    def _investigate(self, filename, function, pre, post):
        return investigate(
            EXAMPLES / filename, function,
            preconditions=pre, postconditions=post, config=FAST,
        )

    def test_recorded_defects_are_still_proven(self):
        cases = [
            ("expenses.py", "split_expense",
             [self.FINITE.format("amount"), self.FINITE.format("people")], [0, 0]),
            ("budget.py", "budget_usage",
             [self.FINITE.format("spent"), self.FINITE.format("budget")], [0, 0]),
        ]
        for filename, function, pre, trigger in cases:
            with self.subTest(function=function):
                report = self._investigate(
                    filename, function, pre,
                    ["math.isfinite(result)", "not math.isnan(result)"],
                )
                self.assertEqual(report.status, "proven")
                self.assertEqual(report.certificate.args, trigger)

    def test_empty_collection_defect_still_proven(self):
        report = self._investigate(
            "expenses.py", "average_expense",
            ["isinstance(amounts, list) and all(math.isfinite(v) for v in amounts)"],
            ["math.isfinite(result)", "not math.isnan(result)"],
        )
        self.assertEqual(report.status, "proven")
        self.assertEqual(report.certificate.args, [[]])

    def test_defect_the_recorded_run_missed_is_now_found(self):
        report = self._investigate(
            "expenses.py", "apply_discount",
            [self.FINITE.format("price"), self.FINITE.format("percent_off")],
            ["result >= 0"],
        )
        self.assertEqual(report.status, "proven")
        self.assertGreater(report.certificate.args[1], 100)
        self.assertLess(report.certificate.observed, 0)

    def test_clean_functions_stay_clean(self):
        cases = [
            ("expenses.py", "monthly_average", [self.FINITE.format("yearly_total")],
             ["math.isfinite(result)", "not math.isnan(result)"]),
            ("budget.py", "remaining_budget",
             [self.FINITE.format("budget"), self.FINITE.format("spent")],
             ["result >= 0"]),
            ("budget.py", "clamp_percent",
             ["math.isfinite(value) and -100000 <= value <= 100000"],
             ["result >= 0", "result <= 100"]),
        ]
        for filename, function, pre, post in cases:
            with self.subTest(function=function):
                report = self._investigate(filename, function, pre, post)
                self.assertEqual(report.status, "unconfirmed")

    def test_whole_baseline_is_faster_than_the_recorded_run(self):
        """The recorded run took 494 s for these seven functions."""
        import time
        started = time.perf_counter()
        self.test_recorded_defects_are_still_proven()
        self.test_empty_collection_defect_still_proven()
        elapsed = time.perf_counter() - started
        self.assertLess(elapsed, 60.0, f"took {elapsed:.1f}s")


if __name__ == "__main__":
    unittest.main()
