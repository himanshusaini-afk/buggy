---
inclusion: manual
---

# Buggy — Specification Inference from Git Diff

When the user mentions a commit, branch, or asks to verify recent changes, infer specifications from the git context and run Buggy investigations.

## Triggering Phrases

- "check my recent changes"
- "verify this commit"
- "any bugs in what I just pushed?"
- "analyze the diff"

## Workflow

### Step 1: Get the diff context

Run `git diff HEAD~1 --stat` or `git diff main...HEAD` to see what changed.
Read the commit message with `git log -1 --format=%B`.

### Step 2: Infer intent from commit message

The commit message often reveals the specification:

| Commit message | Inferred postcondition |
|---------------|----------------------|
| "fix: handle empty array" | `items.length === 0 → result === defaultValue` |
| "feat: add discount capping" | `result >= 0, discount <= 100` |
| "refactor: extract helper" | Same behavior as before (no regression) |
| "perf: optimize calculation" | Same outputs for same inputs (behavioral equivalence) |

### Step 3: Investigate changed functions

For each function in the diff:
1. Infer specs from commit message + code context
2. Call `buggy_investigate` with those specs
3. Report any proven bugs in the new code

### Step 4: Report findings

```
Commit: "feat: add bulk discount for large orders"
Changed: calculateSubtotal() in src/cart.ts

Inferred spec:
  Pre: items.length > 0, items.every(i => i.price >= 0)
  Post: result >= 0

Investigation result: ⚠️ Bug found
  Input: [{price: 0.5, quantity: 15}] → Output: -22.5
  The bulk discount (price - 2) goes negative for items under $2.

Fix available (8% overfitting): Add guard `item.price > 2`
```
