/**
 * Expense Tracker — Date utilities
 */

/** Get expenses from the last N days */
export function filterLastNDays(
  expenses: { date: string; amount: number }[],
  days: number
): { date: string; amount: number }[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return expenses.filter(e => new Date(e.date).getTime() >= cutoff);
}

/** Group expenses by month (YYYY-MM format) */
export function groupByMonth(
  expenses: { date: string; amount: number }[]
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const e of expenses) {
    const month = e.date.slice(0, 7); // "YYYY-MM"
    result[month] = (result[month] || 0) + e.amount;
  }
  return result;
}

/** Calculate days between two dates */
export function daysBetween(start: string, end: string): number {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  return (endMs - startMs) / (1000 * 60 * 60 * 24);
}

/** Get daily spending rate */
export function dailyRate(totalSpent: number, days: number): number {
  return totalSpent / days;
}

/** Forecast future spending based on current rate */
export function forecastSpending(dailyRate: number, remainingDays: number): number {
  return dailyRate * remainingDays;
}
