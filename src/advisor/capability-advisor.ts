/**
 * Capability Advisor — proposes new hooks, steering rules and skills from
 * evidence the project has already produced.
 *
 * The Watchlist records defects and the Retrospective says whether fixes held.
 * Neither closes the loop: when the same defect class keeps reappearing in the
 * same files, the useful response is not another patch but a new guardrail —
 * a hook that fires earlier, or a steering rule that teaches the agent the
 * pattern before it writes the bug again.
 *
 * Every proposal here is derived from observed episodes, never from a static
 * checklist, and carries the evidence that motivated it. Each one also carries
 * finished file content, so accepting a proposal is a write rather than a
 * design exercise.
 *
 * Nothing is written during {@link CapabilityAdvisor.advise}. Writing is a
 * separate, explicit {@link CapabilityAdvisor.apply} call, and it refuses to
 * clobber an existing file.
 *
 * @module advisor/capability-advisor
 */

import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { Retrospective } from '../watchlist/retrospective.js';
import { selectDialect } from '../agents/repair-dialects.js';
import type {
  CapabilityAdvice,
  CapabilityApplyResult,
  CapabilitySuggestion,
  ProjectSignals,
  RetrospectiveReport,
} from '../types/advisor.js';

export interface CapabilityAdvisorOptions {
  projectRoot: string;
  /** Configured project language; selects file globs and patch syntax. */
  language?: string;
}

/** A file is a hotspot worth its own scan hook at this many proven defects. */
const HOTSPOT_DEFECT_THRESHOLD = 3;

/** Verified episodes needed before a pre-commit gate is worth proposing. */
const PRECOMMIT_EVIDENCE_THRESHOLD = 3;

export class CapabilityAdvisor {
  private readonly db: Database.Database;
  private readonly projectRoot: string;
  private readonly language: string;

  constructor(db: Database.Database, options: CapabilityAdvisorOptions) {
    this.db = db;
    this.projectRoot = options.projectRoot;
    this.language = (options.language ?? 'typescript').toLowerCase();
  }

  /**
   * Analyse the project and return ranked proposals.
   *
   * @param retrospective - Pre-computed report, to avoid analysing twice when
   *                        the caller already has one.
   */
  advise(retrospective?: RetrospectiveReport): CapabilityAdvice {
    const report = retrospective ?? new Retrospective(this.db).analyse();
    const signals = this.gatherSignals(report);

    const skipped: CapabilityAdvice['skipped'] = [];
    const suggestions: CapabilitySuggestion[] = [];

    for (const produced of this.generateAll(signals)) {
      if (this.alreadyPresent(produced)) {
        skipped.push({ id: produced.id, reason: `already present at ${produced.target_path}` });
        continue;
      }
      suggestions.push(produced);
    }

    const order = { high: 0, medium: 1, low: 2 } as const;
    suggestions.sort((a, b) => order[a.priority] - order[b.priority]);

    return {
      generated_at: new Date().toISOString(),
      signals_summary: {
        language: signals.language,
        total_verified: signals.total_verified,
        top_failure_class: signals.failure_classes[0]?.failure_class,
        hotspot_count: signals.hotspots.length,
        regression_count: signals.regressions.length,
      },
      suggestions,
      skipped,
    };
  }

