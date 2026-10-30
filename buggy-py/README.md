# buggy (Python)

Finds a real failing input for a Python function by executing it, verifies the
failure three ways, and hands you a certificate naming the exact call that
breaks it.

```
$ buggy investigate budget_usage -f budget.py --post 'math.isfinite(result)'

  budget_usage  (budget.py)
  ----------------------------------------------------------------------
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
[What exists today](#what-exists-today) - that section is the project's
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
(`len`, `abs`, `min`, `max`, `sum`, `all`, `any`, `isinstance`, `sorted`, ...) are
available.

```bash
buggy investigate apply_discount -f pricing.py \
  --pre  'math.isfinite(price) and price >= 0' \
  --pre  'percent_off >= 0' \
  --post 'result >= 0'
```

A condition that cannot be evaluated is **reported, never skipped silently**:

```
  ! postcondition not checked: !isNaN(result)
      not a Python expression (invalid syntax) - looks like JavaScript:
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
| `buggy repair <name> -f <file>` | investigates, then proposes fixes and verifies each by execution |
| `buggy scan <file>` | investigates every supported function in a file |

Useful flags: `--pre` / `--post` (repeatable), `--budget N` (inputs to execute,
default 300), `--timeout S` (per call, default 2), `--determinism N`,
`--json`, `--python PATH`.

### Methods

A qualified name reaches a class member: `buggy investigate Cart.total -f cart.py`.

Instance methods need an object to be called on. One is built from the class's
own `__init__` signature, trying candidate arguments until one constructs, and
**rebuilt fresh for every call** so state written by an earlier call cannot
change a later one. The certificate records the construction, because
`total(0)` is not something you can paste into a REPL and `Cart([1, 2]).total(0)`
is:

```
    built on    Cart([])  (rebuilt for every call)
    input       []
    broke       must not raise ZeroDivisionError

  Call it yourself to see it fail:
    Cart([]).average_price()
```

A method's real input is the pair *(how the object was built, what it was called
with)*, and both are searched. `Cart.average_price` takes no arguments at all;
its defect lives entirely in `Cart([])`, so varying only method arguments would
report it clean.

For the same reason, **preconditions can constrain constructor parameters** by
name:

```bash
buggy investigate Basket.scaled -f basket.py \
  --pre 'isinstance(items, list) and all(isinstance(v, float) for v in items)' \
  --pre 'math.isfinite(factor)'
```

Here `items` comes from `Basket.__init__` and `factor` from the method. On a name
clash the method's parameter wins.

When `__init__` takes only `*args`, or rejects everything tried, pass a receiver
yourself:

```bash
buggy investigate Session.retry -f session.py --receiver 'Session("localhost", 8080)'
```

A failure inside `__init__` is reported as a setup problem, never as a defect in
the method under test.

Still out of reach, each refused with a reason rather than silently reported
clean: special methods (`__init__`, `__add__`, ...), properties, `async` functions,
and functions nested inside other functions. On the stdlib's `statistics`
module, 54 of 81 functions are investigable.

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

### Repair

`buggy repair` proposes fixes for a proven failure and then **tests** each one.

```
  VERIFIED  return 0.0 when budget == 0
      guards the proven trigger (budget zero)
      fixes the trigger, 37 working inputs unchanged, 2/2 similar inputs also fixed
            BUG: `budget == 0` raises ZeroDivisionError.
            """
      +     if budget == 0:
      +         return 0.0
            return (spent / budget) * 100
```

Every candidate has to earn its verdict against four questions, which is
affordable because a call costs ~0.015 ms:

1. **Does it parse?** A patch that breaks the file is discarded.
2. **Does it fix the proven trigger?** The exact input from the certificate is
   re-run. The test is that the *proven* failure is gone, not that nothing is
   raised, so converting a `ZeroDivisionError` into a documented `ValueError`
   counts as a fix.
3. **Does it break anything that worked?** Every input the original handled
   correctly is re-run, and a changed result is a regression. "Handled
   correctly" excludes inputs that returned a value violating a stated
   postcondition, and inputs your preconditions exclude: a patch must not be
   blamed for changing behaviour on a call you said would never happen.
4. **Does it generalise?** Inputs sharing the trigger's shape (the same zero
   denominator with different numerators, other empty collections) are
   generated, screened to keep only those that fail the same way in the
   original, and must be handled too.

