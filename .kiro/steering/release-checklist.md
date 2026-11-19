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

- **Commands** — a new command, flag, or changed output needs its own entry with
  a worked example, matching the style of the existing ones.
- **Programmatic** — new public functions belong in the example block.
- **MCP tools** — the tool list and anything stating how many there are.
- **What is checked** — a new oracle, or a change to the ranking rules.
- **What exists today** — this section is the project's credibility. If a change
  makes a claim true, move it across; if it does not, do not imply it does. An
  inaccurate claim here is worse than no claim.
- **Install** — anything affecting the venv, the symlinks, or the MCP config.

## 2. Site

The page lives in `site/` and has **no build step** — edit the files directly.

Things that go stale silently and must be checked on every change:

| What | Where |
|---|---|
| Stat counters | `data-to` attributes on `.count` in `site/index.html` |
| MCP tool list | the `.tabs__note` paragraph under the MCP tab |
| Pipeline / proof / repair copy | the matching `<section>` |
| "What runs today" split | the `#status` section — must agree with the README |
| Social card text | `site/assets/og-card.html`, then re-render `og.png` |

The counters are: oracles, proof pillars, CLI commands, MCP tools, total tests.
**The test count changes whenever tests are added** — read it off the actual run,
never guess.

`main.js` holds the hero transcript as a hardcoded token list, so changed CLI
output means editing that too, not just the HTML. The accessible transcript is a
separate copy in `index.html` under `.sr-only` and has to match.

Removing a section is safe: every block in `main.js` begins with a
`if (!el) return;` guard. Delete the dead block as well rather than leaving it.

Re-render the social card with headless Chrome:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --force-device-scale-factor=1 \
  --screenshot=site/assets/og.png --window-size=1200,630 \
  "file://$(pwd)/site/assets/og-card.html"
```

Preview before pushing:

```bash
python3 -m http.server 8080 --directory site
```

## 3. Verify, then land it on `main`

`main` is the branch the world gets: it is the GitHub default, so it is what a
`git clone` and a `pip install git+https://...` resolve to, and it is what
anyone arriving from the website pulls. **Keep it current.**

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

```bash
python3 -m unittest discover -s tests -t .
```

That is the whole suite, and it needs nothing but Python. Report the real total
off the run; never guess it.

Five tests in `tests/test_prove.py` compare against the recorded TypeScript run
in `examples/expense-api/logs/investigations.jsonl` and **skip** with a stated
reason if that directory is missing. A sudden jump in the skip count means a
path broke, not that the tests passed - check it rather than accepting the OK.

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

Both the README and the site separate what works from what is deliberately
absent. Preserve that split. If a change makes a claim true, update the claim;
if it does not, do not imply it does.

Three claims in particular are load-bearing and must not drift:

- **`unconfirmed` is not "no bugs".** It means nothing failed within the budget.
- **A patch verdict is evidence, not a score.** There is no probability and no
  threshold; say what happened when the patch ran.
- **Your code is really executed.** Never describe the child process as a
  sandbox. There is no filesystem, network or syscall restriction.

The TypeScript implementation this project started as was removed; it is
preserved at the `ts-final` tag. Do not reintroduce its vocabulary - no
overfitting scores, no classifier dimensions, no Watchlist tiers, no
`.debugger.yaml`, and no `confirmed_and_repaired` status.
