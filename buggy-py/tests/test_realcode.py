"""Regressions found by running buggy over real code rather than fixtures.

Every test here exists because a dogfooding pass over buggy's own source and
the standard library found something the fixture suite could not. Fixtures are
standalone single-purpose files; real code lives in packages, uses keyword-only
parameters, and raises on bad input by design.
"""

from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from buggy.generate import required_keyword_arguments
from buggy.inspection import deliberate_raises, find_function
from buggy.models import ParamKind
from buggy.prove import Config, investigate

FAST = Config(max_executions=60, timeout=1.0)


class TestRelativeImports(unittest.TestCase):
    """The single biggest gap dogfooding exposed.

    A module in a package fails on its first `from .sibling import x` unless
    the executed source is given package context. Before the fix, 140 of the
    149 analysable functions in buggy's own source reported "the module failed
    to load", and every fixture passed because fixtures are standalone files.
    """

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="buggy-pkg-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        package = self.root / "shop"
        package.mkdir()
        (package / "__init__.py").write_text("", encoding="utf-8")
        (package / "rates.py").write_text(
            "TAX = 0.2\n\n\ndef rate():\n    return TAX\n", encoding="utf-8")
        self.module = package / "pricing.py"
        self.module.write_text(
            "from .rates import rate\n"
            "\n"
            "\n"
            "def with_tax(amount):\n"
            "    return amount * (1 + rate())\n"
            "\n"
            "\n"
            "def per_unit(total, units):\n"
            "    return total / units\n",
            encoding="utf-8")

    def test_a_module_in_a_package_loads(self):
        report = investigate(self.module, "with_tax",
                             preconditions=["isinstance(amount, (int, float))"
                                            " and math.isfinite(amount)"],
                             config=FAST)
        self.assertNotEqual(report.status, "skipped", report.note)

    def test_a_defect_behind_a_relative_import_is_found(self):
        report = investigate(self.module, "per_unit", config=FAST)
        self.assertEqual(report.status, "proven", report.note)
        self.assertIn("ZeroDivisionError", report.certificate.rule)

    def test_the_sibling_is_really_imported(self):
        """Not stubbed: the value comes from the sibling module."""
        report = investigate(
            self.module, "with_tax",
            # math.isfinite matters: without it `inf` satisfies `amount > 0`,
            # and `inf > inf` is False, so the postcondition breaks on a value
            # the function only propagated. The tool says so in its advice.
            preconditions=["isinstance(amount, (int, float)) and "
                           "not isinstance(amount, bool) and "
                           "math.isfinite(amount) and amount > 0"],
            postconditions=["result > amount"],   # true only if TAX applied
            config=FAST)
        self.assertEqual(report.status, "unconfirmed", report.note)

    def test_a_nested_subpackage_loads(self):
        deep = self.root / "shop" / "eu" / "vat.py"
        deep.parent.mkdir()
        (deep.parent / "__init__.py").write_text("", encoding="utf-8")
        deep.write_text(
            "from ..rates import rate\n"
            "\n"
            "\n"
            "def share(total, parts):\n"
            "    return (total * rate()) / parts\n",
            encoding="utf-8")
        report = investigate(deep, "share", config=FAST)
        self.assertEqual(report.status, "proven", report.note)

    def test_a_standalone_script_still_works(self):
        """No __init__.py, so there is no package to belong to."""
        script = self.root / "loose.py"
        script.write_text("def half(x):\n    return x / 2\n", encoding="utf-8")
        report = investigate(
            script, "half",
            preconditions=["isinstance(x, (int, float))"], config=FAST)
        self.assertNotEqual(report.status, "skipped", report.note)

    def test_an_unimportable_sibling_is_still_a_load_error(self):
        """The fix must not paper over a genuinely broken import."""
        broken = self.root / "shop" / "broken.py"
        broken.write_text(
            "from .nonexistent import thing\n\n\ndef f(x):\n    return x\n",
            encoding="utf-8")
        report = investigate(broken, "f", config=FAST)
        self.assertEqual(report.status, "skipped")
        self.assertIn("failed to load", report.note)


