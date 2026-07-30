---
inclusion: manual
---

# Buggy — PR Review Integration

When the user asks to "review a PR", "check this branch", "review my changes", or "verify this diff", use Buggy to provide proof-backed code review.

## Workflow

### Step 1: Get the diff

Run `git diff main...HEAD --name-only` (or `git diff --staged --name-only` for uncommitted changes) to find changed files.

### Step 2: For each changed .ts file

1. Call `buggy_analyze` to check for syntax issues
2. Call `buggy_list_functions` to identify functions in that file
3. Determine which functions were modified (from the diff hunks)

### Step 3: Investigate changed functions

For each modified function:
1. Infer specifications from:
   - The function's JSDoc comments
   - Its return type
   - Parameter constraints visible in the code
   - Related test files (if they exist)
2. Call `buggy_investigate` with those specifications

### Step 4: Format as review

Present results as a structured review:

```
## PR Review — Buggy Verification

### ✅ src/utils.ts — formatDate
No bugs found with inferred specifications.

### ⚠️ src/payments.ts — applyDiscount  
**Bug proven:** When discountPercent > 100, result becomes negative.
- Input: `{subtotal: 100, discountPercent: 150}`
- Output: `-50` (violates `result >= 0`)
- Approved fix available (overfitting: 8%)

### ✅ src/payments.ts — calculateTax
No bugs found with inferred specifications.

---
**Summary:** 3 functions checked, 1 bug proven, 1 fix available.
```

### Step 5: Offer to apply fixes

If approved patches exist, ask: "Want me to apply the verified fixes to this branch?"

## Triggering

This steering is activated manually when the user mentions PR review. It can also be triggered by the user saying:
- "review my changes"
- "check this PR"  
- "verify the diff"
- "is this safe to merge?"
- "any bugs in my changes?"
