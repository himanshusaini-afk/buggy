/**
 * Shopping Cart Module
 * 
 * Invariants:
 * - Total should always be >= 0
 * - Quantity of each item should be > 0
 * - Discount should never exceed the subtotal
 * - Tax calculation should be correct (subtotal * taxRate)
 */

export interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

export interface CartSummary {
  items: CartItem[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
}

/**
 * BUG 1: Off-by-one in quantity calculation.
 * When quantity > 10, applies bulk discount BEFORE calculating subtotal,
 * which can cause negative subtotals for cheap items.
 */
export function calculateSubtotal(items: CartItem[]): number {
  let subtotal = 0;
  for (const item of items) {
    if (item.quantity > 10) {
      // BUG: Subtracts a "bulk discount" of 2 per item, but doesn't check if price > 2
      subtotal += (item.price - 2) * item.quantity;
    } else {
      subtotal += item.price * item.quantity;
    }
  }
  return subtotal;
}

/**
 * BUG 2: Division by zero when cart is empty.
 * Calculates average price but doesn't handle empty cart.
 */
export function calculateAveragePrice(items: CartItem[]): number {
  const total = items.reduce((sum, item) => sum + item.price, 0);
  return total / items.length; // BUG: Division by zero when items is empty
}

/**
 * BUG 3: Integer overflow with large quantities.
 * Doesn't validate that quantity * price fits in a safe integer.
 */
export function calculateItemTotal(price: number, quantity: number): number {
  return price * quantity; // BUG: No overflow check for Number.MAX_SAFE_INTEGER
}

/**
 * BUG 4: Discount can exceed subtotal, producing negative total.
 */
export function applyDiscount(subtotal: number, discountPercent: number): number {
  // BUG: No clamping — discountPercent > 100 produces negative result
  return subtotal - (subtotal * discountPercent / 100);
}

/**
 * BUG 5: Non-deterministic behavior — uses Math.random for "loyalty points"
 */
export function calculateLoyaltyPoints(total: number): number {
  // BUG: Non-deterministic — different results each call
  const bonus = Math.random() > 0.5 ? 10 : 0;
  return Math.floor(total / 10) + bonus;
}

/**
 * BUG 6: Timeout risk — recursive calculation with no memoization
 * For items with related items, recursively calculates related totals.
 */
export function calculateRelatedTotal(
  items: CartItem[],
  relatedMap: Map<string, string[]>,
  visited: Set<string> = new Set()
): number {
  let total = 0;
  for (const item of items) {
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    total += item.price * item.quantity;
    
    const relatedIds = relatedMap.get(item.id) ?? [];
    // BUG: If relatedMap has cycles (A→B→A), this infinite loops
    // because visited set is not shared correctly across recursive calls
    const relatedItems = items.filter(i => relatedIds.includes(i.id));
    total += calculateRelatedTotal(relatedItems, relatedMap, new Set()); // BUG: new Set() instead of passing visited
  }
  return total;
}
