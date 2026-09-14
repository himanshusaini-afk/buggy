# WORKFLOW — Buggy end-to-end on `checkout-service`

This documents a **real, reproducible run** of Buggy against this sample project.
Every number, trigger, and log excerpt below is copied from the actual run in
`logs/`. Use it to see exactly how Buggy behaves — including its limits.

- **Result:** 4 bugs proven across 9 functions (2 languages), 3 functions correctly clean, 2 real bugs missed within budget (see §6).
- **Artifacts:** `logs/run.log`, `logs/summary.md`, `logs/investigations.jsonl`, `logs/watchlist.log`, and `.kiro/steering/buggy-watchlist.md`.

---

## 1. One command

From the Buggy repo root (with `dist/` built):

```bash
npm run build
node examples/checkout-service/run-buggy.mjs
```

`run-buggy.mjs` initializes Buggy on this folder, parses each file, investigates
every function, and writes the logs. It runs two passes — a TypeScript pass and
a Python pass (`language: python`) — because the checkout logic spans both.

---

## 2. The pipeline, as it actually ran

Buggy runs **Parse → Prove → Repair → Classify** per function.

**Parse** (from `run.log`):

```
analyze  src/pricing.ts         nodes=188 syntax_errors=0
analyze  src/inventory.ts       nodes=86  syntax_errors=0
```

**Prove → Repair → Classify** (per function). Each investigation fuzzes the
function on generated inputs, and on a violating input verifies the failure
(admissibility + soundness + reproducibility) into a certificate, then tries to
repair and screens patches for overfitting.

---

## 3. Findings (from `logs/summary.md`)

**4 bugs proven across 9 functions (5 reported clean).**

| Function | Lang | File | Status | Trigger | Violated |
|---|---|---|---|---|---|
| `applyDiscount` | ts | pricing.ts | unconfirmed | — | — |
| `pricePerUnit` | ts | pricing.ts | confirmed_no_repair | `[0,0]` | !isNaN(result) |
| `averageOrderValue` | ts | pricing.ts | confirmed_no_repair | `[[]]` | !isNaN(result) |
| `taxAmount` | ts | pricing.ts | unconfirmed | — | — |
| `stockCoverageDays` | ts | inventory.ts | confirmed_no_repair | `[0,0]` | !isNaN(result) |
| `reorderQuantity` | ts | inventory.ts | unconfirmed | — | — |
| `split_payment` | py | discounts.py | confirmed_no_repair | `[0,0]` | ZeroDivisionError: division by zero |
| `bulk_unit_price` | py | discounts.py | unconfirmed | — | — |
| `clamp_percent` | py | discounts.py | unconfirmed | — | — |

---

## 4. Reading one result in depth: `pricePerUnit`

```ts
export function pricePerUnit(total: number, quantity: number): number {
  return total / quantity;   // quantity 0 -> Infinity; 0/0 -> NaN
}
```

Buggy reported:

```
🐛 pricePerUnit   confirmed_no_repair   trigger=[0,0]  →  !isNaN(result)
```

- **`confirmed_no_repair`** = the bug is *proven*, but every candidate fix was rejected as overfit, so Buggy hands you the proof rather than an auto-patch.
- **`trigger=[0,0]`** = calling `pricePerUnit(0, 0)` returns `NaN`, which violates the built-in `!isNaN(result)` oracle.
- You fix it with the trigger in hand (see §7).

`split_payment` (Python) is the same story but a **crash**: `split_payment(0, 0)`
raises `ZeroDivisionError` — proven by executing the function in the system Python.

---

## 5. The clean functions (correctly `unconfirmed`)

`taxAmount`, `reorderQuantity`, and `clamp_percent` were fuzzed to the budget and
**no violating input was found** — they're genuinely safe over the tested range.
`clamp_percent` is bounded to `[0, 100]` by construction, so it can never produce
`NaN`/`Infinity`.

> **Why preconditions matter.** The runner declares each numeric parameter as
> finite and in a sane range (e.g. `Number.isFinite(price) && price >= 0 && price <= 100000`).
> Without that, Buggy's fuzzer injects `NaN`, and **every** unguarded arithmetic
> function returns `NaN` for a `NaN` input — so all of them would be flagged with
> a meaningless `[0, null]` trigger. Preconditions scope the search to realistic
> inputs so the *meaningful* bugs surface. This is the single most important knob
> for signal quality.

---

## 6. Honest limits: two bugs Buggy MISSED (this is important)

`applyDiscount` and `bulk_unit_price` **have real bugs but came back `unconfirmed`**:

```ts
applyDiscount(price, percentOff)  // percentOff > 100 -> NEGATIVE price (violates result >= 0)
```
```python
bulk_unit_price(total, quantity)  # quantity == 0 -> ZeroDivisionError
```

Why they were missed:

- Buggy proves bugs by **fuzzing**, which is **stochastic and budget-limited** (`search_budget: 30` here).
- `applyDiscount`'s bug needs a *combination* — a positive `price` **and** a `percentOff > 100` — in the same input. The fuzzer didn't pair those within 30 inputs.
- `bulk_unit_price` has the same structure as `split_payment` (which *was* caught at `[0,0]`); it was simply missed this run because input generation is randomized. **Re-running can catch it.**

