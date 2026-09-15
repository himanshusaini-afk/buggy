# WORKFLOW — Buggy live demo (expense-tracker)

This documents the **actual live-demo run** performed in this session. Every
number, trigger, timestamp, and status below is copied from the real output —
including the part where Buggy proves a bug but **refuses to ship a fix**.

- **Result:** 4/4 target bugs proven autonomously, then one function taken through the full pipeline where all 3 candidate patches were rejected as overfit (`confirmed_no_repair`).
- **What ran:** `live-demo/test-real-proving.mjs` (batch proving) + the `buggy_investigate` MCP tool (full Parse → Prove → Repair → Classify pipeline).

---

## 1. The source under test

Four unguarded divisions across the sample expense-tracker:

| Function | File | Body | Fails when |
|---|---|---|---|
| `splitExpense(amount, people)` | `src/expenses.ts` | `amount / people` | `people = 0` → `NaN` |
| `budgetUsage(spent, budget)` | `src/expenses.ts` | `(spent / budget) * 100` | `budget = 0` → `NaN` |
| `growthRate(current, previous)` | `src/reports.ts` | `((current - previous) / previous) * 100` | `previous = 0` → `NaN` |
| `dailyRate(totalSpent, days)` | `src/dates.ts` | `totalSpent / days` | `days = 0` → `NaN` |

---

## 2. Part 1 — Batch proving (4/4)

```bash
node live-demo/test-real-proving.mjs
```

The script builds a `BugProvingAgent` (fuzz budget 30, 2s timeout, 2 determinism
checks) and investigates each function against a spec whose postconditions require
a finite, non-`NaN` result. Actual output:

```
--- Test 1: splitExpense(amount, people=0) ---
  Certified: true   Input: [0,0]   Output: null   Violated: !isNaN(result)   Attempts: 1
--- Test 2: budgetUsage(spent, budget=0) ---
  Certified: true   Input: [0,0]   Output: null   Violated: !isNaN(result)   Attempts: 1
--- Test 3: growthRate(current, previous=0) ---
  Certified: true   Input: [0,0]   Output: null   Violated: !isNaN(result)   Attempts: 1
--- Test 4: dailyRate(totalSpent, days=0) ---
  Certified: true   Input: [0,0]   Output: null   Violated: !isNaN(result)   Attempts: 1

  RESULTS: 4/4 bugs proven autonomously
```

- **`Certified: true`** = the failure was verified by re-executing the function, not guessed.
- **`Output: null`** = the observed result was `NaN`, which serializes to `null` in JSON — that's the postcondition violation.
- **`Attempts: 1`** = the fuzzer hit the counterexample on the first mutation, because each of these divides directly by an argument that can be `0`.

---

## 3. Part 2 — Full pipeline on `splitExpense`

Then one function was run through the complete pipeline via the MCP tool:

```
buggy_investigate({
  function_id: "splitExpense",
  file_path: "live-demo/src/expenses.ts",
  preconditions:  ["input[0] >= 0"],
  postconditions: ["isFinite(result)", "!isNaN(result)"]
})
```

Actual result:

```
investigation_id: inv_1789449599262_lohi2zm
status:           confirmed_no_repair
proof:
  test_input:              [null]
  observed_output:         null            (NaN)
  violated_postcondition:  !isNaN(result)
  admissibility_verified_at: 2026-09-15T05:19:59.624Z
  soundness_verified_at:     2026-09-15T05:20:00.758Z
  uniqueness_verified_at:    2026-09-15T05:20:00.758Z
approved_patches: 0
rejected_patches: 3
```

**Pipeline timeline** (four agents, in order):

| Phase | Agent |
|---|---|
| parsing | `Parser_Agent` |
| proving | `Bug_Proving_Agent` |
| repair | `Repair_Agent` |
| classification | `Classifier_Agent` |

**Intermediate results:**

```
cst_nodes_parsed: 338   fuzz_mutations: 1   violations_found: 1
patches_generated: 3    patches_approved: 0   total_time_ms: 307
```

