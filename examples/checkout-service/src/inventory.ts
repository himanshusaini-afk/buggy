/**
 * Inventory calculations.
 *
 * NOTE: Contains an intentional bug (see WORKFLOW.md).
 */

/** How many days the current stock will last at a daily usage rate. */
export function stockCoverageDays(stock: number, dailyUsage: number): number {
  // BUG: dailyUsage === 0 -> Infinity (stock "lasts forever").
  return stock / dailyUsage;
}

/** Units to reorder to reach a target stock level. */
export function reorderQuantity(target: number, current: number): number {
  // Clean: clamped at 0.
  return Math.max(0, target - current);
}
