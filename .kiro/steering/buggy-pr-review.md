---
inclusion: manual
---

# Buggy - PR Review Integration

When the user asks to "review a PR", "check this branch", "review my changes",
or "verify this diff", back the review with proven defects rather than opinions.

## Workflow

### Step 1: Get the diff

```bash
git diff main...HEAD --name-only        # a branch
git diff --staged --name-only           # uncommitted work
```

Then `git diff main...HEAD -- <file>` per file, to see which functions the
hunks actually touch.

### Step 2: Inventory each changed Python file - no execution

1. Call `buggy_functions` on the file. This confirms it parses and lists which
   functions are investigable.
2. Match the hunk line numbers against the reported function lines to work out
   which functions changed. Reviewing untouched functions wastes the budget.
3. Call `buggy_recall` on the changed functions. A defect already on record
   against code this PR touches belongs in the review, and a `regressed` status
   means this branch may have undone an earlier fix.

### Step 3: Investigate the changed functions

Investigation **executes the module**. On a branch that touches infrastructure
code, say so and get agreement before running it.

For each changed function, infer the specification from:

- the docstring, especially a documented raise or a stated invariant
- the return annotation
- parameter guards already present in the body
- the test file, if one exists

Then:

```
buggy_investigate({
  function: "apply_discount",
  file: "src/pricing.py",
  preconditions: ["price >= 0", "percent_off >= 0"],
  postconditions: ["result >= 0"]
})
```

Conditions are Python expressions.

### Step 4: Format as review

```
## PR Review - Buggy Verification

### src/utils.py - format_date
No failing input found within the 300-input budget. Not a proof of correctness.

### src/pricing.py - apply_discount    DEFECT PROVEN
Returns a negative price when the discount exceeds 100 percent.
  Reproduce:  apply_discount(100, 150)
  Result:     -50
  Broke:      result >= 0
  Verified:   admissible, re-observed in a fresh process, 3 of 3 repeats

A verified patch is available - clamp percent_off to [0, 100].

### src/pricing.py - calculate_tax
no_valid_input - the preconditions rejected every candidate, so this function
was never actually run. Nothing is known about it.

---
Summary: 3 functions changed, 1 defect proven, 1 never executed.
```

Report `unconfirmed` and `no_valid_input` as distinct from "clean". Collapsing
them into a pass is how a review becomes misleading.

### Step 5: Offer fixes

If the user wants a fix, call `buggy_repair` on the function. Each candidate
carries a verdict of `verified`, `overfit` or `rejected` with its evidence -
there is no numeric score. Show the diff and let the user choose. Nothing is
written to the file by the tool.

## Triggering

Activated manually, or when the user says:

- "review my changes"
- "check this PR"
- "verify the diff"
- "is this safe to merge?"
- "any bugs in my changes?"
