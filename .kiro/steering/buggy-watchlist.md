---
inclusion: auto
---

# Buggy - Project Memory

Before editing a function that looks risky, check whether a defect has already
been proven against it in this project.

```
buggy_recall({ function: "apply_discount" })
```

Omit `function` to list everything on record. The call only reads
`.buggy/findings.db` and never executes project code, so it is safe to use
freely.

Prefer this over any written-down list of lessons. Each entry is backed by a
stored trigger that can be re-run on demand with `buggy_recheck`, so the
answer reflects the code as it is now rather than what was true when someone
last updated a document.

A `regressed` status is the one to act on: that defect was observed fixed and
is failing again.

If `.buggy/` does not exist, nothing has been recorded yet. Recording is
opt-in - pass `record: true` to `buggy_investigate` to start.
