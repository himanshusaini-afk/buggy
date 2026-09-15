/**
 * Checkout pricing calculations.
 *
 * These functions originally shipped with intentional bugs that Buggy proved
 * (see WORKFLOW.md); the guards below are the applied fixes. Re-running Buggy
 * now reports them clean.
 */

/** Apply a percentage discount to a price. */
export function applyDiscount(price: number, percentOff: number): number {
  // Clamp the discount to [0, 100] so the price can never go negative.
  const pct = Math.max(0, Math.min(100, percentOff));
  return price - price * (pct / 100);
}

/** Price per unit for a bulk line item. */
export function pricePerUnit(total: number, quantity: number): number {
  // Guard division by zero (would produce Infinity/NaN).
  if (quantity === 0) return 0;
  return total / quantity;
}

/** Average value across a set of orders. */
export function averageOrderValue(orders: number[]): number {
  // Empty order set has no average — return 0 instead of 0 / 0 = NaN.
  if (orders.length === 0) return 0;
  const sum = orders.reduce((a, b) => a + b, 0);
  return sum / orders.length;
}

/** Tax owed on a subtotal at a given rate (0..1). */
export function taxAmount(subtotal: number, rate: number): number {
  // Clean: no division, no unbounded growth.
  return subtotal * rate;
}
