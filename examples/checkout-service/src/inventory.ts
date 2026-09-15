/**
 * Inventory calculations.
 *
 * Originally shipped with an intentional bug Buggy proved (see WORKFLOW.md);
 * the guard below is the applied fix.
 */

/** How many days the current stock will last at a daily usage rate. */
export function stockCoverageDays(stock: number, dailyUsage: number): number {
  // No usage means stock never depletes; return 0 ("n/a") instead of Infinity.
  if (dailyUsage <= 0) return 0;
  return stock / dailyUsage;
}

/** Units to reorder to reach a target stock level. */
export function reorderQuantity(target: number, current: number): number {
  // Clean: clamped at 0.
  return Math.max(0, target - current);
}
