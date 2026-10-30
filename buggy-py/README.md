# buggy (Python)

Finds a real failing input for a Python function by executing it, verifies the
failure three ways, and hands you a certificate naming the exact call that
breaks it.

```
$ buggy investigate budget_usage -f budget.py --post 'math.isfinite(result)'

  budget_usage  (budget.py)
  ──────────────────────────────────────────────────────────────────────
  status      proven

  Certificate of failure
    input       [0, 0]
    broke       must not raise ZeroDivisionError
    detail      ZeroDivisionError: division by zero
    reproduced  3/3

  Call it yourself to see it fail:
    budget_usage(0, 0)
```

A native Python reimplementation of the TypeScript original, which lives in the
parent directory. It is not a port of that codebase; it is a rewrite of the
third of it that runs, for reasons set out in [Why a rewrite](#why-a-rewrite).

**Status: early.** The prove half works end to end and is tested. Repair,
classification, persistence and the MCP server are not written yet. See
[What exists today](#what-exists-today) — that section is the project's
credibility and is kept honest.

## Install

No dependencies, and none planned for the core. Python 3.10 or newer.

```bash
pip install -e .          # from this directory
```

Or run it without installing:

```bash
PYTHONPATH=. python3 -m buggy.cli --help
```

The lack of dependencies is deliberate. The tool inspects your project, so it
must not be able to disturb your project's environment, and it should install on
a new Python release without waiting for anyone's wheels.

## Use

### Specifications are Python

Conditions are Python expressions. Your parameter names are in scope, and
postconditions also see `result`. The `math` module and the common builtins
(`len`, `abs`, `min`, `max`, `sum`, `all`, `any`, `isinstance`, `sorted`, …) are
available.

```bash
buggy investigate apply_discount -f pricing.py \
  --pre  'math.isfinite(price) and price >= 0' \
  --pre  'percent_off >= 0' \
  --post 'result >= 0'
```

A condition that cannot be evaluated is **reported, never skipped silently**:

```
  ⚠ postcondition not checked: !isNaN(result)
      not a Python expression (invalid syntax) — looks like JavaScript:
      use 'not x' instead of !x
```

Conditions run with no builtins and a restricted namespace. Lambdas, imports,
assignment expressions, dunder access and arbitrary attribute access are
rejected at compile time, so a specification cannot reach the filesystem or the
interpreter internals.

### Commands

| Command | What it does |
|---|---|
| `buggy functions <file>` | lists functions, their signatures, and which are investigable |
| `buggy investigate <name> -f <file>` | investigates one function |
| `buggy scan <file>` | investigates every supported function in a file |

Useful flags: `--pre` / `--post` (repeatable), `--budget N` (inputs to execute,
default 300), `--timeout S` (per call, default 2), `--determinism N`,
`--json`, `--python PATH`.

A qualified name works for class members: `buggy investigate Cart.total -f cart.py`.

### Programmatic

```python
from buggy.prove import Config, investigate

report = investigate(
    "budget.py", "budget_usage",
    preconditions=["budget >= 0"],
    postconditions=["result >= 0"],
    config=Config(max_executions=500, timeout=1.0),
)

if report.status == "proven":
    cert = report.certificate
    print(f"{cert.function}{tuple(cert.args)} broke {cert.rule}")

for warning in report.warnings:       # specifications that did not run
    print(warning.condition, warning.reason)
```

`investigate_file` investigates a whole module while reusing one worker.

## What "proven" means

There is no solver and no symbolic reasoning. A certificate is a record of
observed failure, and it is worth being precise about what that buys you:

- the input was **executed**, not inferred
- it satisfied every stated **precondition** (admissibility)
- the failure was **observed again** in a fresh process (soundness)
- it **recurred** in at least 2 of 3 further attempts (reproducibility)

So a proven finding is a true positive you can reproduce by hand. `unconfirmed`
means no failing input was found within the budget. It is **not** a proof of
safety, and the tool says so every time it reports one.

## What is checked

Five oracles, in this order. Your own postconditions are checked before the
built-in numeric ones, so a broken rule is reported in your words.

1. **timeout** — the call did not finish
2. **crash** — it raised, and the exception is the function's fault
3. **postcondition** — it returned a value you said was impossible
4. **non-finite** — it returned NaN or an infinity *from finite arguments*
5. **nondeterminism** — the same input gave different answers (`--determinism N`)

Two rankings keep the signal usable, because the easiest failures to trigger are
usually the least interesting:

**Propagation is not a defect.** `monthly(nan) → nan` is IEEE 754 working, not a
bug. A non-finite result is only reported when the arguments were all finite, so
`ratio(0, 0) → nan` is a finding and `monthly(nan)` is not. Without this, every
unguarded arithmetic function in a codebase gets flagged the moment the fuzzer
tries NaN.

**Type confusion is ranked last.** `divide(None, None)` raises `TypeError`, which
is trivial to trigger and is the caller's mistake. Such a finding is remembered
but the search continues, so `divide` is reported at `(x, 0)` with
`ZeroDivisionError` rather than at `(None, None)`. If type confusion is the only
failure found it is still reported, with advice to constrain the parameter types.

## Why a rewrite

The TypeScript tool in the parent directory already executes Python: it ships a
`PythonExecutor`, a `tree-sitter-python` grammar, Python-aware signature
extraction, and a complete Python repair dialect. The problems were narrower and
worse than "it has no Python support".

**Specifications were evaluated as JavaScript, whatever the target language.**
`spec-conditions.ts` compiled conditions with `new Function`, and all three call
sites caught the failure and continued. So a Python condition raised a JavaScript
`SyntaxError`, was swallowed, and the investigation reported "no bug found" —
indistinguishable from genuine safety. The parent repo's own example runner
documents the workaround: *"Both are JavaScript expressions even for Python
targets."* Here, conditions are Python and an unevaluable one is a warning.

**Execution cost made it unusable at size.** The original wrote four temp files
and spawned a fresh interpreter per input. Measured on this machine:

| approach | ms per execution |
|---|---|
| four temp files + fresh interpreter | 34.9 |
| persistent worker (this package) | 0.015 |

The committed example logs show the consequence: 494 seconds to investigate
seven trivial functions, with single functions taking 173 seconds.

**Three things are simpler in Python, not merely different.** `ast` replaces a
native grammar that could be configured into the wrong language and silently
fall back to parsing Python as TypeScript. `json` carries `NaN`, `Infinity`,
`-0.0` and big integers between two Python processes losslessly, so the
original's sentinel-encoding scheme is unnecessary in both directions. And the
~250-line regex TypeScript stripper has nothing to strip.

### Measured against the recorded run

`../examples/expense-api/logs/investigations.jsonl` records a real TypeScript run
over the same seven functions. Same files, conditions translated to Python:

| | TypeScript (recorded) | this package |
|---|---|---|
| defects proven | 3 of 7 | **4 of 7** |
| wall clock | 494 s | **0.4 s** |

The extra defect is `apply_discount`, where a discount above 100% returns a
negative price. It is real and documented in the example's own `WORKFLOW.md`;
the recorded run missed it for want of an input above 100. `tests/test_prove.py`
keeps those statuses as a regression baseline.

## What exists today

Wired into the live pipeline and tested:

- `ast`-based function discovery and signature recovery, including qualified
  names for class members, positional-only and keyword-only parameters,
  variadics excluded from arity, and `self`/`cls` correctly not counted
- the Python specification language, with a restricted evaluator and the
  three-way verdict (holds / broken / cannot be evaluated)
- the persistent worker: reused process, protocol isolated from the target's
  stdout, timeout with kill-and-respawn, `RLIMIT_CPU` and `RLIMIT_FSIZE`
- annotation-driven input generation with Python's hazards, and the one-hot /
  all-edge / random schedule for wide signatures
- the five oracles, with propagation and type-confusion ranking
- three-pillar verification and certificates
- the `functions`, `investigate` and `scan` commands, with `--json`

Not written yet, and not implied anywhere in the output:

- **repair** — no patch generation. The original's `pythonDialect` is a good
  starting point; its classifier is not (see below).
- **classification** — deliberately deferred. In the parent repo's recorded
  runs, the classifier rejected **all 21** generated patches across both
  languages, scoring the correct `if people == 0: return 0.0` guard at 93%
  likely-overfit. Scores occupied `[0.86, 0.99]` against a 0.5 threshold, so
  `confirmed_and_repaired` was unreachable. The scaling needs fixing before the
  formula is worth porting.
- **persistence** — nothing is written to disk. No graph database, no watchlist,
  no retrospective, no capability advisor.
- **MCP server** — not started.
- **instance methods** — refused with a reason, because calling one needs a
  constructed receiver. `staticmethod` and `classmethod` work.
- **async functions** — refused with a reason; the worker has no event loop.
- **a hard memory cap** — requested and *reported*, not assumed. `RLIMIT_AS`
  cannot be lowered on macOS (`setrlimit` raises), so `Executor.limits` tells
  you what the OS actually accepted rather than claiming a limit that is not
  there. `RLIMIT_CPU` does work, and is what stops a runaway loop.

Isolation today is a separate process with a CPU cap, a file-size cap, and
kill-on-timeout. There is no filesystem, network or syscall restriction. Do not
point this at code you would not run.

## Tests

```bash
python3 -m unittest discover -s tests -t .    # no installs needed
# or
pytest
```

104 tests, all passing, about 10 seconds. `tests/test_prove.py` includes the
parity baseline against the recorded TypeScript run and is skipped if the
example sources are absent.

## License

MIT
