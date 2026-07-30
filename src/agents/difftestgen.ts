/**
 * DiffTestGen - Differential Test Analysis
 *
 * Generates test inputs to detect behavioral differences between multiple
 * implementations of the same interface. Classifies differences by severity:
 * - specification-violating: the difference violates a verified specification assertion
 * - unspecified-behavior: the difference is in behavior not covered by any specification
 *
 * Reports are sorted with specification-violating differences before unspecified-behavior.
 * If the test generation budget is exhausted without finding any differences,
 * reports "behaviorally equivalent".
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4
 */

import { randomUUID } from 'node:crypto';
import type { SourceLocation } from '../types/graph.js';

/**
 * Represents a single implementation to be compared.
 */
export interface Implementation {
  id: string;
  name: string;
  /** The interface methods exposed by this implementation. */
  methods: InterfaceMethod[];
  /**
   * Execute a method with the given input and return the output.
   * Throws on execution failure.
   */
  execute: (methodName: string, input: unknown) => Promise<unknown>;
  /** Source location of the implementation for reporting. */
  source_location: SourceLocation;
}

/**
 * Describes an interface method that can be tested.
 */
export interface InterfaceMethod {
  name: string;
  /** Parameter types or schema for input generation. */
  parameter_types: string[];
  /** Return type or schema for output comparison. */
  return_type: string;
}

/**
 * A verified specification assertion that can be checked against outputs.
 */
export interface SpecificationAssertion {
  id: string;
  method_name: string;
  expression: string;
  /** Evaluate the assertion against a given input/output pair. Returns true if satisfied. */
  evaluate: (input: unknown, output: unknown) => boolean;
}

/**
 * Severity classification of a behavioral difference.
 */
export type DifferenceSeverity = 'specification-violating' | 'unspecified-behavior';

/**
 * A single detected behavioral difference between implementations.
 */
export interface BehavioralDifference {
  id: string;
  /** The method on which the difference was detected. */
  method_name: string;
  /** The input that triggered the difference. */
  triggering_input: unknown;
  /** Outputs from each implementation, keyed by implementation ID. */
  outputs: Record<string, unknown>;
  /** Code locations responsible in each implementation, keyed by implementation ID. */
  code_locations: Record<string, SourceLocation>;
  /** Severity classification. */
  severity: DifferenceSeverity;
  /** If specification-violating, which assertion was violated. */
  violated_assertion_id?: string;
}

/**
 * The result of running DiffTestGen analysis.
 */
export interface DiffTestResult {
  /** Overall status of the analysis. */
  status: 'differences_found' | 'behaviorally_equivalent';
  /** Detected differences, sorted by severity (specification-violating first). */
  differences: BehavioralDifference[];
  /** Total number of test inputs generated. */
  inputs_generated: number;
  /** Number of methods analyzed. */
  methods_analyzed: number;
  /** Processing time in milliseconds. */
  processing_time_ms: number;
}

/**
 * Configuration for the DiffTestGen analysis.
 */
export interface DiffTestGenConfig {
  /** Minimum test inputs to generate per interface method. Must be ≥100. */
  inputs_per_method: number;
  /** Maximum total test inputs to try before declaring equivalence. */
  max_budget: number;
  /** Verified specification assertions to check against. */
  specifications: SpecificationAssertion[];
  /** Custom input generator (optional). If not provided, uses default random generation. */
  input_generator?: InputGenerator;
}

/**
 * Generates test inputs for a given method signature.
 */
export interface InputGenerator {
  generate(method: InterfaceMethod, count: number): unknown[];
}

/**
 * Default input generator using random value generation based on parameter types.
 */
class DefaultInputGenerator implements InputGenerator {
  generate(method: InterfaceMethod, count: number): unknown[] {
    const inputs: unknown[] = [];
    for (let i = 0; i < count; i++) {
      if (method.parameter_types.length === 0) {
        inputs.push(undefined);
      } else if (method.parameter_types.length === 1) {
        inputs.push(this.generateValue(method.parameter_types[0], i));
      } else {
        inputs.push(
          method.parameter_types.map((type, paramIdx) =>
            this.generateValue(type, i * method.parameter_types.length + paramIdx)
          )
        );
      }
    }
    return inputs;
  }

  private generateValue(type: string, seed: number): unknown {
    switch (type.toLowerCase()) {
      case 'number':
      case 'int':
      case 'integer':
        return this.generateNumber(seed);
      case 'string':
        return this.generateString(seed);
      case 'boolean':
      case 'bool':
        return seed % 2 === 0;
      case 'array':
      case 'number[]':
        return this.generateNumberArray(seed);
      case 'string[]':
        return this.generateStringArray(seed);
      case 'object':
        return this.generateObject(seed);
      case 'null':
        return null;
      case 'undefined':
        return undefined;
      default:
        return this.generateMixed(seed);
    }
  }