---

## 4. Reading the result: `confirmed_no_repair`

This is the important part of the demo. The status breaks into two independent facts:

1. **The bug is proven.** The proof-of-failure certificate passed all three checks — *admissibility* (the input satisfies the preconditions), *soundness* (re-executing on that input really does violate the postcondition), and *uniqueness*. `splitExpense(null, …)` returns `NaN`, violating `!isNaN(result)`.
2. **No fix was accepted.** The Repair_Agent generated 3 candidate patches; the Classifier_Agent screened each for overfitting and **rejected all 3**. Rather than auto-apply a patch it can't trust, Buggy hands back the proof.

So `confirmed_no_repair` = "here is a certified bug and its trigger — you fix it,
because I couldn't produce a fix I'm confident generalizes." A proven bug is always
a true positive; a rejected patch is not a failure, it's the overfit guard doing its job.

---

## 5. Why the two runs showed different triggers (`[0,0]` vs `[null]`)

Part 1 reported the trigger `[0,0]`; Part 2 reported `[null]`. Both are genuine —
they land on the same defect from different directions:

- `splitExpense(0, 0)` → `0 / 0` → `NaN`
- `splitExpense(null, undefined)` → `null / undefined` → `NaN` (and `null >= 0` is `true`, so it still satisfies the `input[0] >= 0` precondition)

The fuzzer generates inputs **stochastically**, so different runs can surface
different minimal counterexamples for the same root cause. The certification is
deterministic; the *path* to it is not.

---

## 6. The bugs, and how to fix them

Each is the same class — divide-by-zero producing `NaN`. Guard the denominator:

```ts
// src/expenses.ts
export function splitExpense(amount: number, people: number): number {
  if (people === 0) return 0;              // or throw — but never NaN
  return amount / people;
}
export function budgetUsage(spent: number, budget: number): number {
  if (budget === 0) return 0;
  return (spent / budget) * 100;
}
```
```ts
// src/reports.ts
export function growthRate(currentMonth: number, previousMonth: number): number {
  if (previousMonth === 0) return 0;
  return ((currentMonth - previousMonth) / previousMonth) * 100;
}
```
```ts
// src/dates.ts
export function dailyRate(totalSpent: number, days: number): number {
  if (days === 0) return 0;
  return totalSpent / days;
}
```

After guarding, re-running the investigation should flip each function to
`unconfirmed` (no violating input found within budget).

> This demo intentionally ships the **buggy** source so the run is reproducible.
> Apply the guards in your own copy to watch the statuses flip.

---

## 7. Reproduce it

```bash
# from the repo root, with dist/ built (npm run build)
node live-demo/test-real-proving.mjs           # Part 1: batch proving (4/4)
```

For Part 2, call the `buggy_investigate` MCP tool (or the CLI
`npx buggy investigate splitExpense --file live-demo/src/expenses.ts`) with the
same pre/postconditions shown in §3.

---

## 8. Summary of what happened

1. `test-real-proving.mjs` proved 4 real division-by-zero bugs — one per function — each on the first fuzz attempt. **4/4 certified.**
2. `splitExpense` was then taken end-to-end through Parse → Prove → Repair → Classify in ~307ms.
3. The bug was certified (admissibility + soundness + uniqueness), 3 repair candidates were generated, and **all 3 were rejected as overfit** → `confirmed_no_repair`.
4. Net: Buggy proved every bug it was pointed at, and declined to ship a fix it couldn't verify as genuine — no source files were modified.

---

## 9. How Buggy works, in plain English (flow chart)

