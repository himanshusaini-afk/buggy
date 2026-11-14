# Buggy - Proof-Carrying Debugging Workflow

Buggy finds a real failing input by executing the function, then verifies it
three ways. A finding is evidence, not a warning.

## When to Use

- A user asks to "check for bugs", "find issues", or "debug" a Python function
- You are about to modify existing code (check it first)
- A test is failing and you need to understand why
- Review turns up a risky pattern: division, indexing, unbounded arithmetic

## Before you execute anything

`buggy_investigate`, `buggy_scan`, `buggy_repair` and `buggy_recheck` **import
the target module**, which runs its top-level code. Investigating an instance
method also constructs the receiver using generated arguments. If a module
opens a database connection, calls an API, or writes a file at import time,
that really happens.

`buggy_functions` and `buggy_recall` only read, and are always safe.

So on unfamiliar code: inventory first, then execute deliberately.

## How to Use (via MCP tools)

### Step 1: See what is in the file - no execution

```
buggy_functions({ file: "src/pricing.py" })
```

Returns each function, its signature, and whether it can be investigated. Call
this first when you do not know what is in a file, or when a function turns out
not to be investigable and you need the reason.

### Step 2: Check what is already known - no execution

```
buggy_recall({ function: "apply_discount" })
```

Omit `function` to list everything recorded. Each finding carries `status`,
`broke` (the violated rule), `reproduce` (the exact runnable call), and
`times_seen`. A `regressed` status means a defect that was observed fixed is
failing again - always surface that.

### Step 3: Investigate one function

```
buggy_investigate({
  function: "apply_discount",
  file: "src/pricing.py",
  preconditions: ["price >= 0", "percent_off >= 0"],
  postconditions: ["result >= 0", "math.isfinite(result)"]
})
```

Use `Cart.total` to reach a method. Pass `receiver` to control how the object
is built, for example `"Cart([1, 2])"`; it is inferred from `__init__` when
omitted. Pass `record: true` only when the user wants the defect stored in
`.buggy/findings.db` for later `buggy_recheck`.

### Step 4: Propose a fix

```
buggy_repair({ function: "apply_discount", file: "src/pricing.py" })
```

Each candidate patch is verified by execution and carries a verdict:

- `verified` - fixes the proven trigger, breaks none of the inputs that worked,
  and generalises to similar inputs
- `overfit` - fixes only the exact trigger
- `rejected` - does not parse, or breaks working inputs

There is **no numeric overfitting score**. Report the verdict and its evidence.
Nothing is ever written to the file: show the diff, let the user decide, and
apply it with `str_replace` only if they agree.

### Step 5: Interpret the status honestly

| status | what it means |
|---|---|
| `proven` | a failing input survived all three checks; reproducible by hand |
| `unconfirmed` | the function ran and nothing failed. **Not** a proof of safety |
| `no_valid_input` | preconditions rejected every candidate, so it never ran. Nothing was learned |
| `skipped` | it could not be analysed or called; the reason is in the response |

Never report `unconfirmed` as "no bugs". Say no failing input was found within
the budget, and offer stronger postconditions.

`no_valid_input` is the one to act on: the specification was too tight, so
loosen a precondition and try again.

## Writing Good Specifications

Conditions are **Python expressions**. Parameter names are in scope;
postconditions also see `result`. The `math` module and common builtins (`len`,
`abs`, `min`, `max`, `sum`, `all`, `any`, `isinstance`, `sorted`) are available.
JavaScript syntax is reported as an error, not silently ignored.

Infer specifications from the code:

- a return annotation implies a postcondition about `result`
- parameter guards already in the body (`if x <= 0: raise`) imply preconditions
- a docstring documenting a raise implies an expected exception
- a documented invariant implies a postcondition

Common patterns:

| code shape | add |
|---|---|
| division | pre `denominator != 0`, post `math.isfinite(result)` |
| indexing | pre `0 <= index < len(items)` |
| money or prices | post `result >= 0` |
| string operations | post `result is not None` |
| averages over a collection | pre `len(values) > 0` |

Two things Buggy deliberately does not report, so do not add specifications
that fight them: a non-finite result from non-finite arguments is IEEE 754
working as designed, and `TypeError` from passing `None` is the caller's
mistake and is ranked last.

## Explaining Results to Users

- Lead with the IMPACT: "this can return a negative price when..."
- Show the TRIGGER verbatim from `reproduce`, because the user can paste and run it
- Explain the FIX: "the verified patch clamps percent_off to [0, 100]"
- State the EVIDENCE for the verdict: "fixes the trigger, 37 working inputs
  unchanged, 2 of 2 similar inputs also fixed"

## After a fix

Call `buggy_investigate` on the function again to confirm the failure is gone.
If the defect was recorded, `buggy_recheck` re-runs every stored trigger and
reports what is still failing, now fixed, regressed, or unreachable.
