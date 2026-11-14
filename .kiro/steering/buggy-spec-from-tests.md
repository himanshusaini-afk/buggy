---
inclusion: fileMatch
fileMatchPattern: "**/test_*.py,**/*_test.py,**/conftest.py"
---

# Buggy - Specification Inference from Existing Tests

When a pytest file is in context, read its assertions as a partial
specification. Tests cover the inputs the author thought of; Buggy generates
the ones they did not. Combining the two finds defects that live between the
test cases.

## Pattern Recognition

| Test assertion | Inferred postcondition |
|---|---|
| `assert fn(x) >= 0` | `result >= 0` |
| `assert fn(x) == y` | for that x, `result == y` (an edge case, not a general rule) |
| `assert fn(x) is not None` | `result is not None` |
| `assert not math.isnan(fn(x))` | `math.isfinite(result)` |
| `assert len(fn(x)) == n` | `len(result) == n` |
| `assert isinstance(fn(x), int)` | `isinstance(result, int)` |
| `assert fn(x)` | `bool(result)` |
| `assert fn([]) == 0` | `len(items) > 0 or result == 0` |
| `pytest.raises(ValueError)` | that input is outside the contract - a **precondition**, not a bug |
| `pytest.approx(y)` | a tolerance, so avoid exact equality in the postcondition |

`pytest.raises` is the one most often misread. A test asserting that bad input
raises is telling you the function's domain. Turn it into a precondition
excluding that input, so the fuzzer spends its budget inside the contract
instead of re-proving the documented raise.

## Workflow

1. Collect the `assert` statements and `pytest.raises` blocks, and group them by
   the function under test.
2. Read `@pytest.mark.parametrize` lists - they show the input domain the author
   considered valid, which is good raw material for preconditions.
3. Read fixtures in the file and in `conftest.py`: a fixture is the author's idea
   of a well-formed input, and makes a good `receiver` expression for a method.
4. Separate what you find into preconditions (domain), postconditions
   (guarantees), and single-point edge cases.
5. Drop the single-point cases. A postcondition true only for one input is not a
   specification and will produce a defect on the first other input.
6. Pass the rest to `buggy_investigate` as Python expressions.

## Example

```python
# test_cart.py
@pytest.mark.parametrize("items,expected", [([], 0), ([{"price": 5, "qty": 1}], 5)])
def test_total(items, expected):
    assert calculate_total(items) == expected

def test_rejects_negative_price():
    with pytest.raises(ValueError):
        calculate_total([{"price": -1, "qty": 1}])
```

Inferred:

```
preconditions:  ["all(i['price'] >= 0 for i in items)"]
postconditions: ["result >= 0", "len(items) > 0 or result == 0"]
```

The precondition comes from the `pytest.raises` test, not from a guess. The
exact-equality cases were dropped; `result >= 0` is what generalises.

## After investigating

If a defect is proven, the failing input is a test case the suite was missing.
Offer to add it. `buggy export-tests` writes recorded defects out as pytest
functions directly, so a proven defect can become a regression test without
being retyped.