  private generateNumber(seed: number): number {
    // Generate a variety of numbers including edge cases
    const strategies = [
      () => 0,
      () => 1,
      () => -1,
      () => Number.MAX_SAFE_INTEGER,
      () => Number.MIN_SAFE_INTEGER,
      () => Math.floor(Math.random() * 1000) - 500,
      () => Math.random() * 1000 - 500,
      () => NaN,
      () => Infinity,
      () => -Infinity,
    ];
    return strategies[seed % strategies.length]() as number;
  }

  private generateString(seed: number): string {
    const strategies = [
      () => '',
      () => 'a',
      () => 'hello world',
      () => ' ',
      () => '\n\t',
      () => 'a'.repeat(1000),
      () => String.fromCharCode(0),
      () => `test_${seed}`,
      () => '🎉',
      () => '<script>alert(1)</script>',
    ];
    return strategies[seed % strategies.length]();
  }

  private generateNumberArray(seed: number): number[] {
    const length = seed % 20;
    return Array.from({ length }, (_, i) => (seed + i) * 7 % 100 - 50);
  }

  private generateStringArray(seed: number): string[] {
    const length = seed % 10;
    return Array.from({ length }, (_, i) => `item_${i}_${seed}`);
  }

  private generateObject(seed: number): Record<string, unknown> {
    const keys = ['a', 'b', 'c', 'value', 'data', 'nested'];
    const obj: Record<string, unknown> = {};
    const keyCount = (seed % 4) + 1;
    for (let i = 0; i < keyCount; i++) {
      obj[keys[i % keys.length]] = this.generateNumber(seed + i);
    }
    return obj;
  }

  private generateMixed(seed: number): unknown {
    const types = ['number', 'string', 'boolean', 'null', 'undefined', 'array'];
    return this.generateValue(types[seed % types.length], seed);
  }
}

/**
 * DiffTestGen differential test analysis engine.
 *
 * Generates test inputs to exercise behavioral differences between multiple
 * implementations of the same interface. Classifies and prioritizes differences
 * by severity relative to verified specification assertions.
 */
export class DiffTestGen {
  private config: DiffTestGenConfig;
  private inputGenerator: InputGenerator;

  constructor(config?: Partial<DiffTestGenConfig>) {
    this.config = {
      inputs_per_method: Math.max(100, config?.inputs_per_method ?? 100),
      max_budget: config?.max_budget ?? 10000,
      specifications: config?.specifications ?? [],
      input_generator: config?.input_generator,
    };
    this.inputGenerator = this.config.input_generator ?? new DefaultInputGenerator();
  }

  /**
   * Run differential test analysis across multiple implementations.
   *
   * Generates ≥100 test inputs per interface method, executes them against all
   * implementations, and flags behavioral differences with severity classification.
   *
   * Results are sorted: specification-violating differences before unspecified-behavior.
   * Reports "behaviorally equivalent" if no differences found within budget.
   *
   * @param implementations - Two or more implementations to compare
   * @returns DiffTestResult with differences sorted by severity
   */
  async runDiffTestGen(implementations: Implementation[]): Promise<DiffTestResult> {
    const startTime = performance.now();

    if (implementations.length < 2) {
      return {
        status: 'behaviorally_equivalent',
        differences: [],
        inputs_generated: 0,
        methods_analyzed: 0,
        processing_time_ms: performance.now() - startTime,
      };
    }

    const differences: BehavioralDifference[] = [];
    let totalInputsGenerated = 0;
    let methodsAnalyzed = 0;

    // Determine the common interface methods across all implementations
    const commonMethods = this.findCommonMethods(implementations);

    for (const method of commonMethods) {
      methodsAnalyzed++;

      // Generate at least inputs_per_method test inputs for this method
      const testInputs = this.inputGenerator.generate(method, this.config.inputs_per_method);
      totalInputsGenerated += testInputs.length;

      // Execute each test input against all implementations
      for (const input of testInputs) {
        if (totalInputsGenerated > this.config.max_budget) {
          break;
        }

        const methodDiffs = await this.executeAndCompare(
          implementations,
          method.name,
          input
        );

        differences.push(...methodDiffs);
      }

      if (totalInputsGenerated > this.config.max_budget) {
        break;
      }
    }

    // Sort differences: specification-violating before unspecified-behavior
    const sortedDifferences = this.prioritizeDifferences(differences);

    const processingTime = performance.now() - startTime;

    return {
      status: sortedDifferences.length > 0 ? 'differences_found' : 'behaviorally_equivalent',
      differences: sortedDifferences,
      inputs_generated: totalInputsGenerated,
      methods_analyzed: methodsAnalyzed,
      processing_time_ms: processingTime,
    };
  }

  /**
   * Find methods common to all implementations.
   */
  private findCommonMethods(implementations: Implementation[]): InterfaceMethod[] {
    if (implementations.length === 0) return [];

    const firstMethods = implementations[0].methods;
    return firstMethods.filter((method) =>
      implementations.every((impl) =>
        impl.methods.some((m) => m.name === method.name)
      )
    );
  }

