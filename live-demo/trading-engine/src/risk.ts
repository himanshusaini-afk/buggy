/**
 * Trading Engine — Risk Management
 */

/** Calculate position sizing based on Kelly Criterion */
export function kellyFraction(winRate: number, avgWin: number, avgLoss: number): number {
  // BUG: No validation that winRate is 0-1
  // BUG: avgLoss should be positive (magnitude) but if negative, formula breaks
  const b = avgWin / avgLoss; // BUG: Division by zero if avgLoss = 0
  return (winRate * b - (1 - winRate)) / b;
}

/** Calculate maximum drawdown from a series of portfolio values */
export function maxDrawdown(values: number[]): number {
  let maxDD = 0;
  let peak = values[0]; // BUG: undefined for empty array

  for (let i = 1; i < values.length; i++) {
    if (values[i] > peak) {
      peak = values[i];
    }
    const drawdown = (peak - values[i]) / peak; // BUG: Division by zero if peak = 0
    if (drawdown > maxDD) {
      maxDD = drawdown;
    }
  }

  return maxDD;
}

/** Calculate annualized return from daily returns */
export function annualizedReturn(dailyReturns: number[]): number {
  const totalReturn = dailyReturns.reduce((prod, r) => prod * (1 + r), 1);
  // BUG: If any dailyReturn is -1 (total loss), totalReturn becomes 0
  // Then Math.pow(0, 252/N) = 0, and result is -1. Edge case not handled.
  const days = dailyReturns.length;
  return Math.pow(totalReturn, 252 / days) - 1; // BUG: days=0 → division by zero in exponent → NaN
}

/** Calculate Sortino Ratio (downside risk only) */
export function sortinoRatio(returns: number[], targetReturn: number): number {
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length; // BUG: NaN for empty
  const downsideReturns = returns.filter(r => r < targetReturn);
  const downsideDeviation = Math.sqrt(
    downsideReturns.reduce((sum, r) => sum + (r - targetReturn) ** 2, 0) / downsideReturns.length
  ); // BUG: NaN if no downside returns (division by zero in downsideReturns.length)
  return (avgReturn - targetReturn) / downsideDeviation; // BUG: NaN/Infinity
}

/** Calculate correlation between two return series */
export function returnCorrelation(a: number[], b: number[]): number {
  // BUG: No length check
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;

  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - meanA) * (b[i] - meanB); // BUG: b[i] undefined if shorter
    varA += (a[i] - meanA) ** 2;
    varB += (b[i] - meanB) ** 2;
  }

  return cov / Math.sqrt(varA * varB); // BUG: Division by zero if variance is 0
}
