"""Input generation: Python's hazards, and an affordable schedule."""

from __future__ import annotations

import json
import math
import unittest

from buggy.generate import (
    MAX_COMBINATIONS,
    generate_arguments,
    values_for_annotation,
)
from buggy.types import Parameter, ParamKind, Signature


def _signature(*annotations: str | None) -> Signature:
    return Signature(
        parameters=tuple(
            Parameter(name=f"p{i}", annotation=a) for i, a in enumerate(annotations)
        )
    )


class TestCorpora(unittest.TestCase):
    def test_every_generated_value_can_cross_a_process_boundary(self):
        """A value that cannot be serialised cannot be tested, and would abort
        the investigation rather than produce a finding."""
        for annotation in (None, "int", "float", "str", "bool", "list[int]",
                           "list[str]", "dict", "Optional[int]", "Widget"):
            with self.subTest(annotation=annotation):
                for value in values_for_annotation(annotation):
                    json.dumps(value)  # must not raise

    def test_zero_is_always_offered_for_numbers(self):
        for annotation in ("int", "float"):
            self.assertIn(0, [v for v in values_for_annotation(annotation)
                              if isinstance(v, int) and not isinstance(v, bool)]
                          or [v for v in values_for_annotation(annotation) if v == 0])

    def test_floats_include_nan_and_infinities(self):
        values = values_for_annotation("float")
        self.assertTrue(any(isinstance(v, float) and math.isnan(v) for v in values))
        self.assertIn(math.inf, values)
        self.assertIn(-math.inf, values)

    def test_collections_include_the_empty_case(self):
        for annotation in ("list[int]", "list[float]", "list[str]", "dict"):
            with self.subTest(annotation=annotation):
                values = values_for_annotation(annotation)
                self.assertTrue(any(len(v) == 0 for v in values))

    def test_strings_include_empty_and_numeric_looking(self):
        values = values_for_annotation("str")
        self.assertIn("", values)
        self.assertIn("0", values)

    def test_optional_admits_none(self):
        for annotation in ("Optional[int]", "int | None", "Union[int, None]",
                           "typing.Optional[float]"):
            with self.subTest(annotation=annotation):
                self.assertIn(None, values_for_annotation(annotation))

    def test_plain_int_does_not_offer_none(self):
        self.assertNotIn(None, values_for_annotation("int"))

    def test_unannotated_offers_none_but_not_first(self):
        """``None`` is productive, but it is ranked last on purpose.

        Passing ``None`` to arithmetic raises TypeError, which is trivially easy
        to trigger and is the caller's mistake. Tried first, it would become the
        reported trigger and bury the ZeroDivisionError worth knowing about.
        """
        values = values_for_annotation(None)
        self.assertIn(None, values)
        self.assertIsNot(values[0], None)
        self.assertEqual(values[0], 0, "a divisor is the most useful first try")
        self.assertGreater(
            values.index(None), values.index([]),
            "type confusion comes after the same-type edge cases",
        )

    def test_unannotated_spans_numeric_magnitudes(self):
        """Regression: a corpus of only special values plus 0/1/-1 made the
        documented ``apply_discount`` defect unreachable, because every
        candidate above 100 was either infinite or outside the precondition
        range. Percentage arithmetic needs ordinary numbers just past 100.
        """
        values = values_for_annotation(None)
        numeric = [
            v for v in values
            if isinstance(v, (int, float))
            and not isinstance(v, bool)
            and math.isfinite(v)
        ]
        self.assertTrue(any(100 < v <= 100_000 for v in numeric),
                        "needs an admissible value above 100")
        self.assertTrue(any(v == 0 for v in numeric))
        self.assertTrue(any(v < 0 for v in numeric))

    def test_unknown_class_probes_the_boundary(self):
        values = values_for_annotation("SomeUserClass")
        self.assertIn(None, values)


