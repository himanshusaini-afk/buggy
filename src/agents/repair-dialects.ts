/**
 * Repair Dialects
 *
 * The proof/parse/classify stages of the pipeline are language-agnostic, but a
 * *patch* is concrete source text — it must be written in the target language's
 * syntax. This module isolates everything language-specific about emitting a
 * patch behind the {@link RepairDialect} interface, so the repair strategies can
 * stay language-neutral and adding a language means adding one dialect object.
 *
 * It also holds {@link analyzeTrigger}, which reads the proof-of-failure
 * certificate to work out *what input actually broke the function*. That part is
 * language-independent: the resulting {@link TriggerGuard} is rendered into
 * concrete syntax by a dialect. Guarding the proven trigger (rather than
 * emitting a generic null/NaN check) is what makes a patch a real fix instead of
 * an unrelated edit the classifier rightly rejects as overfit.
 *
 * @module agents/repair-dialects
 */

import type { ProofOfFailureCertificate } from '../types/proof.js';
import type { DefectContext } from '../types/repair.js';

/**
 * The language-specific surface needed to emit a patch.
 *
 * Implementations must only produce syntactically valid code for their language;
 * they carry no knowledge of *why* a patch is being made.
 */
export interface RepairDialect {
  /** Canonical language name, e.g. `typescript` or `python`. */
  readonly name: string;

  /** Render a single-line comment. */
  lineComment(text: string): string;

  /**
   * Render an early-return guard: "if <condition>, return <value>".
   * @param condition - Already-rendered boolean expression.
   * @param returnValue - Already-rendered value expression.
   * @param indent - Leading whitespace to preserve the surrounding block.
   */
  guardEarlyReturn(condition: string, returnValue: string, indent: string): string;

  /** Render a `return <value>` statement. */
  returnStatement(value: string, indent: string): string;

  /**
   * Wrap an existing line of code in a conditional block.
   * @param condition - Already-rendered boolean expression.
   * @param bodyLine - The original source line to place inside the block.
   * @param indent - Leading whitespace for the `if` itself.
   */
  wrapInConditional(condition: string, bodyLine: string, indent: string): string;

  /** Render an assignment `<name> = <expr>`. */
  assign(name: string, expr: string, indent: string): string;

  /** Equality comparison against a literal (`===` in TS, `==` in Python). */
  equals(lhs: string, rhs: string): string;

  /** Logical OR joining of conditions. */
  or(conditions: string[]): string;

  /** "is null / undefined / None" test. */
  isNullish(value: string): string;

  /** "collection is empty" test (length/len based). */
  isEmptyCollection(value: string): string;

  /** Clamp an expression to a minimum. */
  clampMin(value: string, min: string): string;

  /** Fall back to a default when the value is nullish. */
  coalesce(value: string, fallback: string): string;

  /** Default value literal for a declared return type. */
  defaultForType(returnType: string): string;

  /**
   * Keywords that mean "this line opens a block / is control flow", used to
   * avoid deleting a structural line as if it were a plain statement.
   */
  readonly blockKeywords: readonly string[];

  /**
   * Whether a line is structural (a declaration, block opener, or control-flow
   * statement) and therefore must never be removed by the deletion strategy.
   *
   * Deleting a declaration produces a patch that destroys the function rather
   * than repairing it, so this check is deliberately conservative.
   *
   * @param trimmedLine - The source line with surrounding whitespace removed.
   */
  isStructuralLine(trimmedLine: string): boolean;

  /** Map an operator to a plausible correction, for the operator-swap strategy. */
  correctOperator(operator: string): string;
}

/**
 * Shared structural-line test used by both dialects.
 *
 * A line is structural when it opens a block (ends with `{` or `:`) or contains
 * any block/declaration keyword as a whole word. The keyword is matched anywhere
 * in the line, not just at the start, so `export function foo() {` is caught even
 * though it begins with `export`. Erring toward "structural" is intentional: a
 * false positive merely skips one candidate patch, while a false negative yields
 * a patch that deletes a declaration.
 */
function isStructural(trimmedLine: string, keywords: readonly string[]): boolean {
  if (trimmedLine === '') return true;
  if (trimmedLine.endsWith('{') || trimmedLine.endsWith(':')) return true;
  return keywords.some((kw) => new RegExp(`\\b${kw}\\b`).test(trimmedLine));
}

/** Shared operator-correction pairs that are valid in both C-like and Python syntax. */
const COMMON_OPERATOR_CORRECTIONS: Record<string, string> = {
  '<': '<=',
  '>': '>=',
  '<=': '<',
  '>=': '>',
  '+': '-',
  '-': '+',
  '*': '/',
  '/': '*',
};

