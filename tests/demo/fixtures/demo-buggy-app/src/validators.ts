/**
 * Validates cart items before processing.
 * 
 * BUG: Doesn't validate price > 0, allows negative prices
 */
export function validateCartItem(item: { price: number; quantity: number; name: string }): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!item.name || item.name.trim().length === 0) {
    errors.push('Name is required');
  }
  
  // BUG: Missing check for price > 0
  // This allows negative prices which corrupt calculations
  
  if (item.quantity <= 0) {
    errors.push('Quantity must be positive');
  }
  
  if (item.quantity !== Math.floor(item.quantity)) {
    errors.push('Quantity must be an integer');
  }
  
  return { valid: errors.length === 0, errors };
}

/**
 * BUG: Coupon validation has timing issue.
 * Checks expiry against current time but truncates to date only,
 * meaning coupons "expire" at midnight UTC regardless of timezone.
 */
export function isCouponValid(couponExpiry: Date): boolean {
  const now = new Date();
  const expiryDate = new Date(couponExpiry.toISOString().split('T')[0]); // BUG: truncates time
  return now <= expiryDate;
}
