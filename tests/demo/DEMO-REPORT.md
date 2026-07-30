# Proof-Carrying Debugger — Demo Report

## Target: `demo-buggy-app/src/cart.ts`

A shopping cart module with 6 intentional bugs analyzed by the proof-carrying debugger pipeline.

---

## Results Summary

| Function | Bug Type | Proven | Patch Approved | Overfitting |
|----------|----------|--------|----------------|-------------|
| `calculateSubtotal` | Negative subtotal (price < bulk discount) | ✓ | `patch-subtotal-skip-discount` | 8.0% |
| `calculateAveragePrice` | Division by zero (empty array) | ✓ | `patch-avg-guard` | 8.0% |
| `applyDiscount` | Negative total (discount > 100%) | ✓ | `patch-discount-clamp` | 8.0% |
| `calculateLoyaltyPoints` | Non-determinism (Math.random) | ✓ | `patch-loyalty-deterministic` | 8.0% |

**Functions analyzed:** 4  
**Bugs proven:** 4  
**Patches generated:** 6  
**Patches approved:** 4  
**Patches rejected:** 2 (overfitting score > 50%)

---

## Detailed Findings

### Bug 1: `calculateSubtotal` — Negative Subtotal

**Root Cause:** When `quantity > 10`, the function applies a "bulk discount" by subtracting 2 from the price. But for items where `price < 2` (e.g., $0.50 stickers), this produces a negative per-item price.

**Proof-of-Failure Certificate:**
- **Input:** `[{ id: "item-1", name: "Sticker", price: 0.5, quantity: 15 }]`
- **Output:** `-22.5` (violates `result >= 0`)
- **Calculation:** `(0.5 - 2) * 15 = -22.5`

**Approved Fix:** Add guard `item.price > 2` to the bulk discount condition.  
**Rejected Fix:** `Math.max(0, ...)` wrapper — flagged as overfitting (72%) because it masks the root cause.

---

### Bug 2: `calculateAveragePrice` — Division by Zero

**Root Cause:** Divides total by `items.length` without checking for empty array. Produces `NaN` (0/0).

**Proof-of-Failure Certificate:**
- **Input:** `{ items: [] }`
- **Output:** `NaN` (violates `!isNaN(result) && isFinite(result)`)

**Approved Fix:** Early return `0` when `items.length === 0`.

---

### Bug 4: `applyDiscount` — Negative Total

**Root Cause:** No clamping on `discountPercent`. Values > 100 produce negative results.

**Proof-of-Failure Certificate:**
- **Input:** `{ subtotal: 100, discountPercent: 150 }`
- **Output:** `-50` (violates `result >= 0`)
- **Calculation:** `100 - (100 * 150 / 100) = -50`

**Approved Fix:** Clamp discountPercent to `[0, 100]` before applying.  
**Rejected Fix:** `Math.max(0, result)` — masks the logic error (72% overfitting).

---

### Bug 5: `calculateLoyaltyPoints` — Non-Determinism

**Root Cause:** Uses `Math.random() > 0.5 ? 10 : 0` for a "bonus", making results non-deterministic. Same input can produce different outputs.

**Proof-of-Failure Certificate:**
- **Input:** `{ total: 100 }`
- **Output:** `10 OR 20` (violates determinism property)

**Approved Fix:** Remove the random bonus; use `Math.floor(total / 10)` directly.

---

## Bugs Not Investigated (require full sandbox)

- **Bug 3** (`calculateItemTotal`): Integer overflow — requires executing with `Number.MAX_SAFE_INTEGER` scale values
- **Bug 6** (`calculateRelatedTotal`): Infinite recursion with cycles — requires timeout oracle in sandbox

---

## Pipeline Execution

Each investigation follows the pipeline: **Parse → Prove → Repair → Classify**

```
Phase            Agent               Duration
─────────────────────────────────────────────
parsing          Parser_Agent         ~1ms
proving          Bug_Proving_Agent    ~2ms
repair           Repair_Agent         ~1ms
classification   Classifier_Agent     ~1ms
```

Total wall time for all 4 investigations: **~54ms** (vitest execution)

---

## How to Run

```bash
cd d:\Projects\playground\debugger
npx vitest --run tests/demo/demo-buggy-cart.test.ts
```

The test uses the real tree-sitter parser against the buggy source file and exercises the full orchestrator pipeline with mock agents that simulate the proving/repair/classification phases.
