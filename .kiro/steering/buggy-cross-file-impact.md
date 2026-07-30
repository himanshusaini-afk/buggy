---
inclusion: auto
---

# Buggy — Cross-File Impact Analysis

Before modifying any function, check its callers to ensure changes don't break downstream consumers.

## When This Applies

Whenever you're about to change a function's:
- Return type
- Parameter types or count
- Throw behavior
- Side effects
- Postcondition guarantees (e.g., "always returns >= 0" → now might return negative)

## Workflow

### Step 1: Before modifying a function

1. Call `buggy_query_graph` with `query_type: "callees"` using the function's node ID to find what it calls
2. More importantly: search the codebase for all callers of this function using grep or the graph database

### Step 2: Identify impact

For each caller:
- Does the caller assume the return value is non-null?
- Does the caller assume the return value is in a specific range?
- Does the caller catch exceptions from this function?
- Does the caller pass the result to another function with preconditions?

### Step 3: Verify after change

After applying the modification:
1. Call `buggy_analyze` on the modified file
2. Call `buggy_analyze` on each file containing a caller
3. If any callers might break, call `buggy_investigate` on them with appropriate specs

### Step 4: Report

Briefly note: "Changed X. Verified Y callers still work. No issues found." Or: "Changed X. Caller Z in file.ts may break because it assumes non-negative return."

## Example

```
Modifying: calculateSubtotal() in cart.ts
Callers found:
  - checkout.ts:45 → processOrder() passes result to applyTax()
  - invoice.ts:12 → generateInvoice() assumes result >= 0

After modification:
  ✅ processOrder — still works (result type unchanged)
  ⚠️ generateInvoice — may break if subtotal can now be negative
```