  /**
   * Execute a single input against all implementations and compare outputs.
   * Returns any detected behavioral differences.
   */
  private async executeAndCompare(
    implementations: Implementation[],
    methodName: string,
    input: unknown
  ): Promise<BehavioralDifference[]> {
    const differences: BehavioralDifference[] = [];

    // Execute against all implementations and collect results
    const results: Array<{ implId: string; output: unknown; error?: string }> = [];

    for (const impl of implementations) {
      try {
        const output = await impl.execute(methodName, input);
        results.push({ implId: impl.id, output });
      } catch (err) {
        results.push({
          implId: impl.id,
          output: undefined,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Compare all pairs for differences
    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        const resultA = results[i];
        const resultB = results[j];

        if (!this.outputsAreEqual(resultA.output, resultB.output) ||
          (resultA.error !== undefined) !== (resultB.error !== undefined)) {
          // Determine severity
          const severity = this.classifySeverity(methodName, input, resultA.output, resultB.output);

          const outputs: Record<string, unknown> = {};
          outputs[resultA.implId] = resultA.error !== undefined
            ? { error: resultA.error }
            : resultA.output;
          outputs[resultB.implId] = resultB.error !== undefined
            ? { error: resultB.error }
            : resultB.output;

          const codeLocations: Record<string, SourceLocation> = {};
          const implA = implementations.find((im) => im.id === resultA.implId)!;
          const implB = implementations.find((im) => im.id === resultB.implId)!;
          codeLocations[resultA.implId] = implA.source_location;
          codeLocations[resultB.implId] = implB.source_location;

          const diff: BehavioralDifference = {
            id: randomUUID(),
            method_name: methodName,
            triggering_input: input,
            outputs,
            code_locations: codeLocations,
            severity,
          };

          // If specification-violating, record which assertion was violated
          if (severity === 'specification-violating') {
            const violatedAssertion = this.findViolatedAssertion(methodName, input, resultA.output, resultB.output);
            if (violatedAssertion) {
              diff.violated_assertion_id = violatedAssertion.id;
            }
          }

          differences.push(diff);
        }
      }
    }

    return differences;
  }

  /**
   * Classify the severity of a behavioral difference.
   *
   * A difference is "specification-violating" if either output violates a
   * verified specification assertion for the method. Otherwise, it is
   * "unspecified-behavior".
   */
  private classifySeverity(
    methodName: string,
    input: unknown,
    outputA: unknown,
    outputB: unknown
  ): DifferenceSeverity {
    const relevantSpecs = this.config.specifications.filter(
      (spec) => spec.method_name === methodName
    );

    for (const spec of relevantSpecs) {
      try {
        const satisfiedA = spec.evaluate(input, outputA);
        const satisfiedB = spec.evaluate(input, outputB);

        // If either output violates the specification, this is specification-violating
        if (!satisfiedA || !satisfiedB) {
          return 'specification-violating';
        }
      } catch {
        // If evaluation throws, treat as potential violation
        return 'specification-violating';
      }
    }

    return 'unspecified-behavior';
  }

  /**
   * Find the specific specification assertion that was violated.
   */
  private findViolatedAssertion(
    methodName: string,
    input: unknown,
    outputA: unknown,
    outputB: unknown
  ): SpecificationAssertion | undefined {
    const relevantSpecs = this.config.specifications.filter(
      (spec) => spec.method_name === methodName
    );

    for (const spec of relevantSpecs) {
      try {
        const satisfiedA = spec.evaluate(input, outputA);
        const satisfiedB = spec.evaluate(input, outputB);

        if (!satisfiedA || !satisfiedB) {
          return spec;
        }
      } catch {
        return spec;
      }
    }

    return undefined;
  }

  /**
   * Sort differences with specification-violating before unspecified-behavior.
   */
  prioritizeDifferences(differences: BehavioralDifference[]): BehavioralDifference[] {
    return [...differences].sort((a, b) => {
      if (a.severity === b.severity) return 0;
      if (a.severity === 'specification-violating') return -1;
      return 1;
    });
  }

  /**
   * Deep equality check for outputs.
   */
  private outputsAreEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;

    // Handle NaN
    if (typeof a === 'number' && typeof b === 'number' && isNaN(a) && isNaN(b)) {
      return true;
    }

    if (a === null || b === null) return a === b;
    if (a === undefined || b === undefined) return a === b;

    if (typeof a !== typeof b) return false;

    if (typeof a === 'object' && typeof b === 'object') {
      return JSON.stringify(a) === JSON.stringify(b);
    }

    return a === b;
  }
}

/**
 * Convenience function to run DiffTestGen differential test analysis.
 *
 * Creates a DiffTestGen instance with the provided configuration and
 * runs the analysis on the given implementations.
 *
 * @param implementations - Two or more implementations to compare
 * @param config - Optional configuration for the analysis
 * @returns DiffTestResult with differences sorted by severity
 */
export async function runDiffTestGen(
  implementations: Implementation[],
  config?: Partial<DiffTestGenConfig>
): Promise<DiffTestResult> {
  const engine = new DiffTestGen(config);
  return engine.runDiffTestGen(implementations);
}