/** TypeScript / JavaScript dialect. */
export const typescriptDialect: RepairDialect = {
  name: 'typescript',

  lineComment: (text) => `// ${text}`,

  guardEarlyReturn: (condition, returnValue, indent) =>
    `${indent}if (${condition}) {\n${indent}  return ${returnValue};\n${indent}}`,

  returnStatement: (value, indent) => `${indent}return ${value};`,

  wrapInConditional: (condition, bodyLine, indent) =>
    `${indent}if (${condition}) {\n${bodyLine}\n${indent}}`,

  assign: (name, expr, indent) => `${indent}${name} = ${expr};`,

  equals: (lhs, rhs) => `${lhs} === ${rhs}`,

  or: (conditions) => conditions.join(' || '),

  isNullish: (value) => `${value} == null`,

  isEmptyCollection: (value) => `${value}.length === 0`,

  clampMin: (value, min) => `Math.max(${min}, ${value})`,

  coalesce: (value, fallback) => `${value} ?? ${fallback}`,

  defaultForType: (returnType) => {
    const t = returnType.toLowerCase().trim();
    if (t === 'number' || t === 'int' || t === 'float') return '0';
    if (t === 'string' || t === 'str') return "''";
    if (t === 'boolean' || t === 'bool') return 'false';
    if (t.endsWith('[]') || t.startsWith('array') || t.startsWith('list')) return '[]';
    if (t === 'void' || t === 'undefined') return '';
    return 'null';
  },

  blockKeywords: [
    'if', 'for', 'while', 'function', 'class', 'return', 'switch', 'try', 'catch',
    'else', 'export', 'const', 'let', 'var', 'interface', 'type', 'import',
  ],

  isStructuralLine: (trimmedLine) => isStructural(trimmedLine, typescriptDialect.blockKeywords),

  correctOperator: (operator) => {
    const corrections: Record<string, string> = {
      ...COMMON_OPERATOR_CORRECTIONS,
      '==': '===',
      '!=': '!==',
      '===': '!==',
      '!==': '===',
      '&&': '||',
      '||': '&&',
    };
    return corrections[operator] ?? operator;
  },
};

/** Python dialect. */
export const pythonDialect: RepairDialect = {
  name: 'python',

  lineComment: (text) => `# ${text}`,

  // Python blocks are indentation-delimited: a 4-space body under `if ...:`.
  guardEarlyReturn: (condition, returnValue, indent) =>
    `${indent}if ${condition}:\n${indent}    return ${returnValue}`,

  returnStatement: (value, indent) => `${indent}return ${value}`,

  // The wrapped line must be re-indented into the new block, since Python has no
  // braces to delimit it.
  wrapInConditional: (condition, bodyLine, indent) =>
    `${indent}if ${condition}:\n${indent}    ${bodyLine.trim()}`,

  assign: (name, expr, indent) => `${indent}${name} = ${expr}`,

  equals: (lhs, rhs) => `${lhs} == ${rhs}`,

  or: (conditions) => conditions.join(' or '),

  isNullish: (value) => `${value} is None`,

  isEmptyCollection: (value) => `len(${value}) == 0`,

  clampMin: (value, min) => `max(${min}, ${value})`,

  // Python has no `??`; `or` is the idiomatic fallback for falsy/None.
  coalesce: (value, fallback) => `${value} or ${fallback}`,

  defaultForType: (returnType) => {
    const t = returnType.toLowerCase().trim();
    if (t === 'float' || t === 'number') return '0.0';
    if (t === 'int') return '0';
    if (t === 'string' || t === 'str') return "''";
    if (t === 'boolean' || t === 'bool') return 'False';
    if (t.endsWith('[]') || t.startsWith('array') || t.startsWith('list')) return '[]';
    if (t === 'void' || t === 'none') return 'None';
    return 'None';
  },

  blockKeywords: [
    'if', 'for', 'while', 'def', 'class', 'return', 'try', 'except', 'elif',
    'else', 'with', 'import', 'from', 'async', 'yield', 'raise',
  ],

  isStructuralLine: (trimmedLine) => isStructural(trimmedLine, pythonDialect.blockKeywords),

  correctOperator: (operator) => {
    const corrections: Record<string, string> = {
      ...COMMON_OPERATOR_CORRECTIONS,
      // Python has no strict-equality operators; keep corrections within the language.
      '==': '!=',
      '!=': '==',
      '===': '==',
      '!==': '!=',
      'and': 'or',
      'or': 'and',
      '&&': 'or',
      '||': 'and',
    };
    return corrections[operator] ?? operator;
  },
};

/**
 * Select the dialect for a language, defaulting to TypeScript.
 *
 * @param language - Language name from project config (e.g. `python`, `ts`).
 */
export function selectDialect(language?: string): RepairDialect {
  const normalized = (language ?? '').toLowerCase().trim();
  if (normalized === 'python' || normalized === 'py') return pythonDialect;
  return typescriptDialect;
}

/**
 * A language-independent description of the input that provably breaks a
 * function, plus the value the guard should return instead.
 */
export interface TriggerGuard {
  /**
   * Per-parameter conditions describing the failing input. May be empty when the
   * failure is a magnitude problem rather than a specific bad value — see
   * {@link TriggerGuard.clampTargets}.
   */
  conditions: TriggerCondition[];
  /**
   * Parameters whose magnitude drove the result out of range (e.g. a 150%
   * discount producing a negative price). These call for clamping rather than an
   * early return, so they are kept separate from {@link TriggerGuard.conditions}.
   */
  clampTargets: string[];
  /** Why this guard exists — used for the patch comment. */
  rationale: string;
}

