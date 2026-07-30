---
inclusion: auto
---

# Buggy — Bug Trend Tracking

After every Buggy investigation that finds a confirmed bug, update the bug trend report at `.debugger/bug-report.md`.

## When to Update

After any `buggy_investigate` call returns `status: "confirmed_and_repaired"` or `status: "confirmed_no_repair"`.

## Report Format

Maintain `.debugger/bug-report.md` with this structure:

```markdown
# Bug Trend Report

Last updated: [timestamp]

## Summary

| Metric | Count |
|--------|-------|
| Total investigations | X |
| Bugs proven | Y |
| Fixes applied | Z |
| Open (unfixed) | W |

## By File (Risk Heatmap)

| File | Bugs Found | Fixed | Open | Risk |
|------|-----------|-------|------|------|
| src/cart.ts | 4 | 3 | 1 | 🔴 High |
| src/payments.ts | 2 | 2 | 0 | 🟢 Clean |
| src/auth.ts | 1 | 0 | 1 | 🟡 Medium |

## Bug Patterns

| Pattern | Occurrences | Example |
|---------|-------------|---------|
| Unclamped numeric input | 3 | discount > 100% |
| Division by zero | 2 | empty array .length |
| Non-determinism | 1 | Math.random in logic |

## Recent Bugs

### [date] — calculateSubtotal (src/cart.ts)
- **Type:** Negative result from unclamped subtraction
- **Trigger:** `{price: 0.5, quantity: 15}`
- **Status:** Fixed ✓
- **Fix:** Guard `item.price > 2` before bulk discount

### [date] — calculateAveragePrice (src/cart.ts)
- **Type:** Division by zero
- **Trigger:** `[]` (empty array)
- **Status:** Fixed ✓
- **Fix:** Early return 0 for empty array
```

## Rules

1. Only add entries for PROVEN bugs (with certificates), not speculative issues
2. Mark bugs as "Fixed ✓" when an approved patch is applied
3. Update the risk heatmap colors based on open bug count:
   - 0 open = 🟢 Clean
   - 1 open = 🟡 Medium
   - 2+ open = 🔴 High
4. Keep the "Recent Bugs" section to last 20 entries
5. Update "Bug Patterns" by grouping similar root causes