class TestRequiredKeywordArguments(unittest.TestCase):
    """A keyword-only parameter without a default must be supplied.

    Excluding it from the positional arity is right, but omitting it from the
    call produced "missing a required keyword-only argument", a harness
    artifact indistinguishable from a defect in the target.
    """

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="buggy-kw-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.module = self.root / "kw.py"
        self.module.write_text(
            "def split(total, *, parts):\n"
            "    return total / parts\n"
            "\n"
            "\n"
            "def scaled(value, *, factor=2):\n"
            "    return value * factor\n",
            encoding="utf-8")

    def test_required_keyword_is_offered_a_value(self):
        source = self.module.read_text(encoding="utf-8")
        info = find_function(source, "split", str(self.module))
        keywords = required_keyword_arguments(info.signature)
        self.assertIn("parts", keywords)
        self.assertIsNotNone(keywords["parts"])

    def test_defaulted_keyword_is_left_alone(self):
        source = self.module.read_text(encoding="utf-8")
        info = find_function(source, "scaled", str(self.module))
        self.assertEqual(required_keyword_arguments(info.signature), {})

    def test_keyword_is_not_counted_as_positional_arity(self):
        source = self.module.read_text(encoding="utf-8")
        info = find_function(source, "split", str(self.module))
        self.assertEqual(info.signature.names, ("total",))
        self.assertEqual([p.name for p in info.signature.required_keywords],
                         ["parts"])
        self.assertIs(info.signature.parameters[1].kind, ParamKind.KEYWORD_ONLY)

    def test_the_call_happens_instead_of_failing_on_arity(self):
        report = investigate(self.module, "split", config=FAST)
        self.assertGreater(report.executions, 0)
        if report.certificate is not None:
            self.assertNotIn("keyword-only", report.certificate.detail or "")


