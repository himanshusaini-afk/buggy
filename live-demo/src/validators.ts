/**
 * Expense Tracker — Input validation
 */

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate an expense entry */
export function validateExpense(expense: {
  amount: unknown;
  category: unknown;
  date: unknown;
}): ValidationResult {
  const errors: string[] = [];

  if (typeof expense.amount !== 'number' || expense.amount <= 0) {
    errors.push('Amount must be a positive number');
  }

  if (typeof expense.category !== 'string' || expense.category.trim().length === 0) {
    errors.push('Category is required');
  }

  if (typeof expense.date !== 'string' || isNaN(Date.parse(expense.date))) {
    errors.push('Date must be a valid date string');
  }

  return { valid: errors.length === 0, errors };
}

/** Validate budget input */
export function validateBudget(budget: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof budget !== 'number') {
    errors.push('Budget must be a number');
  } else if (budget < 0) {
    errors.push('Budget cannot be negative');
  }

  return { valid: errors.length === 0, errors };
}

/** Validate category name */
export function validateCategory(name: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof name !== 'string') {
    errors.push('Category name must be a string');
  } else if (name.trim().length === 0) {
    errors.push('Category name cannot be empty');
  } else if (name.length > 50) {
    errors.push('Category name too long (max 50 chars)');
  }

  return { valid: errors.length === 0, errors };
}
