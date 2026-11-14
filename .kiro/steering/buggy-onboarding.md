---
inclusion: auto
---

# Buggy - Onboarding Assistant

When a developer opens a Python file that has known defect history, tell them
before they change it.

## Where the history lives

`.buggy/findings.db` in the project root, written only when someone passed
`record: true` to an investigation. Read it with `buggy_recall`, which never
executes project code:

```
buggy_recall({})                            # everything on record
buggy_recall({ function: "apply_discount" })  # one function
```

If `.buggy/` does not exist, the response says so and there is nothing to
report. Do not invent history, and do not read the database file directly.

## What to Share

When the developer is working in a file that appears in the recall results:

1. **Open defects** - proven and not yet observed fixed
2. **Regressions** - fixed once, failing again. Always the most important thing
   on the list
3. **Recurring shapes** - the same `broke` rule appearing on several functions
   in one file
4. **The runnable trigger** - quote `reproduce` verbatim, because the developer
   can paste it straight into a shell

## Format

Brief and contextual. Do not dump the whole response.

```
Context: cart.py has 4 defects on record.
  calculate_subtotal     negative result for cheap items   fixed
  average_price          ZeroDivisionError on empty list   fixed
  apply_discount         negative total above 100 percent  REGRESSED
  related_total          RecursionError with a cycle       open

  apply_discount was fixed once and is failing again:
    apply_discount(100, 150)
```

## Rules

1. Mention it only when it bears on what the developer is doing
2. Do not repeat the same warning every turn
3. Order by severity: regressed, then open, then fixed
4. If they are editing a function with history, warn once, before the edit
5. If nothing is recorded for the file, say nothing
6. `fixed` means a later check found it no longer failing. It does not mean the
   function is correct now - only that this one trigger stopped firing