class TestScheduling(unittest.TestCase):
    def test_no_parameters_yields_one_empty_call(self):
        self.assertEqual(generate_arguments(_signature()), [[]])

    def test_single_parameter_wraps_each_value_as_one_argument(self):
        combos = generate_arguments(_signature("list[int]"), limit=5)
        self.assertTrue(all(len(c) == 1 for c in combos))
        self.assertTrue(
            any(c[0] == [] for c in combos),
            "a list argument must stay one argument, not be spread",
        )

    def test_respects_the_limit(self):
        for count in (1, 2, 3, 4):
            with self.subTest(parameters=count):
                signature = _signature(*(["float"] * count))
                combos = generate_arguments(signature, limit=40)
                self.assertLessEqual(len(combos), 40)

    def test_arity_always_matches_the_signature(self):
        """An argument list of the wrong length raises TypeError in the target,
        which looks exactly like a defect."""
        for count in (1, 2, 3, 5):
            with self.subTest(parameters=count):
                signature = _signature(*(["int"] * count))
                for combo in generate_arguments(signature, limit=60):
                    self.assertEqual(len(combo), count)

    def test_keyword_only_and_variadic_excluded_from_arity(self):
        signature = Signature(parameters=(
            Parameter("a", "int"),
            Parameter("rest", None, False, ParamKind.VAR_POSITIONAL),
            Parameter("flag", "bool", True, ParamKind.KEYWORD_ONLY),
        ))
        for combo in generate_arguments(signature, limit=10):
            self.assertEqual(len(combo), 1)

    def test_wide_signatures_use_one_hot_first(self):
        """With three or more parameters an exhaustive product is unaffordable,
        so the first wave varies one parameter at a time to isolate blame."""
        combos = generate_arguments(_signature("int", "int", "int"), limit=24)
        self.assertTrue(combos)
        background = combos[0]
        differing = [
            sum(1 for a, b in zip(c, background) if a != b) for c in combos[:8]
        ]
        self.assertTrue(any(d <= 1 for d in differing))

    def test_two_parameters_vary_both_early(self):
        """Regression: row-major nesting spent the whole budget on the first few
        values of the first parameter.

        Investigating the stdlib's ``fmean(data, weights)`` with a "non-empty
        list of finite numbers" precondition executed *zero* inputs, because
        every pair within the budget held a scalar in the ``data`` slot. The
        diagonal walk must reach a collection in position 0 quickly.
        """
        signature = _signature(None, None)
        combos = generate_arguments(signature, limit=60)
        first_slot = [c[0] for c in combos]
        self.assertTrue(
            any(isinstance(v, list) and v for v in first_slot),
            "a non-empty list must be reachable in the first slot early",
        )
        second_slot = [c[1] for c in combos]
        self.assertGreater(len({repr(v) for v in first_slot}), 3,
                           "the first parameter must actually vary")
        self.assertGreater(len({repr(v) for v in second_slot}), 3,
                           "the second parameter must actually vary")

    def test_two_parameter_pairs_are_unique(self):
        combos = generate_arguments(_signature("int", "int"), limit=120)
        self.assertEqual(len(combos), len({repr(c) for c in combos}))

    def test_two_parameters_start_with_both_edge_values(self):
        """(0, 0) is the single most productive pair for arithmetic."""
        combos = generate_arguments(_signature("int", "int"), limit=5)
        self.assertEqual(combos[0], [0, 0])

    def test_is_deterministic_for_a_fixed_seed(self):
        signature = _signature("float", "float", "float")
        first = generate_arguments(signature, limit=50, seed=7)
        second = generate_arguments(signature, limit=50, seed=7)
        # Compared by repr, not by value: the corpus contains NaN, and
        # `float('nan') != float('nan')`, so equal lists would never compare
        # equal. The same trap makes a NaN-returning function look
        # non-deterministic, which is why oracles.canonical folds NaN to a token.
        self.assertEqual(repr(first), repr(second))

    def test_default_limit_is_bounded(self):
        combos = generate_arguments(_signature("float", "float"))
        self.assertLessEqual(len(combos), MAX_COMBINATIONS)


if __name__ == "__main__":
    unittest.main()