class TestDeliberateRaises(unittest.TestCase):
    """A function rejecting bad input is honouring a contract, not failing.

    These findings outnumbered everything else on real code. They are still
    reported when nothing better is found, but ranked below a genuine fault.
    """

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="buggy-raise-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.module = self.root / "guarded.py"
        self.module.write_text(
            '"""A module with its own error type."""\n'
            "\n"
            "\n"
            "class ShopError(ValueError):\n"
            "    pass\n"
            "\n"
            "\n"
            "def validate(amount):\n"
            "    if amount < 0:\n"
            "        raise ShopError('amount must not be negative')\n"
            "    return amount\n"
            "\n"
            "\n"
            "def checked(amount):\n"
            '    """Delegates validation.\n'
            "\n"
            "    @raises ShopError: when the amount is negative.\n"
            '    """\n'
            "    return validate(amount) * 2\n"
            "\n"
            "\n"
            "def undocumented(a, b):\n"
            "    return a / b\n",
            encoding="utf-8")
        self.source = self.module.read_text(encoding="utf-8")

    def info(self, name):
        return find_function(self.source, name, str(self.module))

    def test_an_explicit_raise_in_the_body_is_detected(self):
        self.assertIn("ShopError",
                      deliberate_raises(self.source, self.info("validate"),
                                        str(self.module)))

    def test_a_docstring_declaration_is_detected(self):
        """The author saying so is the strongest evidence available."""
        self.assertIn("ShopError",
                      deliberate_raises(self.source, self.info("checked"),
                                        str(self.module)))

    def test_a_modules_own_error_propagating_from_a_helper_is_detected(self):
        """Six functions in buggy's own source re-raise SourceSyntaxError from
        a helper without mentioning it anywhere in their own body."""
        self.assertIn("ShopError",
                      deliberate_raises(self.source, self.info("undocumented"),
                                        str(self.module)))

    def test_an_unrelated_exception_is_not_excused(self):
        found = deliberate_raises(self.source, self.info("undocumented"),
                                  str(self.module))
        self.assertNotIn("ZeroDivisionError", found)

    def test_a_documented_bug_is_not_treated_as_a_contract(self):
        """The trap this rule nearly walked into.

        An earlier version read a bare "raises X" from anywhere in the
        docstring, and so suppressed a real defect whose docstring read
        "BUG: denominator == 0 raises ZeroDivisionError". Documenting a bug is
        the opposite of declaring a contract, and silently ignoring the finding
        would be far worse than the noise the rule exists to remove. Only
        structured markup counts.
        """
        module = self.root / "documented_bug.py"
        module.write_text(
            "def divide(a, b):\n"
            '    """BUG: b == 0 raises ZeroDivisionError."""\n'
            "    return a / b\n"
            "\n"
            "\n"
            "def notes(a, b):\n"
            '    """Known to raise ValueError sometimes. Raises nothing else.\n'
            "\n"
            "    Historically this raised OverflowError as well.\n"
            '    """\n'
            "    return a / b\n",
            encoding="utf-8")
        source = module.read_text(encoding="utf-8")

        for name in ("divide", "notes"):
            with self.subTest(function=name):
                info = find_function(source, name, str(module))
                self.assertEqual(
                    deliberate_raises(source, info, str(module)), frozenset(),
                    "prose must not be read as a declaration")

        report = investigate(module, "divide", config=FAST)
        self.assertEqual(report.status, "proven")
        self.assertIn("ZeroDivisionError", report.certificate.rule)
        self.assertIsNone(report.note, "the finding must not be ranked weak")

    def test_structured_markup_in_several_styles_is_honoured(self):
        module = self.root / "styles.py"
        module.write_text(
            '"""Module with its own error."""\n'
            "\n"
            "\n"
            "class StyleError(Exception):\n"
            "    pass\n"
            "\n"
            "\n"
            "def sphinx(x):\n"
            '    """Do a thing.\n'
            "\n"
            "    :raises ValueError: when x is bad.\n"
            '    """\n'
            "    return x\n"
            "\n"
            "\n"
            "def google(x):\n"
            '    """Do a thing.\n'
            "\n"
            "    Raises:\n"
            "        KeyError: when x is missing.\n"
            '    """\n'
            "    return x\n",
            encoding="utf-8")
        source = module.read_text(encoding="utf-8")
        self.assertIn("ValueError", deliberate_raises(
            source, find_function(source, "sphinx", str(module)), str(module)))
        self.assertIn("KeyError", deliberate_raises(
            source, find_function(source, "google", str(module)), str(module)))

    def test_a_contract_exception_is_ranked_below_a_real_fault(self):
        report = investigate(self.module, "validate", config=FAST)
        if report.status == "proven":
            self.assertTrue(report.violations)
            self.assertTrue(
                all(v.severity < 3 for v in report.violations
                    if "ShopError" in v.rule),
                "a declared exception must not outrank a genuine fault")

    def test_a_genuine_fault_is_still_strong(self):
        report = investigate(self.module, "undocumented", config=FAST)
        self.assertEqual(report.status, "proven")
        self.assertIn("ZeroDivisionError", report.certificate.rule)
        self.assertIsNone(report.note, "should not be ranked as weak")


class TestSelfHosting(unittest.TestCase):
    """buggy analysing its own source, which is how all of the above surfaced."""

    PACKAGE = Path(__file__).resolve().parents[1] / "buggy"

    def test_its_own_modules_load(self):
        """The property that matters: a package module must be analysable."""
        skipped = []
        for name in ("prove.py", "repair.py", "oracles.py", "store.py"):
            path = self.PACKAGE / name
            report = investigate(path, "_now" if name == "store.py"
                                 else "_package_context" if name == "prove.py"
                                 else "canonical" if name == "oracles.py"
                                 else "_original_exception",
                                 config=Config(max_executions=5, timeout=1.0))
            if report.status == "skipped" and "failed to load" in (report.note or ""):
                skipped.append((name, report.note))
        self.assertEqual(skipped, [], "package modules must load")


if __name__ == "__main__":
    unittest.main()
