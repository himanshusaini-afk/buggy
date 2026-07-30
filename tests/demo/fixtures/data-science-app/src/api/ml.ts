/**
 * ML Utility Functions
 *
 * BUG 6: sigmoid() no NaN check on input
 * BUG 7: softmax() not numerically stable (exp overflow)
 * BUG 8: cosineSimilarity() no length check, division by zero for zero vectors
 * BUG 9: confusionMatrix() no bounds check on class indices
 */

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x)); // BUG: No NaN check on input — sigmoid(NaN) = NaN
}

export function softmax(values: number[]): number[] {
  // BUG: Not numerically stable — exp(large number) = Infinity
  const exps = values.map(v => Math.exp(v)); // Overflows for values > 709
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum); // Results in NaN when sum is Infinity
}

export function cosineSimilarity(a: number[], b: number[]): number {
  // BUG: No length check
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]; // BUG: b[i] undefined if b is shorter
    normA += a[i] ** 2;
    normB += b[i] ** 2; // Same bug
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB)); // BUG: Division by zero if either vector is all zeros
}

export function euclideanDistance(a: number[], b: number[]): number {
  // BUG: No length validation
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] - b[i]) ** 2; // BUG: b[i] undefined if shorter
  }
  return Math.sqrt(sum);
}

export function confusionMatrix(actual: number[], predicted: number[], numClasses: number): number[][] {
  const matrix = Array.from({ length: numClasses }, () => Array(numClasses).fill(0));

  for (let i = 0; i < actual.length; i++) {
    // BUG: No bounds check — actual[i] or predicted[i] could be >= numClasses
    matrix[actual[i]][predicted[i]]++;
  }

  return matrix;
}

export function accuracy(actual: number[], predicted: number[]): number {
  // BUG: No length validation
  let correct = 0;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] === predicted[i]) correct++;
  }
  return correct / actual.length; // BUG: Division by zero for empty arrays
}

export function precision(tp: number, fp: number): number {
  return tp / (tp + fp); // BUG: Division by zero when tp + fp = 0
}

export function recall(tp: number, fn: number): number {
  return tp / (tp + fn); // BUG: Division by zero when tp + fn = 0
}

export function f1Score(precisionVal: number, recallVal: number): number {
  return 2 * (precisionVal * recallVal) / (precisionVal + recallVal); // BUG: Division by zero when both are 0
}
