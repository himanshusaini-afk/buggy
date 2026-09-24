/**
 * Signature Extractor
 *
 * Reads a function's parameter list and return type straight off the CST.
 *
 * Without this, an investigation that supplies no specification has no parameter
 * information, and the fuzzer falls back to calling the target with a *single*
 * argument. Against a two-parameter function that produces
 * `TypeError: f() missing 1 required positional argument` — a harness artifact
 * reported as if it were a defect in the user's code.
 *
 * Getting the arity right is the important part. Type annotations are used when
 * present, but an unannotated parameter is reported as `unknown`, which the
 * fuzzer answers with its generic value set (including `0`, `[]` and `null`) —
 * still enough to reach the usual division-by-zero and empty-collection bugs.
 *
 * @module agents/signature-extractor
 */

import type { CstNode } from '../types/cst.js';

/** A parameter recovered from source. */
export interface ExtractedParameter {
  name: string;
  /** Declared type, or `unknown` when the source carries no annotation. */
  type: string;
}

/** A function signature recovered from source. */
export interface ExtractedSignature {
  parameters: ExtractedParameter[];
  /** Declared return type, or `unknown`. */
  return_type: string;
}

/** CST node types that introduce a named function, across supported languages. */
const FUNCTION_NODE_TYPES = new Set([
  'function_definition', // Python: def f(...)
  'function_declaration', // TS/JS: function f(...)
  'generator_function_declaration', // TS/JS: function* f(...)
  'method_definition', // TS/JS: class methods
  'function_signature', // TS: overload/ambient declarations
]);

/** Container nodes holding the parameter list. */
const PARAMETER_LIST_TYPES = new Set(['parameters', 'formal_parameters']);

/** Punctuation and keywords that are never parameters. */
const NON_PARAMETER_TYPES = new Set([
  '(', ')', ',', ':', '=', '->', 'def', 'function', 'async', '*',
]);

/**
 * Parameter forms that accept an arbitrary number of arguments. Their arity is
 * unknowable from the signature, so they are skipped rather than guessed.
 */
const VARIADIC_TYPES = new Set([
  'list_splat_pattern', // Python *args
  'dictionary_splat_pattern', // Python **kwargs
  'rest_pattern', // TS/JS ...rest
]);

/**
 * Find the CST node declaring a named function.
 *
 * Handles both direct declarations and arrow functions bound to a variable
 * (`const f = (a, b) => ...`), where the name lives on the declarator.
 *
 * @param root - Root of the parsed CST.
 * @param functionName - Function name to locate.
 * @returns The node whose parameter list should be read, or null if not found.
 */
function findFunctionNode(root: CstNode, functionName: string): CstNode | null {
  let found: CstNode | null = null;

  const walk = (node: CstNode): void => {
    if (found) return;

    if (FUNCTION_NODE_TYPES.has(node.type)) {
      const nameNode = node.children.find(
        (c) => c.type === 'identifier' || c.type === 'property_identifier'
      );
      if (nameNode?.text === functionName) {
        found = node;
        return;
      }
    }

    // `const f = (a, b) => {}` / `const f = function (a, b) {}`
    if (node.type === 'variable_declarator') {
      const nameNode = node.children.find((c) => c.type === 'identifier');
      if (nameNode?.text === functionName) {
        const fn = node.children.find(
          (c) => c.type === 'arrow_function' || c.type === 'function_expression' || c.type === 'function'
        );
        if (fn) {
          found = fn;
          return;
        }
      }
    }

    for (const child of node.children) {
      walk(child);
      if (found) return;
    }
  };

  walk(root);
  return found;
}

/** A function's span in its source file, as 1-based inclusive line numbers. */
export interface FunctionRange {
  start_line: number;
  end_line: number;
}

/**
 * Locate the line span of a named function.
 *
 * Used to keep generated patches inside the function being repaired. A plain
 * line-offset window around the defect can wander into a module docstring or a
 * neighbouring function, which yields patches that edit prose.
 *
 * @param root - Root of the parsed CST.
 * @param functionName - Function name to locate.
 * @returns The 1-based inclusive line range, or null when not found.
 */
