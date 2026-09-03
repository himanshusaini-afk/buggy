/**
 * Evaluation of user-authored specification conditions (pre/postconditions).
 *
 * Conditions are written in terms of the function's PARAMETER NAMES — for
 * example `values.length >= 2`, `a.length === b.length`, or
 * `result >= Math.min(...values)`. Evaluating them therefore requires binding
 * those parameter names to the corresponding argument values.
 *
 * Historically only `input` (and `result` for postconditions) were bound, so
 * every parameter-name reference threw a ReferenceError and the whole condition
 * was silently skipped — meaning specifications written the documented way had
 * no effect at all. These helpers bind the parameter names positionally so the
 * conditions actually run.
 *
 * Conditions that are prose (e.g. `values is number[]`) or otherwise not valid
 * JavaScript still throw here; callers are expected to treat a thrown condition
 * as "could not evaluate" and skip it rather than fail the whole check.
 */

const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Normalize a fuzzer input into a positional argument list, matching exactly how
 * SubprocessExecutor invokes the target (`fn(...args)` where
 * `args = Array.isArray(input) ? input : [input]`). Keeping this in lockstep
 * with the executor guarantees a condition sees the same argument values the
 * function itself received.
 */
export function toArgList(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [input];
}

/** Build the positional (name, value) bindings for the parameter names that are
 * valid, unique JS identifiers. Names that are duplicated or not valid
 * identifiers are dropped (a condition referencing them will then throw and be
 * skipped by the caller). */
function buildParamBindings(
  paramNames: string[],
  args: unknown[]
): { names: string[]; values: unknown[] } {
  const names: string[] = [];
  const values: unknown[] = [];
  const seen = new Set<string>();

  paramNames.forEach((name, i) => {
    if (VALID_IDENTIFIER.test(name) && !seen.has(name)) {
      names.push(name);
      values.push(args[i]);
      seen.add(name);
    }
  });

  return { names, values };
}

/**
 * Compile and evaluate a condition expression with the given bindings.
 * `extra` holds the synthetic bindings (`input`, and optionally `result`) that
 * are only added when they don't collide with a real parameter name.
 */
function evaluate(
  condition: string,
  paramNames: string[],
  args: unknown[],
  extra: Record<string, unknown>
): boolean {
  const { names, values } = buildParamBindings(paramNames, args);

  const extraNames: string[] = [];
  const extraValues: unknown[] = [];
  for (const [key, value] of Object.entries(extra)) {
    if (!names.includes(key)) {
      extraNames.push(key);
      extraValues.push(value);
    }
  }

  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, ...extraNames, `return (${condition});`);
  return Boolean(fn(...values, ...extraValues));
}

/**
 * The value bound to the legacy `input` identifier: the sole argument when the
 * function takes a single parameter, otherwise the full argument list. This
 * preserves the intuitive meaning of `input` for single-argument specs.
 */
function inputBinding(args: unknown[]): unknown {
  return args.length === 1 ? args[0] : args;
}

/**
 * Evaluate a precondition. Returns whether it holds (truthy).
 * Binds each parameter name to its argument plus the legacy `input`.
 * @throws if the expression is not valid JS / references an unbound name.
 */
export function evaluatePrecondition(
  condition: string,
  input: unknown,
  paramNames: string[]
): boolean {
  const args = toArgList(input);
  return evaluate(condition, paramNames, args, { input: inputBinding(args) });
}

/**
 * Evaluate a postcondition. Returns whether it holds (truthy).
 * Binds each parameter name to its argument, the legacy `input`, and `result`.
 * @throws if the expression is not valid JS / references an unbound name.
 */
export function evaluatePostcondition(
  condition: string,
  input: unknown,
  output: unknown,
  paramNames: string[]
): boolean {
  const args = toArgList(input);
  return evaluate(condition, paramNames, args, {
    input: inputBinding(args),
    result: output,
  });
}