Question 4 is the honest overfitting check. A patch that special-cases the one
input that caught it passes 1-3 and fails here, on evidence rather than on a
coefficient. The verdicts are `verified`, `overfit` and `rejected`, each shown
with the reason:

```
  REJECTED  always return 0.0
      changes behaviour on [5, 2]: was ok:2.5, now ok:0.0 (37 of 38 inputs affected)

  OVERFIT   special-case exactly the triggering input
      only handles the exact input that caught it (0 of 4 similar inputs fixed)
```

The strategies are driven by the certificate, not by pattern-matching the
source: an early-return guard, a `raise`, a clamp for a magnitude problem such
as a discount above 100%, and a `None` substitution. For an instance method the
guard reaches through `self`.

**Nothing is ever written to your file.** Patches are returned as data.

## What "proven" means

There is no solver and no symbolic reasoning. A certificate is a record of
observed failure, and it is worth being precise about what that buys you:

- the input was **executed**, not inferred
- it satisfied every stated **precondition** (admissibility)
- the failure was **observed again** in a fresh process (soundness)
- it **recurred** in at least 2 of 3 further attempts (reproducibility)

So a proven finding is a true positive you can reproduce by hand. The other
statuses are kept distinct on purpose:

| status | meaning |
|---|---|
| `proven` | a failing input survived all three pillars |
| `unconfirmed` | the function ran and nothing failed. **Not** a proof of safety |
| `no_valid_input` | the preconditions rejected every candidate, so the function never ran. Nothing was learned |
| `skipped` | it could not be analysed or called at all; the reason is given |

`no_valid_input` exists because collapsing it into `unconfirmed` would present
an absence of evidence as evidence of absence. It was found by running this
against the stdlib: `statistics.fmean` under a reasonable precondition executed
zero inputs and still claimed nothing was wrong.

## What is checked

Five oracles, in this order. Your own postconditions are checked before the
built-in numeric ones, so a broken rule is reported in your words.

1. **timeout** - the call did not finish
2. **crash** - it raised, and the exception is the function's fault
3. **postcondition** - it returned a value you said was impossible
4. **non-finite** - it returned NaN or an infinity *from finite arguments*
5. **nondeterminism** - the same input gave different answers (`--determinism N`)

Two rankings keep the signal usable, because the easiest failures to trigger are
usually the least interesting:

**Propagation is not a defect.** `monthly(nan) -> nan` is IEEE 754 working, not a
bug. A non-finite result is only reported when the arguments were all finite, so
`ratio(0, 0) -> nan` is a finding and `monthly(nan)` is not. Without this, every
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
`SyntaxError`, was swallowed, and the investigation reported "no bug found" -
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
- instance methods, with a receiver constructed from `__init__`, rebuilt per
  call, overridable with `--receiver`, and recorded in the certificate;
  constructor arguments are searched and can be constrained by preconditions
- the Python specification language, with a restricted evaluator and the
  three-way verdict (holds / broken / cannot be evaluated)
- the persistent worker: reused process, protocol isolated from the target's
  stdout, timeout with kill-and-respawn, `RLIMIT_CPU` and `RLIMIT_FSIZE`
- annotation-driven input generation with Python's hazards, and the one-hot /
  all-edge / random schedule for wide signatures
- the five oracles, with propagation and type-confusion ranking
- three-pillar verification and certificates
- repair: certificate-driven patch strategies, each verified by execution
  against the four questions above, with regression and overfitting detection
  grounded in observed behaviour rather than a score
- the `functions`, `investigate`, `repair` and `scan` commands, with `--json`

Not written yet, and not implied anywhere in the output:

- **persistence** - nothing is written to disk. No graph database, no watchlist,
  no retrospective, no capability advisor.
- **MCP server** - not started.
- **async functions** - refused with a reason; the worker has no event loop.
- **special methods** - `__init__`, `__add__` and the rest are refused; their
  calling conventions vary too much to guess at.
- **defects that need several calls on one object** - a receiver is rebuilt for
  every call, which is what makes reproducibility sound, but it means a leak or
  a corruption that only appears on the third call is invisible.
- **a hard memory cap** - requested and *reported*, not assumed. `RLIMIT_AS`
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

140 tests, all passing, about 15 seconds. `tests/test_prove.py` includes the
parity baseline against the recorded TypeScript run and is skipped if the
example sources are absent. `tests/test_repair.py` injects a deliberately
sabotaged patch and a deliberately overfit one, to check that the evidence
actually rejects them.

## License

MIT
