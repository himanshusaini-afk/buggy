"""The executor: correct results, contained failures, and a fast hot path."""

from __future__ import annotations

import math
import time
import unittest

from buggy.executor import Executor, ExecutorError
from buggy.types import Outcome

TARGET = '''
import sys

def add(a, b):
    return a + b

def boom(x):
    return 1 / x

def noisy(x):
    print("stdout noise")
    sys.stdout.write("more noise\\n")
    return x * 2

def spin(n):
    while True:
        n += 1

def special(which):
    return {"nan": float("nan"), "inf": float("inf"),
            "ninf": float("-inf"), "negzero": -0.0,
            "big": 2 ** 70}[which]

def gives_set():
    return {1, 2, 3}

def quits():
    raise SystemExit(3)

def deep(n):
    return deep(n + 1)
'''


class ExecutorTestCase(unittest.TestCase):
    def setUp(self):
        self.executor = Executor(TARGET, filename="fixture.py", timeout=1.0)
        self.addCleanup(self.executor.close)


class TestResults(ExecutorTestCase):
    def test_returns_value(self):
        result = self.executor.call("add", [2, 3])
        self.assertIs(result.outcome, Outcome.OK)
        self.assertEqual(result.value, 5)

    def test_module_names_reported(self):
        self.assertIn("add", self.executor.module_names)

    def test_exception_is_described_not_raised(self):
        result = self.executor.call("boom", [0])
        self.assertIs(result.outcome, Outcome.RAISED)
        self.assertEqual(result.exception_type, "ZeroDivisionError")
        self.assertIn("division by zero", result.message)
        self.assertIn("Traceback", result.traceback_text)

    def test_missing_function_is_not_a_defect(self):
        result = self.executor.call("nope", [])
        self.assertEqual(result.exception_type, "FunctionNotResolved")

    def test_target_stdout_cannot_corrupt_the_protocol(self):
        """A print in the target must not be mistaken for a reply."""
        result = self.executor.call("noisy", [21])
        self.assertIs(result.outcome, Outcome.OK)
        self.assertEqual(result.value, 42)

    def test_special_floats_survive_transport(self):
        """No sentinel encoding needed: json carries these between Python
        processes losslessly, unlike JSON.stringify in the original."""
        self.assertTrue(math.isnan(self.executor.call("special", ["nan"]).value))
        self.assertEqual(self.executor.call("special", ["inf"]).value, math.inf)
        self.assertEqual(self.executor.call("special", ["ninf"]).value, -math.inf)
        self.assertEqual(self.executor.call("special", ["big"]).value, 2 ** 70)

        negzero = self.executor.call("special", ["negzero"]).value
        self.assertEqual(negzero, 0.0)
        self.assertEqual(math.copysign(1, negzero), -1.0, "sign of -0.0 preserved")

    def test_untransferable_value_is_flagged_not_faked(self):
        result = self.executor.call("gives_set", [])
        self.assertIs(result.outcome, Outcome.OK)
        self.assertEqual(result.fidelity, "coerced")
        self.assertEqual(result.value_type, "set")
        self.assertFalse(result.value_is_usable)

    def test_recursion_error_is_reported(self):
        result = self.executor.call("deep", [0])
        self.assertIs(result.outcome, Outcome.RAISED)
        self.assertEqual(result.exception_type, "RecursionError")


class TestContainment(ExecutorTestCase):
    def test_hang_times_out_and_worker_recovers(self):
        started = time.perf_counter()
        result = self.executor.call("spin", [0], timeout=0.3)
        elapsed = time.perf_counter() - started

        self.assertIs(result.outcome, Outcome.TIMEOUT)
        self.assertLess(elapsed, 5.0, "must not wait for the hung call")
        self.assertEqual(self.executor.respawns, 1)
        # The replacement worker is usable, with the module already reloaded.
        self.assertEqual(self.executor.call("add", [1, 1]).value, 2)

    def test_system_exit_is_reported_and_worker_replaced(self):
        result = self.executor.call("quits", [])
        self.assertIs(result.outcome, Outcome.RAISED)
        self.assertEqual(result.exception_type, "SystemExit")
        self.assertEqual(self.executor.call("add", [4, 4]).value, 8)

    def test_unserialisable_argument_raises_rather_than_misreporting(self):
        with self.assertRaises(ExecutorError):
            self.executor.call("add", [object(), 1])

    def test_limits_report_what_the_os_accepted(self):
        """Enforcement is platform-dependent, so it is reported, not assumed.

        RLIMIT_CPU works on macOS and Linux. RLIMIT_AS cannot be lowered on
        macOS at all, and claiming a memory cap the OS ignores would be worse
        than admitting there is none.
        """
        limits = self.executor.limits
        self.assertTrue(limits.get("supported"))
        self.assertIn("RLIMIT_CPU", limits)


class TestLoadFailures(unittest.TestCase):
    def test_syntax_error_is_a_load_error_not_a_finding(self):
        executor = Executor("def broken(:\n  pass\n")
        self.addCleanup(executor.close)
        self.assertIsNotNone(executor.load_error)
        self.assertEqual(executor.load_error.exception_type, "SyntaxError")

    def test_import_error_at_module_level(self):
        executor = Executor("import definitely_not_a_module\n")
        self.addCleanup(executor.close)
        self.assertIsNotNone(executor.load_error)
        self.assertIn(
            executor.load_error.exception_type,
            ("ModuleNotFoundError", "ImportError"),
        )

    def test_load_error_is_returned_for_every_call(self):
        executor = Executor("def broken(:\n  pass\n")
        self.addCleanup(executor.close)
        self.assertEqual(
            executor.call("broken", []).exception_type, "SyntaxError"
        )


class TestThroughput(ExecutorTestCase):
    def test_hot_path_is_fast_enough_to_be_usable(self):
        """The reason this module exists.

        The original spawned a fresh interpreter and wrote four temp files per
        input, costing ~35 ms locally and ~900 ms on the machine that produced
        the committed example logs, which is why investigating seven trivial
        functions took 494 seconds. Reusing the worker must stay far below that;
        the bound here is deliberately loose for slow CI.
        """
        count = 200
        started = time.perf_counter()
        for i in range(count):
            self.executor.call("add", [i, 1])
        per_call_ms = (time.perf_counter() - started) / count * 1000
        self.assertLess(per_call_ms, 5.0, f"{per_call_ms:.3f} ms/call")


if __name__ == "__main__":
    unittest.main()