export function findFunctionRange(root: CstNode, functionName: string): FunctionRange | null {
  const fnNode = findFunctionNode(root, functionName);
  if (!fnNode) return null;

  return {
    start_line: fnNode.start_position.row + 1,
    end_line: fnNode.end_position.row + 1,
  };
}

/**
 * Collect the 1-based line numbers occupied by comments and docstrings.
 *
 * Patch strategies that pick a line by offset need to know which lines are not
 * executable code. Deriving this from the CST is exact, unlike guessing from the
 * text: a docstring line such as `BUG: people == 0 raises ZeroDivisionError`
 * contains `==` and reads like code to any heuristic.
 *
 * Only whole-line constructs are reported. A string used as a value — the
 * `"hello"` in `return "hello"` — leaves its line executable and is not included.
 *
 * @param root - Root of the parsed CST.
 * @returns Sorted, de-duplicated line numbers that hold no executable code.
 */
export function collectNonCodeLines(root: CstNode): number[] {
  const lines = new Set<number>();

  const markSpan = (node: CstNode): void => {
    for (let row = node.start_position.row; row <= node.end_position.row; row++) {
      lines.add(row + 1);
    }
  };

  const walk = (node: CstNode, parentType: string | null): void => {
    if (node.type === 'comment') {
      markSpan(node);
    }

    // A bare string as a statement is a docstring (Python) or a directive.
    const isStatementString =
      (node.type === 'string' || node.type === 'concatenated_string') &&
      parentType === 'expression_statement';
    if (isStatementString) {
      markSpan(node);
    }

    for (const child of node.children) {
      walk(child, node.type);
    }
  };

  walk(root, null);
  return [...lines].sort((a, b) => a - b);
}

/** Normalize annotation text such as `: number` or `-> float` into a bare type. */
function cleanTypeText(text: string | undefined): string {
  if (!text) return 'unknown';
  const cleaned = text.replace(/^\s*(:|->)\s*/, '').trim();
  return cleaned === '' ? 'unknown' : cleaned;
}

/**
 * Read one parameter node into a name/type pair.
 *
 * @param node - A child of the parameter list.
 * @returns The parameter, or null when the node is punctuation or variadic.
 */
function readParameter(node: CstNode): ExtractedParameter | null {
  if (NON_PARAMETER_TYPES.has(node.type) || VARIADIC_TYPES.has(node.type)) {
    return null;
  }

  // A bare identifier: `def f(a)` or JavaScript's untyped `function f(a)`.
  if (node.type === 'identifier') {
    return { name: node.text ?? '', type: 'unknown' };
  }

  // Structured forms: Python typed/default parameters, TS required/optional.
  const nameNode = node.children.find(
    (c) => c.type === 'identifier' || c.type === 'property_identifier'
  );
  if (!nameNode?.text) return null;

  const typeNode = node.children.find((c) => c.type === 'type' || c.type === 'type_annotation');

  return { name: nameNode.text, type: cleanTypeText(typeNode?.text) };
}

/**
 * Extract a function's signature from a parsed CST.
 *
 * @param root - Root of the parsed CST.
 * @param functionName - Name of the function to inspect.
 * @returns The signature, or null when the function or its parameter list is
 *          not found (callers should then leave the specification untouched).
 */
export function extractSignature(
  root: CstNode,
  functionName: string
): ExtractedSignature | null {
  const fnNode = findFunctionNode(root, functionName);
  if (!fnNode) return null;

  const paramList = fnNode.children.find((c) => PARAMETER_LIST_TYPES.has(c.type));
  if (!paramList) return null;

  const parameters: ExtractedParameter[] = [];
  for (const child of paramList.children) {
    const param = readParameter(child);
    if (param && param.name) parameters.push(param);
  }

  // Return annotation: Python's `-> T` and TypeScript's `: T` both surface as a
  // `type`/`type_annotation` child of the function node itself.
  const returnNode = fnNode.children.find(
    (c) => c.type === 'type' || c.type === 'type_annotation'
  );

  return { parameters, return_type: cleanTypeText(returnNode?.text) };
}