What this teaches you about how Buggy works:

- It **reliably** catches bugs with a common single-value trigger (`0`, `[]`, division by an argument) — that's why `pricePerUnit`, `averageOrderValue`, `stockCoverageDays`, `split_payment` were all proven.
- It can **miss** bugs that need a specific multi-argument combination within a small budget.
- **A proven bug is always a true positive** (it's certified by re-execution). An `unconfirmed` is "not found within budget," **not** "proven safe."

How to improve the catch rate:

- Raise `probe.search_budget` in `.debugger.yaml` (e.g. 30 → 200) and re-run.
- Tighten the spec: add postconditions that express intent (e.g. `result >= 0` for prices), and narrow parameter ranges so the fuzzer spends its budget where bugs live.

---

## 7. Fix → verify

Apply the guards (using the proven triggers), then re-run to confirm they flip to `unconfirmed`.

```ts
// pricing.ts
export function pricePerUnit(total: number, quantity: number): number {
  if (quantity === 0) return 0;                 // or throw — but never NaN/Infinity
  return total / quantity;
}
export function averageOrderValue(orders: number[]): number {
  if (orders.length === 0) return 0;            // empty -> 0, not NaN
  return orders.reduce((a, b) => a + b, 0) / orders.length;
}
export function applyDiscount(price: number, percentOff: number): number {
  const pct = Math.max(0, Math.min(100, percentOff));  // clamp discount to [0,100]
  return price - price * (pct / 100);
}
```
```ts
// inventory.ts
export function stockCoverageDays(stock: number, dailyUsage: number): number {
  if (dailyUsage <= 0) return 0;   // no usage -> avoid Infinity; caller treats 0 as "n/a"
  return stock / dailyUsage;
}
```
```python
# discounts.py
def split_payment(total, people):
    if people == 0:
        return 0.0
    return total / people

def bulk_unit_price(total, quantity):
    if quantity == 0:
        return 0.0
    return total / quantity
```

Re-verify (expect the fixed functions to report `unconfirmed`):

```bash
node examples/checkout-service/run-buggy.mjs
```

> This example intentionally ships the **buggy** source so the detection run is
> reproducible. Apply the guards above in your own copy to watch the statuses flip.

---

## 8. The experience memory (from `logs/watchlist.log`)

Every investigation was recorded as an **episode** (9 total). Verified bugs became
**lessons**. Because `.debugger.yaml` sets `watchlist.scope: team`, Buggy also wrote
a committed lesson file at `.kiro/steering/buggy-watchlist.md`.

Episodes recorded:

```
[typescript] pricePerUnit       confirmed_no_repair  class=nan_result        trigger=[0,0]
[typescript] averageOrderValue  confirmed_no_repair  class=nan_result        trigger=[[]]
[typescript] stockCoverageDays  confirmed_no_repair  class=nan_result        trigger=[0,0]
[python]     split_payment      confirmed_no_repair  class=division_by_zero  trigger=[0,0]
... (+ 5 unconfirmed episodes)
```

Recall — what Kiro sees *before* editing a risky function:

```
buggy_recall({ function_id: "pricePerUnit" })
-> seen_before=true  lessons=1
   • [project] nan_result in pricePerUnit
       what_failed: Overfitting risk: top factors - identifier_count, literal_count, nesting_depth
       trigger: [0,0]
```

Stats:

```
{ total_episodes: 9, verified: 4, distinct_lessons: 9,
  outcomes: { confirmed_no_repair: 4, unconfirmed: 5 } }
```

The generated `.kiro/steering/buggy-watchlist.md` (committed → shared with the team)
lists the 4 proven lessons with their triggers, so every teammate — and Kiro —
inherits them automatically.

---

## 9. What each artifact contains

| File | What's in it |
|---|---|
| `logs/run.log` | Full transcript: analyze results + per-function investigation lines |
| `logs/summary.md` | The findings table (§3) |
| `logs/investigations.jsonl` | One JSON record per function (status, proof, patch counts) — machine-readable |
| `logs/watchlist.log` | The experience memory: episodes, a recall demo, and stats |
| `.kiro/steering/buggy-watchlist.md` | Committed team lessons (proof-backed), auto-generated |

---

## 10. Adapt it to your project

1. `npx buggy init` in your project; add `.debugger/` to `.gitignore`.
2. Set `language` (`typescript` or `python`) and, for signal quality, add finite/range **preconditions** to your specs (§5).
3. Copy `run-buggy.mjs`, point the target list at your functions, and run it — or just use the CLI (`npx buggy investigate <fn> --file <path>`) / the `buggy_recall` MCP tool from Kiro.
4. Commit `.kiro/` so the team inherits the memory.

See `../../docs/GETTING-STARTED.md` for the full onboarding guide and
`../../docs/Buggy-Usage-and-Sandbox-Guide.pdf` for capabilities and the sandbox in depth.
