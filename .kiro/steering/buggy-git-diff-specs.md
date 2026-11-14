---
inclusion: manual
---

# Buggy - Specification Inference from Git History

When the user mentions a commit, a branch, or asks to verify recent changes,
read the intent out of the git context and turn it into a specification.

## Triggering Phrases

- "check my recent changes"
- "verify this commit"
- "any bugs in what I just pushed?"
- "analyze the diff"

## Workflow

### Step 1: Get the context

```bash
git diff HEAD~1 --stat
git diff main...HEAD
git log -1 --format=%B
```

### Step 2: Read the intent out of the message

A commit message usually states the specification the author had in mind:

| Commit message | Inferred condition |
|---|---|
| "fix: handle empty list" | post `len(items) == 0 or result > 0` |
| "feat: cap the discount" | post `result >= 0`, pre `percent_off <= 100` |
| "fix: guard division by zero" | post `math.isfinite(result)` |
| "refactor: extract helper" | behaviour unchanged - investigate with the pre-existing contract |
| "perf: speed up calculation" | same outputs for the same inputs |

A commit claiming to fix something is the strongest signal available: the
author is asserting a property. Investigate that exact property. If it was
recorded earlier, `buggy_recheck` confirms directly whether the fix held.

### Step 3: Investigate what the diff touched

Conditions are Python expressions. `buggy_investigate` executes the module, so
on infrastructure code confirm before running.

```
buggy_investigate({
  function: "calculate_subtotal",
  file: "src/cart.py",
  preconditions: ["len(items) > 0"],
  postconditions: ["result >= 0"]
})
```

If the commit claims to fix a defect already in `.buggy/findings.db`, prefer:

```
buggy_recheck({ function: "calculate_subtotal" })
```

An outcome of `fixed` is direct evidence the commit did what it said. A
`still_failing` outcome means it did not.

### Step 4: Report

```
Commit: "feat: bulk discount for large orders"
Changed: calculate_subtotal() in src/cart.py

Inferred from the message:
  pre   len(items) > 0
  post  result >= 0

Result: DEFECT PROVEN
  Reproduce:  calculate_subtotal([{"price": 0.5, "quantity": 15}])
  Result:     -22.5
  Broke:      result >= 0
  Cause:      the bulk discount subtracts 2 per unit, which goes negative
              for items under $2

Verified patch available: guard on item["price"] > 2.
```

If the status is `unconfirmed`, say the claimed property survived 300 generated
inputs, which is evidence but not proof. If it is `no_valid_input`, the
inferred precondition was too strict and the function never ran - loosen it and
try again rather than reporting a pass.
