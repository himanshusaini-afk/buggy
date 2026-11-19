"""Recording proven defects, re-running them, and exporting them as tests.

The value of this module rests on one claim: every answer it gives comes from
executing the stored trigger again, not from remembering what happened. These
tests check that by changing the code under it and seeing the verdict follow.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from buggy.prove import Config, investigate
from buggy.store import (
    STATUS_FIXED,
    STATUS_OPEN,
    STATUS_REGRESSED,
    STATUS_UNREACHABLE,
    Store,
    to_pytest,
)

BUGGY = "def budget_usage(spent, budget):\n    return (spent / budget) * 100\n"
GUARDED = ("def budget_usage(spent, budget):\n"
           "    if budget == 0:\n"
           "        return 0.0\n"
           "    return (spent / budget) * 100\n")
FAST = Config(max_executions=150, timeout=1.0)


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="buggy-store-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.target = self.root / "budget.py"
        self.target.write_text(BUGGY, encoding="utf-8")
        self.store = Store(self.root)
        self.addCleanup(self.store.close)

    def prove(self, function: str = "budget_usage"):
        report = investigate(self.target, function,
                             postconditions=["math.isfinite(result)"],
                             config=FAST)
        self.assertIsNotNone(report.certificate, f"{function} was not proven")
        return report

    def record(self):
        report = self.prove()
        return self.store.record(report.certificate,
                                 postconditions=["math.isfinite(result)"])


class TestRecording(StoreTestCase):
    def test_database_is_created_on_first_use(self):
        self.assertFalse(self.store.exists())
        self.record()
        self.assertTrue(self.store.exists())
        self.assertEqual(self.store.path.parent.name, ".buggy")

    def test_a_finding_keeps_the_runnable_trigger(self):
        finding, _ = self.record()
        self.assertEqual(finding.function, "budget_usage")
        self.assertEqual(finding.args, [0, 0])
        self.assertIn("ZeroDivisionError", finding.rule)
        self.assertEqual(finding.reproduce(), "budget_usage(0, 0)")

    def test_paths_are_stored_relative_to_the_project(self):
        """So the database survives the project being moved or checked out
        somewhere else."""
        finding, _ = self.record()
        self.assertEqual(finding.file, "budget.py")

    def test_recording_the_same_defect_twice_updates_one_row(self):
        """Keyed on the failing call, not on a timestamp. Otherwise every
        re-investigation would inflate the counts."""
        first, _ = self.record()
        second, _ = self.record()
        self.assertEqual(first.id, second.id)
        self.assertEqual(second.times_seen, 2)
        self.assertEqual(len(self.store.findings()), 1)

    def test_a_fresh_finding_is_not_a_regression(self):
        _, regression = self.record()
        self.assertFalse(regression)

    def test_recording_a_fixed_defect_again_is_a_regression(self):
        finding, _ = self.record()
        self.store.mark_fixed(finding.id)
        _, regression = self.record()
        self.assertTrue(regression)
        self.assertEqual(self.store.get(finding.id).status, STATUS_REGRESSED)

    def test_lookup_by_bare_name_finds_a_class_member(self):
        self.target.write_text(
            "class Budget:\n"
            "    def __init__(self, total):\n        self.total = total\n"
            "    def usage(self, spent):\n"
            "        return spent / self.total\n",
            encoding="utf-8")
        report = investigate(self.target, "Budget.usage", config=FAST)
        self.assertIsNotNone(report.certificate)
        self.store.record(report.certificate)
        self.assertTrue(self.store.findings(function="usage"))
        self.assertTrue(self.store.findings(function="Budget.usage"))

    def test_receiver_survives_a_round_trip(self):
        """An instance method's trigger is useless without the construction."""
        self.target.write_text(
            "class Basket:\n"
            "    def __init__(self, items):\n        self.items = items\n"
            "    def average(self):\n"
            "        return sum(self.items) / len(self.items)\n",
            encoding="utf-8")
        report = investigate(self.target, "Basket.average", config=FAST)
        self.store.record(report.certificate)
        finding = self.store.findings()[0]
        self.assertIsNotNone(finding.receiver)
        self.assertIn("Basket(", finding.reproduce())
        self.assertIn(".average(", finding.reproduce())


