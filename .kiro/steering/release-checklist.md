# Change Checklist — README, Site, Push

Every change to this repository ships as a complete unit. Code alone is not done.

## The three obligations

For any change that adds, removes or alters behaviour:

1. **Update `README.md`** — it is the source of truth for how Buggy is used.
2. **Update `site/`** — the public page must not describe a version that no longer exists.
3. **Verify, commit, push** — and confirm the Pages deploy went green.

Skip 1 and 2 only for changes with no user-visible effect: internal refactors
that alter no behaviour, comment-only edits, or test-only additions that do not
change a documented count.

## 1. README

Update whichever of these the change touches:

- **CLI Reference** — a new command, flag, or changed output needs its own entry
  with a worked example, matching the style of the existing entries.
- **Programmatic API** — new `ProofDebugger` methods belong in the example block.
- **MCP tools** — the tool list and anything describing how many there are.
- **Configuration Reference** — new `.debugger.yaml` keys, with their defaults.
- **Architecture Overview / Learning Across Runs** — new subsystems.
- **What runs today** — if a module moves from library-only into the live
  pipeline, move it across. This section is the project's credibility; an
  inaccurate claim here is worse than no claim.

## 2. Site

The page lives in `site/` and has **no build step** — edit the files directly.

Things that go stale silently and must be checked on every change:

| What | Where |
|---|---|
| Stat counters | `data-to` attributes on `.count` in `site/index.html` |
| MCP tool list | the `.tabs__note` paragraph under the MCP tab |
| Pipeline / proof / classifier copy | the matching `<section>` |
| "What runs today" split | the `#status` section — must agree with the README |
| Social card text | `site/assets/og-card.html`, then re-render `og.png` |

Current counters, for reference: pipeline phases, proof pillars, classifier
dimensions, MCP tool count, total tests. **The test count changes whenever tests
are added** — read it off the actual run, never guess.

Preview before pushing:

```bash
npx serve site
```

## 3. Verify, then push

In order, and do not skip ahead on a failure:

```bash
npm run build          # tsc must be clean
npx vitest run         # all tests must pass; note the new total
git add <specific files>
git commit
git push origin <current-branch>
```

Then confirm the deploy:

```
https://github.com/himanshusaini-afk/buggy/actions
```

A push that touches `site/**` triggers the Pages workflow. A push that does
**not** touch `site/**` will not deploy — so if the site needed updating and the
workflow did not run, the site change was missed.

## Rules

- **Never push to `main` without being asked.** Work lands on the current
  feature branch. `main` is 20+ commits behind by design.
- **Stage specific files**, not `git add -A`. This repo generates artefacts
  (`.debugger/`, screenshots, temp dirs) that must not be committed.
- **Commit messages explain why**, not what. The diff shows what changed; the
  message should say what was broken or missing and why this is the fix.
- **Report the real test count** after a change. If a test fails, say which and
  why rather than re-running until it passes.
- **Clean up verification artefacts** (temp projects, screenshots, scratch
  scripts) before committing.

## Accuracy over polish

Both the README and the site currently distinguish what is wired into the live
pipeline from what exists as library code. Preserve that distinction. If a
change makes a claim true, update the claim; if it does not, do not imply it
does. `docs/MARKETING.md` is aspirational and overstates the current state —
do not copy claims from it into the README or the site.
