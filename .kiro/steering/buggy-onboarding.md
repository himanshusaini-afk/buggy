---
inclusion: auto
---

# Buggy — Onboarding Assistant

When a file is opened that has known bug history (tracked in `.debugger/bug-report.md`), proactively inform the developer about past issues and risk areas.

## When to Activate

When providing context about a file, check if `.debugger/bug-report.md` exists. If it does, read it and include relevant history in your responses.

## What to Share

When a developer is working in a file with bug history:

1. **High-risk functions** — functions that have had proven bugs before
2. **Common patterns** — recurring bug types in this file (e.g., "this file has had 3 off-by-one errors")
3. **Open bugs** — any proven bugs that haven't been fixed yet
4. **Related fixes** — patches that were applied to similar bugs in this file

## Format

Keep it brief and contextual — don't dump the full report. Example:

```
💡 Context: This file (src/cart.ts) has had 4 proven bugs historically:
   • calculateSubtotal — negative result for cheap items (fixed)
   • calculateAveragePrice — NaN on empty array (fixed)  
   • applyDiscount — negative total with discount > 100% (fixed)
   • calculateRelatedTotal — infinite recursion with cycles (open ⚠️)

   Be careful with the relatedMap parameter in calculateRelatedTotal.
```

## Rules

1. Only mention this when it's relevant to what the user is doing
2. Don't repeat the same warning in every response
3. Prioritize OPEN (unfixed) bugs over historical fixed ones
4. If the user is modifying a function with past bugs, warn once
5. If no bug report exists or the file has no history, say nothing
