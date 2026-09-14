/**
 * Checkout pricing calculations.
 *
 * NOTE: This file contains intentional bugs so Buggy has something to prove.
 * See WORKFLOW.md for the run and the fixes.
 */

/** Apply a percentage discount to a price. */
export function applyDiscount(price: number, percentOff: number): number {
  // BUG: percentOff > 100 produces a NEGATIVE price (no clamp on the discount).
  return price - price * (percentOff / 100);
}

/** Price per unit for a bulk line item. */
export function pricePerUnit(total: number, quantity: number): number {
  // BUG: quantity === 0 -> Infinity; total & quantity both 0 -> NaN.
  return total / quantity;
}

/** Average value across a set of orders. */
export function averageOrderValue(orders: number[]): number {
  const sum = orders.reduce((a, b) => a + b, 0);
  // BUG: empty orders -> 0 / 0 = NaN.
  return sum / orders.length;
}

/** Tax owed on a subtotal at a given rate (0..1). */
export function taxAmount(subtotal: number, rate: number): number {
  // Clean: no division, no unbounded growth.
  return subtotal * rate;
}