class TestRecheck(StoreTestCase):
    """The lifecycle, driven by editing the code rather than by assertion."""

    def test_still_failing_while_the_bug_is_present(self):
        self.record()
        results = self.store.recheck(timeout=1.0)
        self.assertEqual([r.outcome for r in results], ["still_failing"])
        self.assertEqual(self.store.findings()[0].status, STATUS_OPEN)

    def test_fixed_once_the_guard_is_added(self):
        self.record()
        self.target.write_text(GUARDED, encoding="utf-8")
        results = self.store.recheck(timeout=1.0)
        self.assertEqual(results[0].outcome, STATUS_FIXED)
        self.assertIn("now returns", results[0].detail)
        self.assertFalse(results[0].is_regression)

    def test_regressed_when_the_guard_is_removed_again(self):
        self.record()
        self.target.write_text(GUARDED, encoding="utf-8")
        self.store.recheck(timeout=1.0)
        self.target.write_text(BUGGY, encoding="utf-8")
        results = self.store.recheck(timeout=1.0)
        self.assertEqual(results[0].outcome, STATUS_REGRESSED)
        self.assertTrue(results[0].is_regression)

    def test_regression_is_sticky_until_it_actually_passes(self):
        """Downgrading it on the next run would let a build go green while the
        defect is still there, which is the one thing this prevents."""
        self.record()
        self.target.write_text(GUARDED, encoding="utf-8")
        self.store.recheck(timeout=1.0)
        self.target.write_text(BUGGY, encoding="utf-8")
        for attempt in range(3):
            with self.subTest(attempt=attempt):
                results = self.store.recheck(timeout=1.0)
                self.assertTrue(results[0].is_regression)
        self.target.write_text(GUARDED, encoding="utf-8")
        self.assertEqual(self.store.recheck(timeout=1.0)[0].outcome,
                         STATUS_FIXED)

    def test_deleted_file_is_unreachable_not_fixed(self):
        """A deleted function is not a repaired one."""
        self.record()
        self.target.unlink()
        results = self.store.recheck(timeout=1.0)
        self.assertEqual(results[0].outcome, STATUS_UNREACHABLE)
        self.assertIn("gone", results[0].detail)

    def test_renamed_function_is_unreachable(self):
        self.record()
        self.target.write_text(BUGGY.replace("budget_usage", "usage_ratio"),
                               encoding="utf-8")
        results = self.store.recheck(timeout=1.0)
        self.assertEqual(results[0].outcome, STATUS_UNREACHABLE)
        self.assertIn("no longer exists", results[0].detail)

    def test_unparseable_file_is_unreachable(self):
        self.record()
        self.target.write_text("def broken(:\n", encoding="utf-8")
        results = self.store.recheck(timeout=1.0)
        self.assertEqual(results[0].outcome, STATUS_UNREACHABLE)

    def test_checks_are_logged(self):
        self.record()
        self.store.recheck(timeout=1.0)
        self.store.recheck(timeout=1.0)
        self.assertEqual(self.store.summary()["checks_run"], 2)

    def test_recheck_can_target_one_function(self):
        self.record()
        self.assertEqual(len(self.store.recheck(timeout=1.0,
                                               function="budget_usage")), 1)
        self.assertEqual(len(self.store.recheck(timeout=1.0,
                                               function="nothing")), 0)


class TestPytestExport(StoreTestCase):
    def test_generated_file_fails_while_the_bug_is_present(self):
        """The export is only worth anything if it actually catches the defect,
        so this runs pytest against it for real."""
        self.record()
        test_file = self.root / "test_regressions.py"
        test_file.write_text(to_pytest(self.store.findings()), encoding="utf-8")

        result = subprocess.run(
            [sys.executable, "-m", "pytest", str(test_file), "-q"],
            capture_output=True, text=True, cwd=self.root, timeout=120)
        if "No module named pytest" in result.stderr:
            self.skipTest("pytest is not installed")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("still raises ZeroDivisionError", result.stdout)

    def test_generated_file_passes_once_fixed(self):
        self.record()
        test_file = self.root / "test_regressions.py"
        test_file.write_text(to_pytest(self.store.findings()), encoding="utf-8")
        self.target.write_text(GUARDED, encoding="utf-8")

        result = subprocess.run(
            [sys.executable, "-m", "pytest", str(test_file), "-q"],
            capture_output=True, text=True, cwd=self.root, timeout=120)
        if "No module named pytest" in result.stderr:
            self.skipTest("pytest is not installed")
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_export_asserts_the_failure_is_gone_not_that_it_remains(self):
        """A test asserting the bug still exists has to be deleted when fixed,
        which is how a regression suite rots."""
        self.record()
        text = to_pytest(self.store.findings())
        self.assertIn("pytest.fail", text)
        self.assertIn("still raises", text)

    def test_export_is_importable_python(self):
        self.record()
        compile(to_pytest(self.store.findings()), "<generated>", "exec")

    def test_export_includes_the_trigger_and_date_for_a_reader(self):
        self.record()
        text = to_pytest(self.store.findings())
        self.assertIn("budget_usage(0, 0)", text)
        self.assertIn("Proven ", text)

    def test_export_handles_a_non_finite_finding(self):
        self.target.write_text(
            "def ratio(a, b):\n"
            "    if a == 0 and b == 0:\n        return float('nan')\n"
            "    return a / b\n",
            encoding="utf-8")
        report = investigate(self.target, "ratio", config=FAST)
        self.assertIsNotNone(report.certificate)
        self.store.record(report.certificate)
        text = to_pytest(self.store.findings())
        self.assertIn("math.isfinite(result)", text)
        compile(text, "<generated>", "exec")


class TestSummary(StoreTestCase):
    def test_summary_counts_by_status(self):
        finding, _ = self.record()
        summary = self.store.summary()
        self.assertEqual(summary["total"], 1)
        self.assertEqual(summary["by_status"], {STATUS_OPEN: 1})
        self.assertEqual(summary["regressed"], 0)

        self.store.mark_fixed(finding.id)
        self.record()
        self.assertEqual(self.store.summary()["regressed"], 1)


if __name__ == "__main__":
    unittest.main()
