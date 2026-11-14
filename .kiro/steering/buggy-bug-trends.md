---
inclusion: auto
name: buggy-bug-trends
description: Reading recorded defect history from .buggy/findings.db and acting on regressions. Use when asked which bugs are known in this project, whether a fix held, what keeps breaking or regressing, or for a defect summary or bug report.
---

# Buggy - Defect History and Trends

The project's defect history is a database, not a document. `.buggy/findings.db`
holds every recorded defect with a trigger that can be re-run. Read it rather
than maintaining a parallel markdown tally that drifts out of date.

## Recording

Nothing is recorded unless asked. Pass `record: true` to `buggy_investigate`
when the user wants a proven defect kept:

```
buggy_investigate({
  function: "apply_discount",
  file: "src/pricing.py",
  postconditions: ["result >= 0"],
  record: true
})
```

Record a defect when it is worth re-checking later - a real bug in code that
will be edited again. Do not record exploratory findings, and do not record on
a hook that fires automatically.

## Reading the history

```
buggy_recall({})     # every recorded defect, no execution
buggy_recheck({})    # re-runs every stored trigger - this DOES execute code
```

`buggy_recall` returns `known`, a `regressed` count, and a `findings` list
where each entry carries `status`, `broke`, `reproduce`, `times_seen`,
`first_seen` and `last_seen`.

`buggy_recheck` returns `checked`, `regressions`, and per-finding `outcome`:

| outcome | meaning |
|---|---|
| `still_failing` | the trigger fires exactly as before |
| `fixed` | the trigger no longer fails |
| `regressed` | it was observed fixed and is failing again |
| `unreachable` | the function or file moved, so the trigger no longer applies |

## The only trend that matters

**Regressions.** Everything else is bookkeeping. A `regressed` finding is a
defect someone already fixed once, which means the fix did not hold or was
reverted. Surface it immediately and by name, with its `reproduce` call.

`buggy_recheck` exits non-zero when anything regressed, so it works unchanged
as a CI step.

## Writing a report, when asked

Only when the user asks for one. Derive every number from `buggy_recall` or
`buggy_recheck` output - never from memory of this session:

```markdown
# Defect History

Generated: [timestamp]   Source: .buggy/findings.db

| status | count |
|---|---|
| open | X |
| fixed | Y |
| regressed | Z |
| unreachable | W |

## Regressed - act on these first

### apply_discount (src/pricing.py)
- Broke: result >= 0
- Reproduce: apply_discount(100, 150)
- Seen 3 times, first 2026-01-04, last 2026-03-11

## By file

| file | open | fixed | regressed |
|---|---|---|---|
| src/pricing.py | 1 | 2 | 1 |
```

## Rules

1. Only recorded, proven defects appear. Never speculative issues
2. Never write `fixed` yourself - that status is set by a `buggy_recheck`
   observation, not by applying a patch
3. `unconfirmed` is not a data point. It means nothing failed within the
   budget, so it says nothing about correctness
4. Quote `reproduce` exactly; its value is that it runs
5. If `.buggy/` does not exist, there is no history. Say that rather than
   producing an empty report
