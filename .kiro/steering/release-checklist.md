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

## 3. Verify, then land it on `main`

`main` is the branch the world gets: it is the GitHub default, so it is what a
`git clone` and an `npm install github:...` resolve to, and it is what anyone
arriving from the website pulls. **Keep it current.**

### The branch cycle

Every change, however small, follows this:

```bash
git checkout main && git pull origin main
git checkout -b <short-descriptive-name>
# ... do the work, verify it, commit it ...
git push origin <branch>                  # optional, for a reviewable history
```

Then land it and clean up:

```bash
git checkout main
git merge --ff-only <branch>              # fast-forward; no merge commits
git push origin main
git branch -d <branch>                    # delete locally
git push origin --delete <branch>         # and on the remote, if pushed
```

`--ff-only` is deliberate. If it refuses, `main` has moved and the branch needs
rebasing onto it first (`git rebase main`). That keeps the history linear and
makes "what shipped" readable.

### Verify before the merge, not after

In order, and do not skip ahead on a failure:

```bash
npm run build                                     # tsc must be clean
npx vitest run                                    # note the new total
cd buggy-py && python3 -m unittest discover -s tests -t .
```

Both suites matter and they are independent. The Python package has no Node
dependency, so a machine without `node` can still verify `buggy-py` in full —
say which suite you ran and which you could not, rather than implying both
passed.

### Then confirm the deploy

```
https://github.com/himanshusaini-afk/buggy/actions
```

The Pages workflow fires on a push to `main` that touches `site/**`. Because
the site now publishes from `main` only, **the deploy happens at the merge**,
not when you push the feature branch. If the site needed updating and no
workflow ran after the merge, the site change was missed.

## Rules

- **Land work on `main` and delete the branch.** Short-lived branches, linear
  history, `main` always current. Never force-push `main`, and never merge work
  whose verification did not pass.
- **Stage specific files**, not `git add -A`. This repo generates artefacts
  (`.debugger/`, `.buggy/`, screenshots, temp dirs) that must not be committed.
  `.kiro/settings/` is git-ignored because it holds machine-specific paths.
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