```
   You point Buggy at a function and give it a rule
   (e.g. "the result must never be NaN / must never crash")
                          |
                          v
   [1] READ the code ................................ (Parse)
                          |
                          v
   [2] TRY TO BREAK the rule with many inputs ....... (Prove / fuzz)
                          |
             +------------+------------+
             |                         |
      nothing broke              something broke
             |                         |
             v                         v
   "No bug found"            [3] DOUBLE-CHECK by re-running
   (unconfirmed)                 the bad input to be sure
   = safe within budget          it's real ........... (Proof certificate)
                                       |
                                       v
                            [4] TRY TO WRITE A FIX ... (Repair)
                                       |
                                       v
                            [5] REJECT the fix if it's
                                just a cheap hack for
                                one input ............. (Overfit check)
                                       |
                          +------------+------------+
                          |                         |
                    fix is honest              no honest fix
                          |                         |
                          v                         v
              confirmed_and_repaired      confirmed_no_repair
              "Bug found, fix PROPOSED"   "Bug found, NO fix"
                          |                         |
                          v                         v
              [6] YOU DECIDE:             you get the exact
                  Buggy shows the diff        trigger and write
                  + overfitting score.        the guard yourself
                  It NEVER edits your
                  code on its own — you
                  apply it (or don't)
```

**In one breath:** you tell Buggy what "correct" means, it hammers the function
with inputs until it either gives up (no bug found) or breaks the rule. If it
breaks the rule, it re-runs the bad input to prove the failure is real, then tries
to fix it — but it throws away any fix that only band-aids that one input. Then it
hands you the result: either a **proposed** patch (with its overfitting score) or a
certified bug with the exact trigger. Either way, **you** make the final call.

In our demo, all four functions reached step 3 (proven), and `splitExpense` went
on through steps 4–5 where every fix was rejected → `confirmed_no_repair`.

### Who applies the fix? (there's always a human in the loop)

Buggy's engine is **read-only against your source** — `investigate` proves the bug
and *proposes* fixes, but it never writes to your files. How you see and decide on a
fix depends on how you run it:

| How you run it | What you get | Who applies |
|---|---|---|
| **CLI** `investigate --verbose` | Prints each approved patch: the diff + overfitting % | You, by hand |
| **API** `investigate()` | `report.approved_patches[].patch.diff` (+ `overfitting_probability`) | You, in your script |
| **MCP** `buggy_investigate` (Kiro) | Returns the `approved_patches`/`rejected_patches` arrays — diff, overfitting score, target file + line range | Kiro presents them and applies only the one you approve |

The only automation is the optional **`buggy-auto-fix` hook**. It now runs in
*present-and-ask* mode: after a task it surfaces any proven bug and its approved
fix (diff + overfitting score) and applies only the patch you choose. Disable the
hook if you don't want Buggy to even look automatically.

---

## 10. Does it work for Python apps? Yes — verified

Buggy is **language-aware for execution**. Bugs are proven by *running* the target
in its real runtime, so Python functions are executed in a real `python` process
(the `PythonExecutor`), and genuine Python exceptions — `ZeroDivisionError`,
`TypeError`, `ValueError`, etc. — are caught as proven failures.

**Live verification run in this session** (Python 3.14.2, two intentionally buggy
functions):

```
--- unit_price(total, quantity) ---
  status:   confirmed_no_repair
  trigger:  [0,0]
  violated: function must not throw: ZeroDivisionError: division by zero

--- average(values) ---
  status:   confirmed_no_repair
  trigger:  [[]]                     # empty list -> len()==0
  violated: function must not throw: ZeroDivisionError: division by zero
```

Both bugs were proven by executing real Python — exactly like the `split_payment`
Python bug in `examples/checkout-service`.

**Two honest caveats:**

1. **Proving works; deep CST parsing is optional.** `tree-sitter-python` is not
   bundled, so `buggy_analyze` on `.py` files falls back to the TypeScript grammar
   (its node counts/structure are unreliable for Python). Bug *proving* does not
   depend on this — it runs the actual interpreter. Install `tree-sitter-python`
   if you also want accurate Python CST analysis.
2. **Tell it the language.** Point Buggy at Python via `language: python` in
   `.debugger.yaml` (or the API/CLI), which routes execution to the Python runtime.
   The CLI also maps the `.py` extension to Python automatically.