/** One parameter's contribution to the failing input. */
export interface TriggerCondition {
  /** Parameter name as declared in the specification. */
  parameter: string;
  /** The shape of the offending value. */
  kind: 'zero' | 'empty_collection' | 'nullish';
}

/** Postcondition text that indicates a divide-by-zero / non-finite failure. */
function isArithmeticFailure(violated: string): boolean {
  const v = violated.toLowerCase();
  return (
    v.includes('zerodivision') ||
    v.includes('isnan') ||
    v.includes('nan') ||
    v.includes('isfinite') ||
    v.includes('infinity') ||
    v.includes('divide') ||
    v.includes('division')
  );
}

/** Postcondition text that indicates the result went below zero. */
function isNegativeResultFailure(violated: string): boolean {
  return /result\s*>=?\s*0/.test(violated.replace(/\s+/g, ' '));
}

/**
 * Derive a guard from the proof certificate by inspecting the exact input that
 * triggered the failure.
 *
 * This is the difference between a real fix and a decorative one: the proof says
 * `price_per_unit(0, 0)` raised `ZeroDivisionError`, so the guard should test
 * `quantity == 0` — not a generic `quantity is not None`.
 *
 * @param proof - The verified proof-of-failure certificate.
 * @param context - Defect context supplying parameter names and types.
 * @returns A trigger guard, or null when the proof yields no actionable shape.
 */
export function analyzeTrigger(
  proof: ProofOfFailureCertificate,
  context: DefectContext
): TriggerGuard | null {
  const input = proof.test_input;
  if (!Array.isArray(input) || input.length === 0) return null;

  const violated = proof.violated_postcondition ?? '';
  const params = context.specification.parameters ?? [];

  // Resolve a readable name for positional argument `index`.
  const nameFor = (index: number): string | null => {
    const declared = params[index]?.name;
    if (declared) return declared;
    const observed = context.variable_states[index]?.name;
    return observed ?? null;
  };

  const conditions: TriggerCondition[] = [];
  const clampTargets: string[] = [];

  input.forEach((value, index) => {
    const name = nameFor(index);
    if (!name) return;

    if (value === null || value === undefined) {
      conditions.push({ parameter: name, kind: 'nullish' });
      return;
    }
    if (Array.isArray(value) && value.length === 0) {
      conditions.push({ parameter: name, kind: 'empty_collection' });
      return;
    }
    if (typeof value === 'string' && value.length === 0) {
      conditions.push({ parameter: name, kind: 'empty_collection' });
      return;
    }
    if (typeof value === 'number' && value === 0 && isArithmeticFailure(violated)) {
      // A zero argument in an arithmetic failure is the classic divide-by-zero.
      conditions.push({ parameter: name, kind: 'zero' });
      return;
    }
    if (typeof value === 'number' && value > 0 && isNegativeResultFailure(violated)) {
      // Magnitude problem (e.g. a 150% discount): clamp instead of early-return.
      clampTargets.push(name);
    }
  });

  if (conditions.length === 0 && clampTargets.length === 0) return null;

  // For an arithmetic failure prefer the *last* zero argument: in `a / b` the
  // denominator is the operand that actually causes the fault, and it is
  // conventionally the later parameter. Guarding only it keeps the patch minimal.
  const zeros = conditions.filter((c) => c.kind === 'zero');
  if (zeros.length > 1) {
    const last = zeros[zeros.length - 1]!;
    const others = conditions.filter((c) => c.kind !== 'zero');
    const kept = [...others, last];
    return {
      conditions: kept,
      clampTargets,
      rationale: `guard proven trigger: ${describe(kept)}`,
    };
  }

  return {
    conditions,
    clampTargets,
    rationale:
      conditions.length > 0
        ? `guard proven trigger: ${describe(conditions)}`
        : `clamp out-of-range input: ${clampTargets.join(', ')}`,
  };
}

/** Human-readable summary of the trigger, for the patch comment. */
function describe(conditions: TriggerCondition[]): string {
  return conditions
    .map((c) => {
      switch (c.kind) {
        case 'zero':
          return `${c.parameter} == 0`;
        case 'empty_collection':
          return `${c.parameter} empty`;
        case 'nullish':
          return `${c.parameter} missing`;
      }
    })
    .join(', ');
}

/**
 * Render a {@link TriggerGuard} into a concrete boolean expression.
 *
 * @param guard - The language-independent trigger description.
 * @param dialect - Dialect providing the target syntax.
 * @returns The rendered condition, or null when the guard has no early-return
 *          conditions (a clamp-only trigger).
 */
export function renderTriggerCondition(
  guard: TriggerGuard,
  dialect: RepairDialect
): string | null {
  if (guard.conditions.length === 0) return null;

  const parts = guard.conditions.map((c) => {
    switch (c.kind) {
      case 'zero':
        return dialect.equals(c.parameter, '0');
      case 'empty_collection':
        return dialect.isEmptyCollection(c.parameter);
      case 'nullish':
        return dialect.isNullish(c.parameter);
    }
  });
  return dialect.or(parts);
}
