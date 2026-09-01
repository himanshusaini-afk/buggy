/**
 * Trading Engine — Pricing & Valuation
 * Contains subtle numerical bugs typical in financial software
 */

/** Calculate Black-Scholes option price (simplified) */
export function blackScholes(
  S: number,    // Current stock price
  K: number,    // Strike price
  T: number,    // Time to expiration (years)
  r: number,    // Risk-free rate
  sigma: number // Volatility
): number {
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  // BUG: No check for T=0 (division by zero), S<=0, K<=0, sigma<=0
  return S * normalCDF(d1) - K * Math.exp(-r * T) * normalCDF(d2);
}

/** Cumulative normal distribution approximation */
export function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + p * absX);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);
  // BUG: Should divide by sqrt(2*PI) but doesn't — result > 1 for large x
  return (1 + sign * y) / 2;
}

/** Calculate Value at Risk (parametric) */
export function valueAtRisk(
  portfolioValue: number,
  volatility: number,
  confidenceLevel: number, // e.g., 0.95 or 0.99
  holdingPeriod: number    // days
): number {
  const zScore = normalCDFInverse(confidenceLevel);
  // BUG: No validation that confidenceLevel is between 0 and 1
  // BUG: holdingPeriod=0 causes sqrt(0) * ... = 0 (misleading, not an error per se)
  return portfolioValue * volatility * zScore * Math.sqrt(holdingPeriod / 252);
}

/** Inverse normal CDF (Beasley-Springer-Moro approximation) */
export function normalCDFInverse(p: number): number {
  // BUG: No check for p <= 0 or p >= 1 (returns NaN/Infinity)
  if (p <= 0 || p >= 1) return NaN; // Actually this IS guarded — but tests with p=0 or p=1 exact will fail
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];

  const pLow = 0.02425, pHigh = 1 - pLow;
  let q: number, r: number;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((a[0]*q+a[1])*q+a[2])*q+a[3])*q+a[4])*q+a[5]) /
           ((((b[0]*q+b[1])*q+b[2])*q+b[3])*q+b[4]*q+1); // BUG: b[4]*q should be b[4])*q — misplaced paren
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q /
           ((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4]*r+1); // Same parenthesis bug
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((a[0]*q+a[1])*q+a[2])*q+a[3])*q+a[4])*q+a[5]) /
            ((((b[0]*q+b[1])*q+b[2])*q+b[3])*q+b[4]*q+1); // Same bug
  }
}

/** Calculate Sharpe Ratio */
export function sharpeRatio(returns: number[], riskFreeRate: number): number {
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const excessReturn = avgReturn - riskFreeRate;
  const stdDev = Math.sqrt(
    returns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / returns.length
  );
  // BUG: Division by zero when all returns are identical (stdDev = 0)
  // BUG: uses population std dev (n) instead of sample std dev (n-1)
  return excessReturn / stdDev;
}

/** Calculate portfolio beta */
export function portfolioBeta(
  assetBetas: number[],
  weights: number[]
): number {
  // BUG: No check that weights sum to 1.0
  // BUG: No check that arrays have same length
  let beta = 0;
  for (let i = 0; i < assetBetas.length; i++) {
    beta += assetBetas[i] * weights[i]; // BUG: weights[i] undefined if shorter
  }
  return beta;
}
