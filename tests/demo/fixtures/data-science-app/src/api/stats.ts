/**
 * Statistical Functions for Data Analysis API
 *
 * Contains intentional bugs for Buggy demo:
 * BUG 1: mean() doesn't handle empty arrays (NaN)
 * BUG 2: standardDeviation() has off-by-one (divides by n instead of n-1 for sample)
 * BUG 3: percentile() doesn't sort the array first
 * BUG 4: normalize() can divide by zero when all values are the same
 * BUG 5: correlation() doesn't validate array lengths match
 */

export function mean(values: number[]): number {
  const sum = values.reduce((a, b) => a + b, 0);
  return sum / values.length; // BUG: Division by zero for empty array
}

export function standardDeviation(values: number[]): number {
  const avg = mean(values);
  const squaredDiffs = values.map(v => Math.pow(v - avg, 2));
  const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length; // BUG: Should be (n-1) for sample std dev
  return Math.sqrt(avgSquaredDiff);
}

export function percentile(values: number[], p: number): number {
  // BUG: Doesn't sort the array — assumes already sorted
  const index = Math.ceil((p / 100) * values.length) - 1;
  return values[index]; // Also: no bounds check on index
}

export function normalize(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min; // BUG: range = 0 when all values are identical → division by zero
  return values.map(v => (v - min) / range);
}

export function correlation(x: number[], y: number[]): number {
  // BUG: No check that x.length === y.length
  const n = x.length;
  const meanX = mean(x);
  const meanY = mean(y);

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY; // BUG: y[i] can be undefined if y is shorter
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  return numerator / Math.sqrt(denomX * denomY); // BUG: Can return NaN if denom is 0
}

export function linearRegression(x: number[], y: number[]): { slope: number; intercept: number; rSquared: number } {
  const n = x.length;
  const meanX = mean(x);
  const meanY = mean(y);

  let ssXY = 0;
  let ssXX = 0;
  let ssYY = 0;

  for (let i = 0; i < n; i++) {
    ssXY += (x[i] - meanX) * (y[i] - meanY);
    ssXX += (x[i] - meanX) ** 2;
    ssYY += (y[i] - meanY) ** 2;
  }

  const slope = ssXY / ssXX; // BUG: Division by zero if all x values are the same
  const intercept = meanY - slope * meanX;
  const rSquared = (ssXY ** 2) / (ssXX * ssYY); // Can be NaN

  return { slope, intercept, rSquared };
}
