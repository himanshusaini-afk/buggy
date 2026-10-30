"""The specification language: it must run Python, refuse JavaScript loudly,
and never silently treat an unevaluable condition as satisfied."""

from __future__ import annotations

import unittest

from buggy.specs import (
    SpecSyntaxError,
    build_bindings,
    compile_condition,
)
from buggy.types import Verdict


class TestPythonConditions(unittest.TestCase):
    def evaluate(self, expr, names=(), args=(), result=None, with_result=True):
        condition = compile_condition(expr)
        bindings = build_bindings(names, list(args), result, include_result=with_result)
        return condition.evaluate(bindings)

    def test_comparison_on_result(self):
        self.assertIs(self.evaluate("result >= 0", result=5).verdict, Verdict.TRUE)
        self.assertIs(self.evaluate("result >= 0", result=-5).verdict, Verdict.FALSE)

    def test_parameters_bind_positionally(self):
        out = self.evaluate("spent <= budget", ("spent", "budget"), (10, 20))
        self.assertIs(out.verdict, Verdict.TRUE)
        out = self.evaluate("spent <= budget", ("spent", "budget"), (30, 20))
        self.assertIs(out.verdict, Verdict.FALSE)

    def test_math_module_available(self):
        self.assertIs(
            self.evaluate("not math.isnan(result)", result=float("nan")).verdict,
            Verdict.FALSE,
        )
        self.assertIs(
            self.evaluate("math.isfinite(result)", result=float("inf")).verdict,
            Verdict.FALSE,
        )

    def test_comprehensions_see_bindings(self):
        """Regression: a generator expression compiles to its own scope and
        resolves free names against globals, so passing bindings as *locals*
        made this fail with NameError while the non-comprehension form worked."""
        out = self.evaluate(
            "all(math.isfinite(v) for v in amounts)", ("amounts",), ([1.0, 2.0],)
        )
        self.assertIs(out.verdict, Verdict.TRUE)
        out = self.evaluate(
            "all(math.isfinite(v) for v in amounts)",
            ("amounts",), ([1.0, float("nan")],),
        )
        self.assertIs(out.verdict, Verdict.FALSE)

    def test_builtins_for_collections(self):
        for expr, verdict in [
            ("len(xs) > 0", Verdict.FALSE),
            ("sum(xs) == 0", Verdict.TRUE),
            ("isinstance(xs, list)", Verdict.TRUE),
        ]:
            with self.subTest(expr=expr):
                self.assertIs(self.evaluate(expr, ("xs",), ([],)).verdict, verdict)

    def test_args_is_always_bound(self):
        out = self.evaluate("len(args) == 2", ("a", "b"), (1, 2))
        self.assertIs(out.verdict, Verdict.TRUE)

    def test_unknown_name_is_unevaluable_not_false(self):
        """The distinction that matters: 'cannot judge' is not 'does not hold'."""
        out = self.evaluate("mystery > 0")
        self.assertIs(out.verdict, Verdict.UNEVALUABLE)
        self.assertIn("mystery", out.reason)

    def test_runtime_error_is_unevaluable(self):
        out = self.evaluate("len(result) > 0", result=5)  # int has no len()
        self.assertIs(out.verdict, Verdict.UNEVALUABLE)
        self.assertIn("TypeError", out.reason)

    def test_empty_condition_rejected(self):
        with self.assertRaises(SpecSyntaxError):
            compile_condition("   ")


class TestJavaScriptIsRejected(unittest.TestCase):
    """The defect this package exists to fix.

    The TypeScript original compiled conditions with ``new Function``, so these
    were valid and a Python condition was not. Here the reverse holds, and the
    rejection names the Python equivalent instead of failing silently.
    """

    CASES = [
        ("Number.isFinite(x) && x >= 0", "and"),
        ("!isNaN(result)", "not"),
        ("values.length === 0", "=="),
        ("result !== null", "!="),
        ("a || b", "or"),
        ("x ?? 0", "or"),
        ("values.every(v => v > 0)", "Python"),
    ]

    def test_rejected_with_a_python_hint(self):
        for expr, expected_hint in self.CASES:
            with self.subTest(expr=expr):
                with self.assertRaises(SpecSyntaxError) as caught:
                    compile_condition(expr)
                self.assertIn(expected_hint, str(caught.exception))

    def test_lowercase_literals_are_caught(self):
        # `null`/`true` parse as plain names, so they reach evaluation and come
        # back unevaluable rather than raising at compile time. Either way the
        # user is told; what must never happen is a silent pass.
        condition = compile_condition("result != null")
        out = condition.evaluate(build_bindings((), [], 1, include_result=True))
        self.assertIs(out.verdict, Verdict.UNEVALUABLE)
        self.assertIn("null", out.reason)


class TestSandbox(unittest.TestCase):
    """A condition is a specification, not a program. It must not reach out."""

    BLOCKED = [
        "__import__('os').system('x')",
        "result.__class__.__mro__",
        "(lambda: 1)()",
        "open('/etc/passwd').read()",
        "result.__dict__",
        "[].__class__.__base__.__subclasses__()",
        "(x := 1)",
    ]

    def test_blocked_at_compile_time(self):
        for expr in self.BLOCKED:
            with self.subTest(expr=expr):
                with self.assertRaises(SpecSyntaxError):
                    compile_condition(expr)

    def test_no_builtins_leak_through(self):
        condition = compile_condition("eval")
        out = condition.evaluate({})
        self.assertIs(out.verdict, Verdict.UNEVALUABLE)


class TestBindings(unittest.TestCase):
    def test_result_does_not_overwrite_a_parameter(self):
        bindings = build_bindings(("result",), [7], 99, include_result=True)
        self.assertEqual(bindings["result"], 7, "the user's parameter wins")

    def test_non_identifier_names_are_skipped(self):
        bindings = build_bindings(("ok", "not-ok"), [1, 2])
        self.assertIn("ok", bindings)
        self.assertNotIn("not-ok", bindings)

    def test_extra_parameters_without_arguments(self):
        bindings = build_bindings(("a", "b", "c"), [1])
        self.assertEqual(bindings["a"], 1)
        self.assertNotIn("b", bindings)


if __name__ == "__main__":
    unittest.main()
