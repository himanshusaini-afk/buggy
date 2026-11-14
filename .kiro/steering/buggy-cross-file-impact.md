---
inclusion: auto
---

# Buggy - Cross-File Impact Analysis

Before changing a function, check its callers so a fix in one place does not
break another.

## When This Applies

Whenever you are about to change a function's:

- return type, or the range of values it can return
- parameter types, count, or defaults
- raise behaviour (a new exception, or one no longer raised)
- side effects
- a guarantee a caller may rely on, for example "always returns >= 0"

## Workflow

### Step 1: Find the callers

There is no call-graph query in the Python package, so find callers with
`grep_search` on the function name, then confirm each hit is a real call rather
than a same-named attribute or a string.

For a method, search for the attribute (`.total(`) as well as the class name,
since the receiver may be built elsewhere.

### Step 2: Identify the assumptions

For each caller ask:

- does it assume the result is not `None`?
- does it assume a range, for example non-negative or non-zero?
- does it catch exceptions from this function, and would a new exception type
  slip past the `except` clause?
- does it pass the result straight into another function that has its own
  precondition?

### Step 3: Record what you are about to risk

Call `buggy_recall` on both the function and its callers before editing. A
defect already proven against a caller changes the order of work, and a
`regressed` status means a previous fix in this area did not hold. This only
reads, so it is always safe.

### Step 4: Verify after the change

1. Call `buggy_functions` on each changed file to confirm it still parses.
2. For the function you changed, call `buggy_investigate` with the guarantee
   the callers depend on as a postcondition, for example
   `postconditions: ["result >= 0"]`.
3. For a caller whose assumption you weakened, investigate the caller too, with
   the assumption written as its postcondition.

Remember that `buggy_investigate` executes the module. On code that touches a
network or a database at import time, confirm with the user first.

### Step 5: Report

One or two lines: "Changed `calculate_subtotal`. Checked 2 callers, both still
hold." Or: "Changed `calculate_subtotal`. `generate_invoice` in `invoice.py:12`
may break - it assumes a non-negative subtotal, which can now be negative."

## Example

```
Modifying: calculate_subtotal() in cart.py

Callers found by grep:
  - checkout.py:45  process_order() passes the result to apply_tax()
  - invoice.py:12   generate_invoice() assumes result >= 0

After modification:
  process_order     - still holds, investigated with post ["math.isfinite(result)"]
  generate_invoice  - at risk, proven: calculate_subtotal([]) returns -0.0
```