  /**
   * Write one proposal to disk.
   *
   * Refuses when the target already exists: these artefacts are hand-editable
   * and silently overwriting a customised hook would destroy the user's work.
   *
   * @param id - Identifier from a prior {@link advise} call.
   * @param force - Overwrite an existing file.
   */
  apply(id: string, force = false): CapabilityApplyResult {
    // Deliberately the UNFILTERED rule output. `advise()` drops proposals whose
    // file already exists, so looking the id up there would make an existing
    // target indistinguishable from an unknown id — and would leave `force`
    // permanently unreachable, since the only proposals it applies to are
    // exactly the ones `advise()` filters away.
    const signals = this.gatherSignals(new Retrospective(this.db).analyse());
    const match = this.generateAll(signals).find((s) => s.id === id);
    if (!match) {
      return {
        id,
        written: false,
        target_path: '',
        reason: 'No current suggestion with that id. Re-run the advisor for an up-to-date list.',
      };
    }

    const absolute = resolve(this.projectRoot, match.target_path);
    if (existsSync(absolute) && !force) {
      return {
        id,
        written: false,
        target_path: match.target_path,
        reason: 'File already exists. Pass force to overwrite.',
      };
    }

    try {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, match.content, 'utf-8');
      return { id, written: true, target_path: match.target_path };
    } catch (err) {
      return {
        id,
        written: false,
        target_path: match.target_path,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ─── Rule execution ────────────────────────────────────────────────────────

  /**
   * Run every rule and return whatever they produced, with no filtering.
   *
   * A rule that throws is skipped rather than allowed to abort the batch: one
   * malformed episode should cost one proposal, not all of them.
   */
  private generateAll(signals: ProjectSignals): CapabilitySuggestion[] {
    const rules: Array<() => CapabilitySuggestion | null> = [
      () => this.ruleRegressionGuard(signals),
      () => this.ruleDeadEndMemory(signals),
      () => this.ruleDefectClassSteering(signals),
      () => this.ruleHotspotScan(signals),
      () => this.ruleUnresolvedTriage(signals),
      () => this.ruleProofToTest(signals),
      () => this.rulePreCommitGate(signals),
      () => this.ruleLanguageCoverage(signals),
    ];

    const produced: CapabilitySuggestion[] = [];
    for (const rule of rules) {
      try {
        const result = rule();
        if (result) produced.push(result);
      } catch {
        continue;
      }
    }
    return produced;
  }

  // ─── Signals ───────────────────────────────────────────────────────────────

  private gatherSignals(report: RetrospectiveReport): ProjectSignals {
    return {
      project_root: this.projectRoot,
      language: this.language,
      existing_hooks: this.listDir(join('.kiro', 'hooks')),
      existing_steering: this.listDir(join('.kiro', 'steering')),
      existing_skills: this.listDir(join('.kiro', 'skills')),
      has_test_script: this.hasTestScript(),
      failure_classes: countBy(report.lessons, (l) => l.failure_class).map(
        ([failure_class, occurrences]) => ({ failure_class, occurrences })
      ),
      defect_classes: countBy(report.lessons, (l) => l.defect_class).map(
        ([defect_class, occurrences]) => ({ defect_class, occurrences })
      ),
      hotspots: report.hotspots,
      regressions: report.regressions,
      unresolved: report.unresolved,
      dead_ends: report.dead_ends,
      total_verified: report.analysed_episodes,
    };
  }

  private listDir(relative: string): string[] {
    try {
      return readdirSync(resolve(this.projectRoot, relative));
    } catch {
      return [];
    }
  }

  private hasTestScript(): boolean {
    try {
      const pkg = JSON.parse(
        readFileSync(resolve(this.projectRoot, 'package.json'), 'utf-8')
      ) as { scripts?: Record<string, string> };
      return typeof pkg.scripts?.test === 'string' && pkg.scripts.test.trim() !== '';
    } catch {
      return false;
    }
  }

  /** True when the proposal's target file already exists. */
  private alreadyPresent(suggestion: CapabilitySuggestion): boolean {
    return existsSync(resolve(this.projectRoot, suggestion.target_path));
  }

  /** Source glob for the configured language. */
  private sourceGlob(): string {
    if (this.language === 'python' || this.language === 'py') return '**/*.py';
    if (this.language === 'javascript') return '**/*.{js,jsx,mjs,cjs}';
    return '**/*.{ts,tsx}';
  }

  // ─── Rules ─────────────────────────────────────────────────────────────────

  /**
   * Fixes that did not stick are the strongest evidence available that the
   * current guardrails are insufficient, so this re-verifies the exact files
   * where a defect returned after being repaired.
   */
  private ruleRegressionGuard(s: ProjectSignals): CapabilitySuggestion | null {
    if (s.regressions.length === 0) return null;

    const files = unique(s.regressions.map((r) => r.file_path)).slice(0, 10);
    const functions = unique(s.regressions.map((r) => r.function_id)).slice(0, 10);

    return {
      id: 'hook-regression-guard',
      kind: 'hook',
      title: 'Re-verify functions whose fixes regressed',
      summary:
        'On every save of a file with a known regression, re-investigate the specific functions that came back.',
      rationale: `${s.regressions.length} lesson(s) regressed: a fix was approved and the same defect was proven again afterwards. Affected functions: ${functions.join(', ')}.`,
      priority: 'high',
      target_path: '.kiro/hooks/buggy-regression-guard.kiro.hook',
      content: hookFile({
        name: 'Buggy Regression Guard',
        description:
          'Re-investigates functions whose previously-approved fixes later regressed, so the same defect cannot quietly return a third time.',
        when: { type: 'fileEdited', patterns: files.length > 0 ? files : [this.sourceGlob()] },
        prompt: [
          'A file with a known regression history was just saved.',
          '',
          'These functions have each had a fix approved and then broke again:',
          ...functions.map((f) => `- ${f}`),
          '',
          '1. Call buggy_recall for each function listed above that appears in this file. Read what worked and what failed before.',
          '2. Call buggy_investigate on those functions, reusing the postconditions from the recalled lesson.',
          '3. If a defect is proven again, say so plainly and show the trigger input. Note that this is a repeat, not a new finding.',
          '4. Do NOT apply a patch that resembles one the recall shows was already tried and regressed. Propose a different approach and explain why it addresses the cause rather than the trigger.',
          '',
          'Stay quiet if nothing is proven.',
        ].join('\n'),
      }),
      evidence: s.regressions.map((r) => r.lesson_key),
    };
  }

  /**
   * Turns repeatedly-rejected approaches into an always-loaded steering rule.
   * This is the memory of its own mistakes made explicit: without it the agent
   * re-proposes the same rejected patch shape indefinitely.
   */
  private ruleDeadEndMemory(s: ProjectSignals): CapabilitySuggestion | null {
    if (s.dead_ends.length === 0) return null;

    const lines: string[] = [
      '---',
      'inclusion: auto',
      '---',
      '',
      '# Buggy — Known Dead Ends',
      '',
      '<!-- Generated by `buggy suggest` from recorded investigation history. Safe to edit; re-running the advisor will not overwrite it. -->',
      '',
      'Approaches that have already been tried in this project and rejected. Each one failed more than once, so retrying them wastes a cycle and produces a patch that will be rejected again.',
      '',
      '## Do not retry these',
      '',
    ];

    for (const dead of s.dead_ends.slice(0, 12)) {
      lines.push(`### Failed ${dead.occurrences}× — ${dead.reason}`);
      lines.push(`- **Seen in:** ${dead.affected_functions.slice(0, 6).join(', ')}`);
      lines.push('');
    }

    lines.push('## What to do instead');
    lines.push('');
    lines.push(
      '- Call `buggy_recall` before editing any function listed above. The recalled lesson names the approach that worked, if one did.'
    );
    lines.push(
      '- When a patch is rejected for overfitting, do not re-submit a variation that guards the same literal input. Address the condition that makes the input dangerous.'
    );
    lines.push(
      '- If every candidate keeps getting rejected, the specification is probably too weak to distinguish a real fix. Strengthen the postconditions before generating more patches.'
    );
    lines.push('');

    return {
      id: 'steering-dead-ends',
      kind: 'steering',
      title: 'Record known dead ends so rejected approaches are not retried',
      summary:
        'An auto-included steering file listing approaches that were already rejected, and what to do instead.',
      rationale: `${s.dead_ends.length} distinct approach(es) failed at least twice. The most common failed ${s.dead_ends[0]!.occurrences} times across ${s.dead_ends[0]!.affected_functions.length} function(s).`,
      priority: 'high',
      target_path: '.kiro/steering/buggy-dead-ends.md',
      content: `${lines.join('\n')}`,
      evidence: s.dead_ends.map((d) => d.reason),
    };
  }

  /**
   * Teaches the project's single most recurrent defect class, with the guard
   * idiom written in the configured language rather than generic advice.
   */
  private ruleDefectClassSteering(s: ProjectSignals): CapabilitySuggestion | null {
    const top = s.failure_classes[0];
    if (!top || top.occurrences < 2) return null;

    const guide = FAILURE_GUIDES[top.failure_class];
    if (!guide) return null;

    const d = selectDialect(this.language);
    const example = guide.example(d);

    const content = [
      '---',
      'inclusion: auto',
      '---',
      '',
      `# Buggy — ${guide.title}`,
      '',
      '<!-- Generated by `buggy suggest` from recorded investigation history. -->',
      '',
      `\`${top.failure_class}\` is the most frequently proven defect in this project (${top.occurrences} occurrences). Apply the rules below when writing or reviewing code of this shape.`,
      '',
      '## The pattern',
      '',
      guide.pattern,
      '',
      '## Write it like this',
      '',
      '```' + (this.language === 'python' ? 'python' : 'typescript'),
      example,
      '```',
      '',
      '## Before you commit',
      '',
      ...guide.checklist.map((c) => `- ${c}`),
      '',
      '## Verify it',
      '',
      `Run \`buggy_investigate\` with these postconditions on any function of this shape:`,
      '',
      '```',
      ...guide.postconditions.map((p) => p),
      '```',
      '',
    ].join('\n');

    return {
      id: `steering-${top.failure_class.replace(/_/g, '-')}`,
      kind: 'steering',
      title: `Teach the ${top.failure_class.replace(/_/g, ' ')} pattern`,
      summary: `An auto-included steering rule for the project's most recurrent defect class, with ${this.language} syntax.`,
      rationale: `${top.failure_class} accounts for ${top.occurrences} proven defect(s) — more than any other class in this project.`,
      priority: top.occurrences >= 3 ? 'high' : 'medium',
      target_path: `.kiro/steering/buggy-${top.failure_class.replace(/_/g, '-')}.md`,
      content,
      evidence: [`failure_class=${top.failure_class}`, `occurrences=${top.occurrences}`],
    };
  }

  /** A file concentrating defects earns a dedicated, on-demand deep scan. */
  private ruleHotspotScan(s: ProjectSignals): CapabilitySuggestion | null {
    const hot = s.hotspots.find(
      (h) => h.proven_defects >= HOTSPOT_DEFECT_THRESHOLD && h.distinct_functions >= 2
    );
    if (!hot) return null;

    return {
      id: 'hook-hotspot-scan',
      kind: 'hook',
      title: 'Scan the project’s defect hotspots on demand',
      summary:
        'A user-triggered hook that investigates every function in the files that have produced the most proven defects.',
      rationale: `${hot.file_path} has ${hot.proven_defects} proven defects across ${hot.distinct_functions} functions (classes: ${hot.failure_classes.slice(0, 3).join(', ')}).`,
      priority: 'medium',
      target_path: '.kiro/hooks/buggy-hotspot-scan.kiro.hook',
      content: hookFile({
        name: 'Buggy Hotspot Scan',
        description:
          'Investigates every function in the files with the highest proven-defect counts, rather than scanning the whole project.',
        when: { type: 'userTriggered' },
        prompt: [
          'Scan this project’s known defect hotspots, highest risk first:',
          '',
          ...s.hotspots
            .slice(0, 5)
            .map(
              (h) =>
                `- ${h.file_path} — ${h.proven_defects} proven defect(s), ${h.distinct_functions} function(s)${h.regressions > 0 ? `, ${h.regressions} regression(s)` : ''}`
            ),
          '',
          'For each file:',
          '1. Call buggy_list_functions to enumerate its functions.',
          '2. Call buggy_recall for each function so prior lessons inform the specs you write.',
          '3. Call buggy_investigate with postconditions inferred from the code and the recalled history.',
          '4. Collect every proven defect with its trigger input and any approved patch diff.',
          '',
          'Report a short table: file, function, defect, trigger, whether a fix is available. Present fixes for review; do not apply anything.',
        ].join('\n'),
      }),
      evidence: s.hotspots.slice(0, 5).map((h) => h.file_path),
    };
  }

  /**
   * Defects proven repeatedly where every patch was rejected are a design
   * problem, not a patch-generation problem. This proposes a skill that treats
   * them as such.
   */
  private ruleUnresolvedTriage(s: ProjectSignals): CapabilitySuggestion | null {
    if (s.unresolved.length === 0) return null;

    const content = [
      '---',
      'name: buggy-unresolved-triage',
      'description: Design a correct fix for a defect that Buggy proved but whose every candidate patch was rejected as overfit.',
      '---',
      '',
      '# Triaging an unresolved proven defect',
      '',
      'Use this when `buggy_investigate` returns `confirmed_no_repair`, or when the same defect keeps getting proven and every generated patch is rejected.',
      '',
      'A rejected patch is not a failure of the classifier. It means the patch changed the code in a shape that correlates with fixes that only work on the example that caught them. The answer is a better fix, not a louder one.',
      '',
      '## Why patches get rejected here',
      '',
      'The classifier scores the *shape* of the edit across 66 dimensions. Patches score badly when they:',
      '',
      '- guard the exact literal from the proof (`if (x === 0)`) instead of the condition that makes it unsafe',
      '- add a branch whose only purpose is to short-circuit the failing input',
      '- delete or neutralise the operation rather than making it correct',
      '',
      '## Procedure',
      '',
      '1. **Read the certificate.** Note the trigger input, the observed output, and the violated postcondition. The violated postcondition is the actual contract.',
      '2. **Call `buggy_recall`** on the function. Every rejected approach and its rejection reason is recorded; do not re-derive them.',
      '3. **Ask what the function should return for that input.** Often the honest answer is that the input is invalid and the contract is wrong — in which case tighten the *precondition*, not the body.',
      '4. **Choose a category of fix:**',
      '   - *Contract repair* — the input should never arrive; validate at the boundary and document the precondition.',
      '   - *Total function* — define a correct result for the whole domain (clamp, saturate, return a neutral element).',
      '   - *Type-level fix* — make the bad input unrepresentable so the check disappears at compile time.',
      '5. **Re-investigate** with strengthened postconditions. If the spec was too weak to distinguish a real fix from an overfit one, no patch could have passed.',
      '6. **Record the outcome** by running the investigation again after editing, so the Watchlist learns which category worked.',
      '',
      '## Currently unresolved in this project',
      '',
      ...s.unresolved
        .slice(0, 10)
        .map(
          (u) =>
            `- \`${u.function_id}\` in ${u.file_path} — ${u.failure_class ?? 'defect'}, proven ${u.occurrences}×`
        ),
      '',
      '## Done when',
      '',
      '- The defect is re-investigated and returns `unconfirmed`, or returns an approved patch.',
      '- The chosen fix category is written down so the next person does not re-litigate it.',
      '',
    ].join('\n');

    return {
      id: 'skill-unresolved-triage',
      kind: 'skill',
      title: 'Add a triage skill for defects where every patch was rejected',
      summary:
        'A skill that walks through designing a correct fix when patch generation keeps producing overfit candidates.',
      rationale: `${s.unresolved.length} defect(s) were proven more than once but never had a fix approved — e.g. ${s.unresolved[0]!.function_id} (${s.unresolved[0]!.occurrences}×).`,
      priority: 'high',
      target_path: '.kiro/skills/buggy-unresolved-triage/SKILL.md',
      content,
      evidence: s.unresolved.map((u) => u.lesson_key),
    };
  }

  /**
   * A proof certificate is already a failing test case: concrete input,
   * observed output, violated postcondition. Converting them is the cheapest
   * durable guard against regression, and directly targets the regressions the
   * retrospective found.
   */
  private ruleProofToTest(s: ProjectSignals): CapabilitySuggestion | null {
    if (s.total_verified === 0) return null;

    const isPy = this.language === 'python';
    const content = [
      '---',
      'name: buggy-proof-to-test',
      'description: Turn a Buggy proof-of-failure certificate into a permanent regression test so the same defect cannot return unnoticed.',
      '---',
      '',
      '# Converting a proof certificate into a regression test',
      '',
      'A proof certificate already contains everything a test needs: a concrete input, the observed wrong output, and the postcondition it violated. Writing it down as a test is what stops the defect returning after the fix is forgotten.',
      '',
      '## When to use',
      '',
      '- Immediately after a `buggy_investigate` run returns `confirmed_and_repaired` or `confirmed_no_repair`.',
      '- When `buggy retrospect` reports a regression — the fix held once and came back, which means there was no test pinning it.',
      '',
      '## Procedure',
      '',
      '1. Take the certificate’s `test_input`, `observed_output` and `violated_postcondition`.',
      '2. Write a test that calls the function with that exact input and asserts the **postcondition**, not the old wrong output.',
      '3. Name the test after the defect, not the input, so its purpose survives refactoring.',
      '4. Run it against the unfixed code and confirm it fails. A regression test that never failed proves nothing.',
      '5. Apply the fix, then confirm it passes.',
      '',
      '## Shape',
      '',
      '```' + (isPy ? 'python' : 'typescript'),
      ...(isPy
        ? [
            'def test_split_expense_rejects_zero_people():',
            '    """Proven by Buggy: splitExpense(0, 0) returned nan, violating isfinite(result)."""',
            '    result = split_expense(0, 0)',
            '    assert math.isfinite(result)',
            '    assert result >= 0',
          ]
        : [
            "it('splitExpense returns a finite amount when there are no people', () => {",
            '  // Proven by Buggy: splitExpense(0, 0) returned NaN, violating isFinite(result).',
            '  const result = splitExpense(0, 0);',
            '  expect(Number.isFinite(result)).toBe(true);',
            '  expect(result).toBeGreaterThanOrEqual(0);',
            '});',
          ]),
      '```',
      '',
      '## Rules',
      '',
      '- Assert the postcondition, never the buggy output. Asserting `NaN` locks the bug in.',
      '- Keep the input exactly as the certificate recorded it, including `0`, `-0`, `NaN` and empty collections. These are the values that found the defect.',
      '- One test per certificate. Bundling them hides which contract broke.',
      ...(s.has_test_script
        ? ['- This project already has a `test` script; add the test to the existing suite.']
        : [
            '- This project has no `test` script yet. Set up the standard runner for the language before writing the first one.',
          ]),
      '',
    ].join('\n');

    return {
      id: 'skill-proof-to-test',
      kind: 'skill',
      title: 'Add a skill for turning proof certificates into regression tests',
      summary:
        'A skill that converts a certificate’s trigger input and violated postcondition into a permanent test.',
      rationale:
        s.regressions.length > 0
          ? `${s.regressions.length} fix(es) regressed, which is what happens when a proven defect is repaired without a test pinning it. ${s.total_verified} certificate(s) are available to convert.`
          : `${s.total_verified} proof certificate(s) exist and none have been converted into tests.`,
      priority: s.regressions.length > 0 ? 'high' : 'medium',
      target_path: '.kiro/skills/buggy-proof-to-test/SKILL.md',
      content,
      evidence: [`verified_episodes=${s.total_verified}`, `regressions=${s.regressions.length}`],
    };
  }

  /** Once defects are a pattern, verifying before a commit is worth the cost. */
  private rulePreCommitGate(s: ProjectSignals): CapabilitySuggestion | null {
    if (s.total_verified < PRECOMMIT_EVIDENCE_THRESHOLD) return null;

    return {
      id: 'hook-pre-commit-verify',
      kind: 'hook',
      title: 'Verify changed functions before a commit is created',
      summary:
        'Investigates functions in the staged diff and reports proven defects before the commit lands.',
      rationale: `${s.total_verified} proven defects have reached this repository already. Checking the staged diff catches them one step earlier than a post-save hook.`,
      priority: 'medium',
      target_path: '.kiro/hooks/buggy-pre-commit-verify.kiro.hook',
      content: hookFile({
        name: 'Buggy Pre-Commit Verify',
        description:
          'Before a commit is created, investigates the functions touched by the staged diff and reports any proven defect so it can be dealt with before it is recorded in history.',
        when: { type: 'userTriggered' },
        prompt: [
          'The user is about to commit. Verify the staged changes:',
          '',
          '1. Run `git diff --cached --name-only` to list staged files, keeping only source files.',
          '2. For each, run `git diff --cached -U0` and identify which functions were touched.',
          '3. Call buggy_recall for each touched function. If a prior lesson exists, use its postconditions.',
          '4. Call buggy_investigate on each touched function.',
          '5. Report only proven defects: function, trigger input, violated postcondition, and whether an approved fix exists.',
          '',
          'If nothing is proven, say "No proven defects in staged changes" and stop. Never block or create the commit yourself — report and let the user decide.',
        ].join('\n'),
      }),
      evidence: [`verified_episodes=${s.total_verified}`],
    };
  }

  /**
   * A Python project whose file-triggered hooks only match TypeScript globs
   * silently never fires. This catches that mismatch, which stays invisible
   * until someone notices the hooks have produced nothing at all.
   */
  private ruleLanguageCoverage(s: ProjectSignals): CapabilitySuggestion | null {
    if (s.existing_hooks.length === 0) return null;

    const glob = this.sourceGlob();
    const ext = this.language === 'python' ? '.py' : this.language === 'javascript' ? '.js' : '.ts';

    // Does any existing file-triggered hook mention this language's extension?
    let mentionsLanguage = false;
    for (const hook of s.existing_hooks) {
      try {
        const body = readFileSync(
          resolve(this.projectRoot, '.kiro', 'hooks', hook),
          'utf-8'
        );
        if (!body.includes('fileEdited')) continue;
        if (body.includes(ext)) {
          mentionsLanguage = true;
          break;
        }
      } catch {
        continue;
      }
    }
    if (mentionsLanguage) return null;

    return {
      id: 'hook-language-coverage',
      kind: 'hook',
      title: `Add a save hook that actually matches ${this.language} files`,
      summary: `Existing file-triggered hooks do not match ${ext} files, so they never fire for this project's sources.`,
      rationale: `The project language is ${this.language}, but none of the ${s.existing_hooks.length} existing hook(s) match ${ext}. File-save analysis is silently doing nothing.`,
      priority: 'high',
      target_path: `.kiro/hooks/buggy-on-save-${this.language}.kiro.hook`,
      content: hookFile({
        name: `Buggy Auto-Analyze on Save (${this.language})`,
        description: `Analyses ${this.language} files on save. The existing save hooks match a different language's extension and never fire here.`,
        when: { type: 'fileEdited', patterns: [glob] },
        prompt: [
          `A ${this.language} file was just saved. Check it:`,
          '',
          '1. Call buggy_analyze on the file. Report any syntax errors.',
          '2. Call buggy_list_functions and pick out the risky ones — division, indexing without a bounds check, unclamped arithmetic, unbounded loops.',
          '3. Call buggy_recall on each risky function. If it has history, say so before anything else.',
          '4. Call buggy_investigate on the riskiest one or two, with postconditions inferred from the code.',
          '',
          'Be brief. Flag proven defects with their trigger input. Do not edit anything unless asked.',
        ].join('\n'),
      }),
      evidence: [`language=${this.language}`, `existing_hooks=${s.existing_hooks.length}`],
    };
  }
}

// ─── Templates ───────────────────────────────────────────────────────────────

/**
 * Render a hook file in the schema this project's existing hooks already use
 * (`when`/`then` with `askAgent`), so generated hooks stay consistent with the
 * seven that ship with Buggy.
 */
function hookFile(spec: {
  name: string;
  description: string;
  when: { type: string; patterns?: string[] };
  prompt: string;
}): string {
  return `${JSON.stringify(
    {
      enabled: true,
      name: spec.name,
      description: spec.description,
      version: '1',
      when: spec.when,
      then: { type: 'askAgent', prompt: spec.prompt },
    },
    null,
    2
  )}\n`;
}

/** Per-failure-class teaching material, rendered in the target language. */
interface FailureGuide {
  title: string;
  pattern: string;
  example: (d: ReturnType<typeof selectDialect>) => string;
  checklist: string[];
  postconditions: string[];
}

const FAILURE_GUIDES: Record<string, FailureGuide> = {
  division_by_zero: {
    title: 'Division and zero denominators',
    pattern:
      'Any division whose denominator is derived from input, a length, or a count can receive zero. In JavaScript this yields `NaN` or `Infinity` rather than throwing, so the bad value propagates silently until something far away fails. In Python it raises immediately.',
    example: (d) =>
      [
        d.guardEarlyReturn(d.isEmptyCollection('items'), d.defaultForType('number'), ''),
        '',
        `${d.lineComment('or make the function total rather than guarded')}`,
        d.assign('divisor', d.clampMin('count', '1'), ''),
      ].join('\n'),
    checklist: [
      'Every denominator that comes from a length, count or parameter has a zero case.',
      'The zero case returns a documented, meaningful value — not `NaN` and not a silent `0` that hides the condition.',
      'The precondition says so explicitly if zero is genuinely invalid.',
    ],
    postconditions: ['isFinite(result)', '!isNaN(result)', 'result >= 0'],
  },
  nan_result: {
    title: 'NaN leaking out of arithmetic',
    pattern:
      '`NaN` is contagious: one `NaN` input turns every downstream arithmetic result into `NaN`, and `NaN !== NaN` means naive equality checks never catch it. The failure surfaces far from its cause.',
    example: (d) =>
      [
        d.guardEarlyReturn('!Number.isFinite(value)', d.defaultForType('number'), ''),
        '',
        `${d.lineComment('validate at the boundary, not at every use site')}`,
      ].join('\n'),
    checklist: [
      'Numeric inputs are checked for finiteness at the boundary.',
      'Checks use `Number.isNaN` / `Number.isFinite`, never `=== NaN`.',
      'Aggregations over possibly-empty collections define their empty result.',
    ],
    postconditions: ['!isNaN(result)', 'isFinite(result)'],
  },
  negative_or_underflow: {
    title: 'Values that must never go negative',
    pattern:
      'Quantities like prices, balances, counts and durations have a floor at zero, but the arithmetic that produces them does not know that. A discount above 100%, or a subtraction larger than the balance, silently produces a negative value that is accepted downstream.',
    example: (d) =>
      [
        `${d.lineComment('clamp the input, not the result — the result tells you nothing about why')}`,
        d.assign('pct', `Math.min(100, ${d.clampMin('pct', '0')})`, ''),
        '',
        d.returnStatement(d.clampMin('subtotal - discount', '0'), ''),
      ].join('\n'),
    checklist: [
      'Percentage inputs are clamped to their valid range before use.',
      'Subtractions that must stay non-negative are clamped or validated.',
      'The postcondition `result >= 0` is asserted, not assumed.',
    ],
    postconditions: ['result >= 0', 'isFinite(result)'],
  },
  null_or_undefined: {
    title: 'Missing values reaching property access',
    pattern:
      'Optional values, map lookups and parsed input all produce absent values. Reading a property off one throws at the access site, which is usually not where the value went missing.',
    example: (d) =>
      [
        d.guardEarlyReturn(d.isNullish('user'), d.defaultForType('unknown'), ''),
        '',
        `${d.lineComment('or supply a default at the boundary')}`,
        d.assign('name', d.coalesce('user?.name', d.defaultForType('string')), ''),
      ].join('\n'),
    checklist: [
      'Every value that can be absent is narrowed before use.',
      'Defaults are applied at the boundary so the core logic deals in total values.',
      'Absence is distinguished from emptiness where that difference matters.',
    ],
    postconditions: ['result !== undefined', 'result !== null'],
  },
  out_of_bounds: {
    title: 'Index and slice bounds',
    pattern:
      'Indices computed from lengths, user input or search results can fall outside the collection. JavaScript returns `undefined` rather than throwing, so the error becomes a `NaN` or a null dereference later.',
    example: (d) =>
      [
        d.guardEarlyReturn(
          'index < 0 || index >= items.length',
          d.defaultForType('unknown'),
          ''
        ),
        '',
        `${d.lineComment('empty-collection access is the most common case')}`,
        d.guardEarlyReturn(d.isEmptyCollection('items'), d.defaultForType('unknown'), ''),
      ].join('\n'),
    checklist: [
      'Indices are range-checked against the actual length, not an assumed one.',
      'The empty-collection case is handled explicitly.',
      'Results of a search are checked before being used as an index.',
    ],
    postconditions: ['result !== undefined', 'index >= 0 && index < items.length'],
  },
  timeout: {
    title: 'Loops that may not terminate',
    pattern:
      'A loop whose bound depends on input, convergence, or mutation during iteration can fail to terminate. The symptom is a hang, which is harder to diagnose than a crash.',
    example: (d) =>
      [
        `${d.lineComment('bound every convergence loop explicitly')}`,
        d.assign('iterations', '0', ''),
        `${d.lineComment('and assert progress, so a stalled loop fails loudly instead of hanging')}`,
      ].join('\n'),
    checklist: [
      'Every `while` loop has either a decreasing measure or a hard iteration cap.',
      'Loop variables are not mutated by anything inside the body in a way that can stall progress.',
      'Recursion has an explicit depth limit.',
    ],
    postconditions: ['execution completes within the configured timeout'],
  },
  nondeterminism: {
    title: 'Results that vary between identical calls',
    pattern:
      'A function reading the clock, a random source, iteration order, or shared mutable state returns different answers for the same input. That makes it untestable and makes failures unreproducible.',
    example: (d) =>
      [
        `${d.lineComment('inject the varying dependency instead of reaching for it')}`,
        `${d.lineComment('now the function is a pure mapping from its inputs')}`,
      ].join('\n'),
    checklist: [
      'Time and randomness are passed in, not read inside.',
      'Iteration over unordered collections does not affect the result.',
      'No shared mutable state is read without synchronisation.',
    ],
    postconditions: ['the same input always produces the same output'],
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Count non-empty keys produced by `pick`, descending by count. */
function countBy<T>(items: T[], pick: (item: T) => string | undefined): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = pick(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
