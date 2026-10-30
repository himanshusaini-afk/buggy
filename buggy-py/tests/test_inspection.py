"""Signature and structure recovery from source."""

from __future__ import annotations

import unittest
from pathlib import Path

from buggy.inspection import (
    SourceSyntaxError,
    describe_unsupported,
    find_function,
    find_functions,
    function_source,
    non_code_lines,
)
from buggy.types import ParamKind

FIXTURE = Path(__file__).parent / "fixtures" / "sample.py"


class InspectionTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = FIXTURE.read_text(encoding="utf-8")
        cls.functions = find_functions(cls.source, str(FIXTURE))
        cls.by_name = {f.qualified_name: f for f in cls.functions}


class TestDiscovery(InspectionTestCase):
    def test_finds_module_functions(self):
        for name in ("divide", "mean", "apply_discount", "clamp_percent"):
            self.assertIn(name, self.by_name)

    def test_qualifies_class_members(self):
        self.assertIn("Calculator.static_divide", self.by_name)
        self.assertIn("Calculator.instance_method", self.by_name)
        self.assertIn("Calculator.Nested.deep", self.by_name)

    def test_marks_nested_functions(self):
        self.assertTrue(self.by_name["outer.inner"].is_nested
                        if "outer.inner" in self.by_name
                        else self.by_name["inner"].is_nested)

    def test_classifies_kinds(self):
        self.assertEqual(self.by_name["divide"].kind, "function")
        self.assertEqual(self.by_name["async_fn"].kind, "async_function")
        self.assertEqual(self.by_name["Calculator.instance_method"].kind, "method")

    def test_records_decorators_and_property(self):
        self.assertIn("staticmethod", self.by_name["Calculator.static_divide"].decorators)
        self.assertTrue(self.by_name["Calculator.value"].is_property)

    def test_lookup_prefers_module_level_on_a_bare_name(self):
        found = find_function(self.source, "divide", str(FIXTURE))
        self.assertEqual(found.qualified_name, "divide")

    def test_lookup_by_qualified_name(self):
        found = find_function(self.source, "Calculator.static_divide", str(FIXTURE))
        self.assertEqual(found.name, "static_divide")

    def test_missing_function_returns_none(self):
        self.assertIsNone(find_function(self.source, "absent", str(FIXTURE)))

    def test_syntax_error_reports_position(self):
        with self.assertRaises(SourceSyntaxError) as caught:
            find_functions("def broken(:\n  pass\n", "bad.py")
        self.assertIn("bad.py:1:", str(caught.exception))


class TestSignatures(InspectionTestCase):
    def test_plain_parameters(self):
        self.assertEqual(self.by_name["divide"].signature.names,
                         ("numerator", "denominator"))

    def test_annotations_are_captured_as_text(self):
        signature = self.by_name["apply_discount"].signature
        self.assertEqual([p.annotation for p in signature.parameters],
                         ["float", "float"])
        self.assertEqual(signature.return_annotation, "float")

    def test_receiver_is_not_a_parameter(self):
        """Regression: the original counted ``self``, so every method's arity
        was one too high and the fuzzer called it with a spare argument. The
        resulting TypeError is indistinguishable from a real defect."""
        signature = self.by_name["Calculator.instance_method"].signature
        self.assertEqual(signature.names, ("value",))
        self.assertNotIn("self", signature.names)

    def test_classmethod_receiver_also_dropped(self):
        self.assertEqual(self.by_name["Calculator.describe"].signature.names,
                         ("prefix",))

    def test_staticmethod_keeps_every_parameter(self):
        self.assertEqual(self.by_name["Calculator.static_divide"].signature.names,
                         ("a", "b"))

    def test_keyword_only_excluded_from_positional_call(self):
        signature = self.by_name["annotated"].signature
        self.assertEqual(signature.names, ("count", "label"))
        scale = next(p for p in signature.parameters if p.name == "scale")
        self.assertIs(scale.kind, ParamKind.KEYWORD_ONLY)
        self.assertTrue(scale.has_default)

    def test_positional_only_marked(self):
        signature = self.by_name["positional_only"].signature
        kinds = {p.name: p.kind for p in signature.parameters}
        self.assertIs(kinds["a"], ParamKind.POSITIONAL_ONLY)
        self.assertIs(kinds["c"], ParamKind.POSITIONAL_OR_KEYWORD)

    def test_defaults_align_to_the_right(self):
        signature = self.by_name["positional_only"].signature
        has_default = {p.name: p.has_default for p in signature.parameters}
        self.assertFalse(has_default["a"])
        self.assertFalse(has_default["b"])
        self.assertTrue(has_default["c"])

    def test_variadics_excluded_from_arity(self):
        signature = self.by_name["variadic"].signature
        self.assertEqual(signature.names, ("first",))
        kinds = {p.kind for p in signature.parameters}
        self.assertIn(ParamKind.VAR_POSITIONAL, kinds)
        self.assertIn(ParamKind.VAR_KEYWORD, kinds)


class TestSupportBoundary(InspectionTestCase):
    def test_plain_function_is_supported(self):
        self.assertIsNone(describe_unsupported(self.by_name["divide"]))

    def test_staticmethod_is_supported(self):
        self.assertIsNone(describe_unsupported(self.by_name["Calculator.static_divide"]))

    def test_instance_method_refused_with_a_reason(self):
        reason = describe_unsupported(self.by_name["Calculator.instance_method"])
        self.assertIsNotNone(reason)
        self.assertIn("receiver", reason)

    def test_async_refused_with_a_reason(self):
        self.assertIn("async", describe_unsupported(self.by_name["async_fn"]))

    def test_property_refused(self):
        self.assertIsNotNone(describe_unsupported(self.by_name["Calculator.value"]))

    def test_nested_refused(self):
        nested = next(f for f in self.functions if f.is_nested)
        self.assertIn("reachable", describe_unsupported(nested))


class TestSourceSlicing(InspectionTestCase):
    def test_function_source_includes_decorators(self):
        text = function_source(self.source, self.by_name["Calculator.static_divide"])
        self.assertTrue(text.lstrip().startswith("@staticmethod"))
        self.assertIn("def static_divide", text)

    def test_docstrings_are_not_code(self):
        """Exactness matters here: a docstring line reading
        ``BUG: denominator == 0 raises`` contains ``==`` and looks like code to
        any text heuristic, so patch generation must not treat it as such."""
        lines = non_code_lines(self.source, str(FIXTURE))
        source_lines = self.source.splitlines()
        docstring_line = next(
            i for i, text in enumerate(source_lines, start=1)
            if "raises ZeroDivisionError" in text
        )
        self.assertIn(docstring_line, lines)

        code_line = next(
            i for i, text in enumerate(source_lines, start=1)
            if text.strip() == "return numerator / denominator"
        )
        self.assertNotIn(code_line, lines)

    def test_comments_and_blanks_are_not_code(self):
        lines = non_code_lines("x = 1\n# comment\n\ny = 2\n")
        self.assertEqual(lines, {2, 3})


if __name__ == "__main__":
    unittest.main()
